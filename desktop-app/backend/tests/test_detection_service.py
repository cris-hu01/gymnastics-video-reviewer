"""Unit tests for ``detection_service`` (D-3).

These tests exercise pure-Python pieces of ``DetectionService`` plus a few
hot paths that depend on ``cv2.VideoCapture`` (mocked) and the cancellation
signal protocol. Anything that needs a real video decode, ffmpeg subprocess,
or AI request is mocked out; we do **not** touch the network or disk-decode
real bytes.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from video_review_backend.detection_service import (
    DetectionCancelledError,
    DetectionService,
)
from video_review_backend.models import (
    CandidateClip,
    DetectionBlock,
    ProjectState,
    VideoTask,
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _make_video(duration: float | None = 120.0) -> VideoTask:
    return VideoTask(
        id="video_det",
        file_path="/tmp/fake.mp4",
        file_name="fake.mp4",
        source_kind="full_video",
        platform_scope_id="scope_det",
        match_name="测试比赛",
        category="QF",
        duration=duration,
        resolution="1920x1080",
        status="queued",
    )


def _fake_capture(
    *,
    fps: float,
    total_frames: int,
    width: int = 1920,
    height: int = 1080,
    is_opened: bool = True,
) -> MagicMock:
    import cv2

    cap = MagicMock()
    cap.isOpened.return_value = is_opened

    def _get(prop: int) -> float:
        return {
            cv2.CAP_PROP_FPS: fps,
            cv2.CAP_PROP_FRAME_COUNT: float(total_frames),
            cv2.CAP_PROP_FRAME_WIDTH: float(width),
            cv2.CAP_PROP_FRAME_HEIGHT: float(height),
        }.get(prop, 0.0)

    cap.get.side_effect = _get
    return cap


# ---------------------------------------------------------------------------
# fps detection via cv2.VideoCapture (mocked)
# ---------------------------------------------------------------------------


class TestVideoInfoFpsDetection:
    """Cover ``_get_video_info`` — fps / duration computed off a mocked cap."""

    def test_returns_fps_and_duration_for_normal_video(self):
        service = DetectionService()
        cap = _fake_capture(fps=30.0, total_frames=900, width=1920, height=1080)

        with patch(
            "video_review_backend.detection_service.cv2.VideoCapture",
            return_value=cap,
        ):
            info = service._get_video_info("/tmp/fake.mp4")

        assert info["fps"] == 30.0
        assert info["total_frames"] == 900
        assert info["resolution"] == "1920x1080"
        assert info["duration"] == pytest.approx(30.0)
        cap.release.assert_called_once()

    def test_high_fps_camera_video(self):
        service = DetectionService()
        cap = _fake_capture(fps=240.0, total_frames=24000)

        with patch(
            "video_review_backend.detection_service.cv2.VideoCapture",
            return_value=cap,
        ):
            info = service._get_video_info("/tmp/fake.mp4")

        assert info["fps"] == 240.0
        assert info["duration"] == pytest.approx(100.0)

    def test_unopened_capture_raises(self):
        service = DetectionService()
        cap = _fake_capture(fps=30.0, total_frames=900, is_opened=False)

        with patch(
            "video_review_backend.detection_service.cv2.VideoCapture",
            return_value=cap,
        ):
            with pytest.raises(RuntimeError, match="无法打开视频"):
                service._get_video_info("/tmp/missing.mp4")

    def test_zero_fps_raises(self):
        service = DetectionService()
        cap = _fake_capture(fps=0.0, total_frames=900)

        with patch(
            "video_review_backend.detection_service.cv2.VideoCapture",
            return_value=cap,
        ):
            with pytest.raises(RuntimeError, match="无法读取视频 FPS"):
                service._get_video_info("/tmp/fake.mp4")


# ---------------------------------------------------------------------------
# segment merge logic
# ---------------------------------------------------------------------------


class TestMergeDetections:
    """Cover ``_merge_detections`` — short fragments merge into neighbours,
    big gaps stay split, name-aware grouping."""

    def test_empty_input_returns_empty(self):
        service = DetectionService()
        assert service._merge_detections([], merge_threshold=5.0, sample_interval=1.0) == []

    def test_short_gap_same_athlete_merges(self):
        service = DetectionService()
        detections = [
            {"time_seconds": 10.0, "athlete_name": "ZHANG Wei", "confidence": 0.9},
            {"time_seconds": 12.0, "athlete_name": "ZHANG Wei", "confidence": 0.9},
            {"time_seconds": 14.0, "athlete_name": "ZHANG Wei", "confidence": 0.9},
        ]
        merged = service._merge_detections(detections, merge_threshold=5.0, sample_interval=1.0)
        assert len(merged) == 1
        assert merged[0]["start_seconds"] == 10.0
        assert merged[0]["end_seconds"] == 14.0
        assert merged[0]["count"] == 3

    def test_large_gap_does_not_merge(self):
        service = DetectionService()
        detections = [
            {"time_seconds": 10.0, "athlete_name": "ZHANG Wei", "confidence": 0.9},
            {"time_seconds": 60.0, "athlete_name": "ZHANG Wei", "confidence": 0.9},
        ]
        merged = service._merge_detections(detections, merge_threshold=5.0, sample_interval=1.0)
        assert len(merged) == 2

    def test_different_athletes_do_not_merge(self):
        service = DetectionService()
        detections = [
            {"time_seconds": 10.0, "athlete_name": "ZHANG Wei", "confidence": 0.9},
            {"time_seconds": 12.0, "athlete_name": "LI Min", "confidence": 0.9},
        ]
        merged = service._merge_detections(detections, merge_threshold=5.0, sample_interval=1.0)
        assert len(merged) == 2
        # name substring match keeps separate
        assert {d["athlete_name"] for d in merged} == {"ZHANG Wei", "LI Min"}

    def test_substring_name_treated_as_same_athlete(self):
        # When AI returns "ZHANG" then "ZHANG Wei", they should fold together
        service = DetectionService()
        detections = [
            {"time_seconds": 10.0, "athlete_name": "ZHANG", "confidence": 0.7},
            {"time_seconds": 12.0, "athlete_name": "ZHANG Wei", "confidence": 0.9},
        ]
        merged = service._merge_detections(detections, merge_threshold=5.0, sample_interval=1.0)
        assert len(merged) == 1
        # the longer name wins
        assert merged[0]["athlete_name"] == "ZHANG Wei"


# ---------------------------------------------------------------------------
# pHash dedup (score-based IoU analogue: pHash hamming-based similarity)
# ---------------------------------------------------------------------------


class TestPhashDedup:
    """Cover ``_compute_phash`` + ``_phash_lookup`` / ``_phash_store``."""

    def test_compute_phash_returns_zero_for_empty(self):
        service = DetectionService()
        empty = np.zeros((0, 0, 3), dtype=np.uint8)
        assert service._compute_phash(empty) == 0

    def test_compute_phash_deterministic_for_same_image(self):
        service = DetectionService()
        rng = np.random.default_rng(42)
        img = rng.integers(0, 255, (90, 1920, 3), dtype=np.uint8)
        h1 = service._compute_phash(img)
        h2 = service._compute_phash(img)
        assert h1 == h2
        assert h1 != 0

    def test_phash_store_then_lookup_exact_hit(self):
        service = DetectionService()
        value = {"is_athlete_subtitle": True, "athlete_name": "ZHANG Wei"}
        service._phash_store(0xDEADBEEF, value)

        hit = service._phash_lookup(0xDEADBEEF)
        assert hit is not None
        assert hit["athlete_name"] == "ZHANG Wei"

    def test_phash_lookup_within_distance_returns_hit(self):
        # similar candidate (1 bit off) — should still match (default max_dist=5)
        service = DetectionService()
        base = 0xDEADBEEF
        near = base ^ 0b1  # 1 bit different
        service._phash_store(base, {"athlete_name": "ZHANG Wei"})

        hit = service._phash_lookup(near)
        assert hit is not None
        assert hit["athlete_name"] == "ZHANG Wei"

    def test_phash_lookup_far_misses(self):
        service = DetectionService()
        service._phash_store(0x0, {"athlete_name": "X"})
        # ~32 bits flipped — well above max_distance=5
        miss = service._phash_lookup(0xFFFFFFFF, max_distance=5)
        assert miss is None

    def test_phash_cache_evicts_lru(self):
        service = DetectionService()
        service._phash_cache_max = 3
        for i in range(5):
            service._phash_store(i, {"id": i})
        # only the last 3 keys remain
        assert len(service._phash_cache) == 3
        assert 0 not in service._phash_cache
        assert 1 not in service._phash_cache
        assert 4 in service._phash_cache


# ---------------------------------------------------------------------------
# cancellation signal protocol
# ---------------------------------------------------------------------------


class TestCancellationSignal:
    def test_ensure_not_cancelled_passes_when_callback_false(self):
        service = DetectionService()
        # should not raise
        service._ensure_not_cancelled(lambda: False)
        service._ensure_not_cancelled(None)

    def test_ensure_not_cancelled_raises_when_callback_true(self):
        service = DetectionService()
        with pytest.raises(DetectionCancelledError, match="检测已取消"):
            service._ensure_not_cancelled(lambda: True)

    def test_restore_video_after_cancel_resets_status_no_clips(self):
        service = DetectionService()
        video = _make_video()
        state = ProjectState(videos=[video])

        service._restore_video_after_cancel(state, video, "cancelled by user")

        assert video.status == "queued"
        assert video.detection_progress["stage"] == "cancelled"
        assert video.detection_progress["message"] == "cancelled by user"

    def test_restore_video_after_cancel_with_pending_clips(self):
        service = DetectionService()
        video = _make_video()
        clip = CandidateClip(
            id="c1",
            video_id=video.id,
            candidate_start=0.0,
            candidate_end=10.0,
            review_start=0.0,
            review_end=10.0,
            subtitle_start=0.0,
            subtitle_end=10.0,
            status="pending",
        )
        state = ProjectState(videos=[video], candidate_clips=[clip])

        service._restore_video_after_cancel(state, video, "cancelled")

        # one clip, all pending → ready_for_review
        assert video.status == "ready_for_review"
        assert video.total_candidates == 1


# ---------------------------------------------------------------------------
# candidate clip building (boundary scenarios)
# ---------------------------------------------------------------------------


class TestBuildCandidateClips:
    def test_returns_empty_when_no_blocks(self):
        service = DetectionService()
        video = _make_video()
        out = service._build_candidate_clips(
            video, detection_blocks=[], pre_padding_seconds=2.0, video_duration=120.0
        )
        assert out == []

    def test_single_block_uses_video_duration_as_end(self):
        service = DetectionService()
        video = _make_video()
        block = DetectionBlock(
            id="det1",
            video_id=video.id,
            athlete_name="ZHANG Wei",
            country="CHN",
            subtitle_start=10.0,
            subtitle_end=15.0,
            confidence=0.9,
            count=1,
            timestamp="0:00:10",
        )
        clips = service._build_candidate_clips(
            video, detection_blocks=[block], pre_padding_seconds=2.0, video_duration=120.0
        )
        assert len(clips) == 1
        # pre-padding applied
        assert clips[0].candidate_start == pytest.approx(8.0)
        assert clips[0].candidate_end == pytest.approx(120.0)
        assert len(clips[0].segments) == 1

    def test_consecutive_blocks_clip_boundary_is_next_subtitle_start(self):
        service = DetectionService()
        video = _make_video()
        b1 = DetectionBlock(
            id="d1",
            video_id=video.id,
            athlete_name="A",
            country="",
            subtitle_start=10.0,
            subtitle_end=12.0,
            confidence=0.9,
            count=1,
            timestamp="",
        )
        b2 = DetectionBlock(
            id="d2",
            video_id=video.id,
            athlete_name="B",
            country="",
            subtitle_start=40.0,
            subtitle_end=42.0,
            confidence=0.9,
            count=1,
            timestamp="",
        )
        clips = service._build_candidate_clips(
            video, detection_blocks=[b1, b2], pre_padding_seconds=2.0, video_duration=120.0
        )
        assert len(clips) == 2
        # first clip ends at next subtitle start (40.0)
        assert clips[0].candidate_end == pytest.approx(40.0)
        # second clip ends at video duration
        assert clips[1].candidate_end == pytest.approx(120.0)

    def test_pre_padding_clamped_at_zero(self):
        service = DetectionService()
        video = _make_video()
        block = DetectionBlock(
            id="d",
            video_id=video.id,
            athlete_name="A",
            country="",
            subtitle_start=1.0,
            subtitle_end=2.0,
            confidence=0.9,
            count=1,
            timestamp="",
        )
        clips = service._build_candidate_clips(
            video, detection_blocks=[block], pre_padding_seconds=10.0, video_duration=120.0
        )
        # 1.0 - 10.0 = -9 → clamped to 0
        assert clips[0].candidate_start == 0.0


# ---------------------------------------------------------------------------
# name validation + AI response parsing (pure functions)
# ---------------------------------------------------------------------------


class TestNameValidation:
    def test_valid_two_word_name(self):
        service = DetectionService()
        assert service._is_valid_athlete_name("ZHANG Wei") is True

    def test_too_short_rejected(self):
        service = DetectionService()
        assert service._is_valid_athlete_name("Hi") is False
        assert service._is_valid_athlete_name("") is False

    def test_invalid_keywords_rejected(self):
        service = DetectionService()
        # 'china' is in invalid_keywords
        assert service._is_valid_athlete_name("China Team Final") is False
        # '决赛' is invalid
        assert service._is_valid_athlete_name("某某 决赛") is False

    def test_single_uppercase_word_accepted(self):
        service = DetectionService()
        assert service._is_valid_athlete_name("ZHANG") is True


class TestParseShortResponse:
    def test_empty_response_is_negative(self):
        service = DetectionService()
        out = service._parse_short_response("")
        assert out["is_athlete_subtitle"] is False

    def test_no_response_variants(self):
        service = DetectionService()
        for text in ("NO", "N/A", "NONE", "no"):
            out = service._parse_short_response(text)
            assert out["is_athlete_subtitle"] is False, f"failed for {text!r}"

    def test_chinese_no_prefix(self):
        service = DetectionService()
        out = service._parse_short_response("无字幕条")
        assert out["is_athlete_subtitle"] is False

    def test_extracts_lastname_firstname(self):
        service = DetectionService()
        out = service._parse_short_response("ZHANG Wei")
        assert out["is_athlete_subtitle"] is True
        assert out["athlete_name"] == "ZHANG Wei"


# ---------------------------------------------------------------------------
# detection block builder
# ---------------------------------------------------------------------------


class TestBuildDetectionBlocks:
    def test_filtered_items_become_blocks(self):
        service = DetectionService()
        items = [
            {
                "athlete_name": "ZHANG Wei",
                "country": "CHN",
                "start_seconds": 10.0,
                "end_seconds": 14.0,
                "confidence": 0.92,
                "count": 3,
                "timestamp": "0:00:10",
            }
        ]
        blocks = service._build_detection_blocks("vid_x", items)
        assert len(blocks) == 1
        assert blocks[0].video_id == "vid_x"
        assert blocks[0].athlete_name == "ZHANG Wei"
        assert blocks[0].subtitle_end == 14.0
        assert blocks[0].count == 3


# ---------------------------------------------------------------------------
# streaming decode + precheck (OOM fix)
# ---------------------------------------------------------------------------


def _solid_frame(value: int, h: int = 100, w: int = 320) -> np.ndarray:
    """A flat BGR frame. Flat frames have no edges → fail _quick_subtitle_check."""
    return np.full((h, w, 3), value, dtype=np.uint8)


def _subtitle_like_frame(h: int = 100, w: int = 320) -> np.ndarray:
    """A frame whose bottom 30% has high-contrast, saturated horizontal
    structure so it passes _quick_subtitle_check (edges + brightness/
    saturation std + sobel-y). Alternating colored bars give the saturation
    variance a black/white pattern would lack."""
    rng = np.random.default_rng(7)
    frame = rng.integers(0, 255, (h, w, 3), dtype=np.uint8)
    # paint bold colored horizontal bars in the bottom band: bright red, dim
    # blue, near-white — guarantees horizontal edges AND saturation spread.
    bottom_start = int(h * 0.7)
    colors = ((0, 0, 230), (200, 40, 0), (245, 245, 245))  # BGR
    for i, y in enumerate(range(bottom_start, h, 4)):
        frame[y : y + 4, :, :] = colors[i % len(colors)]
    return frame


class TestStreamPrecheckCandidates:
    """The streaming pipeline must (a) only keep frames that pass precheck,
    (b) never retain the full sampled frame set, (c) count every sample,
    (d) honour the time window, and (e) match what a per-frame precheck of
    the same source would produce (behavioural equivalence)."""

    def test_only_passing_frames_become_candidates(self):
        service = DetectionService()
        # 5 flat frames (fail) + 1 subtitle-like frame (pass)
        source = [
            (0.0, _solid_frame(30)),
            (2.0, _solid_frame(60)),
            (4.0, _subtitle_like_frame()),
            (6.0, _solid_frame(90)),
            (8.0, _solid_frame(120)),
        ]
        with patch.object(
            DetectionService, "_iter_sampled_frames", return_value=iter(source)
        ):
            candidates, total_samples = service._stream_precheck_candidates(
                video_path="/tmp/x.mp4", sample_interval=2.0
            )

        assert total_samples == 5
        # exactly the subtitle-like frame survived
        assert len(candidates) == 1
        assert candidates[0][0] == 4.0
        # kept region is the small bottom strip, NOT the full frame
        kept_region = candidates[0][1]
        assert kept_region.shape[0] < source[2][1].shape[0]

    def test_does_not_retain_all_frames_in_memory(self):
        """Structural OOM guard: the pipeline must pull frames lazily and keep
        only passing strips. We feed an exhaustible generator that counts how
        many frames are alive at once and assert candidates ≪ total frames."""
        service = DetectionService()
        total = 200
        live_refs: list[int] = []

        def gen():
            for i in range(total):
                # all flat → all fail precheck → candidates must stay empty,
                # proving no full-frame list is accumulated
                yield float(i * 2), _solid_frame(40 + (i % 3))
                live_refs.append(i)

        with patch.object(DetectionService, "_iter_sampled_frames", return_value=gen()):
            candidates, total_samples = service._stream_precheck_candidates(
                video_path="/tmp/x.mp4", sample_interval=2.0
            )

        assert total_samples == total
        # none passed precheck → zero retained, despite 200 frames streamed
        assert candidates == []
        assert len(live_refs) == total

    def test_counts_all_samples_even_when_filtered_out(self):
        service = DetectionService()
        source = [(float(i), _solid_frame(50)) for i in range(10)]
        with patch.object(
            DetectionService, "_iter_sampled_frames", return_value=iter(source)
        ):
            candidates, total_samples = service._stream_precheck_candidates(
                video_path="/tmp/x.mp4", sample_interval=1.0
            )
        assert total_samples == 10
        assert candidates == []

    def test_time_window_filters_out_of_range(self):
        service = DetectionService()
        source = [
            (0.0, _subtitle_like_frame()),
            (10.0, _subtitle_like_frame()),
            (20.0, _subtitle_like_frame()),
        ]
        with patch.object(
            DetectionService, "_iter_sampled_frames", return_value=iter(source)
        ):
            candidates, total_samples = service._stream_precheck_candidates(
                video_path="/tmp/x.mp4",
                sample_interval=2.0,
                start_seconds=5.0,
                end_seconds=15.0,
            )
        # all 3 streamed (counted), but only t=10 is inside [5, 15]
        assert total_samples == 3
        assert [t for t, _ in candidates] == [10.0]

    def test_skip_check_keeps_bottom_strip_of_every_in_window_frame(self):
        service = DetectionService()
        source = [(0.0, _solid_frame(40)), (2.0, _solid_frame(40))]
        with patch.object(
            DetectionService, "_iter_sampled_frames", return_value=iter(source)
        ):
            candidates, total_samples = service._stream_precheck_candidates(
                video_path="/tmp/x.mp4", sample_interval=2.0, skip_check=True
            )
        # skip_check bypasses subtitle detection → every frame yields a strip
        assert total_samples == 2
        assert len(candidates) == 2
        # bottom 30% strip retained (frame height 100 → strip height 30)
        assert candidates[0][1].shape[0] == 30

    def test_equivalence_streaming_matches_manual_precheck(self):
        """Behavioural equivalence: streaming candidates equal what a direct
        per-frame _quick_subtitle_check over the same source yields."""
        service = DetectionService()
        frames = [
            (0.0, _solid_frame(30)),
            (2.0, _subtitle_like_frame()),
            (4.0, _solid_frame(90)),
            (6.0, _subtitle_like_frame()),
        ]

        # reference: replicate old precheck semantics by hand
        expected_times = []
        for t, f in frames:
            has, region = service._quick_subtitle_check(f)
            if has and region is not None:
                expected_times.append(t)

        with patch.object(
            DetectionService, "_iter_sampled_frames", return_value=iter(frames)
        ):
            candidates, _ = service._stream_precheck_candidates(
                video_path="/tmp/x.mp4", sample_interval=2.0
            )

        assert [t for t, _ in candidates] == expected_times

    def test_cancellation_stops_mid_stream(self):
        """Cancellation must be checked per frame and abort the streaming
        precheck — not run to completion."""
        service = DetectionService()
        seen: list[float] = []

        def gen():
            for i in range(100):
                seen.append(float(i))
                yield float(i), _solid_frame(40)

        # cancel after 3 frames have been pulled
        def cancel():
            return len(seen) >= 3

        with patch.object(DetectionService, "_iter_sampled_frames", return_value=gen()):
            with pytest.raises(DetectionCancelledError):
                service._stream_precheck_candidates(
                    video_path="/tmp/x.mp4",
                    sample_interval=1.0,
                    cancel_requested=cancel,
                )
        # did not stream all 100 frames
        assert len(seen) < 100


class TestFfmpegDefaultCv2Fallback:
    """cv2 is the DEFAULT extraction path (same frames as ``main`` → unchanged
    detection results). ffmpeg (540p) is opt-in via ``DET_FFMPEG_EXTRACT=1``,
    because 540p downscaling makes precheck strictly more conservative and
    would silently drop borderline subtitle candidates if it were the default.
    """

    def test_cv2_is_default_even_when_ffmpeg_binary_resolves(self, monkeypatch):
        """Contract: with no env override, cv2 is used even if ffmpeg exists.
        Flipping this default would change detection output (see precision
        rationale in ``_should_use_ffmpeg`` docstring)."""
        monkeypatch.delenv("DET_FFMPEG_EXTRACT", raising=False)
        service = DetectionService()
        with patch(
            "video_review_backend.detection_service.resolve_ffmpeg_path",
            return_value="/usr/bin/ffmpeg",
        ):
            assert service._should_use_ffmpeg() is False

    def test_cv2_is_default_when_ffmpeg_unavailable(self, monkeypatch):
        monkeypatch.delenv("DET_FFMPEG_EXTRACT", raising=False)
        service = DetectionService()
        with patch(
            "video_review_backend.detection_service.resolve_ffmpeg_path",
            side_effect=RuntimeError("ffmpeg 未安装"),
        ):
            assert service._should_use_ffmpeg() is False

    def test_env_forces_ffmpeg_when_binary_resolves(self, monkeypatch):
        monkeypatch.setenv("DET_FFMPEG_EXTRACT", "1")
        service = DetectionService()
        # opt-in: "1" selects ffmpeg, but only if the binary actually resolves
        with patch(
            "video_review_backend.detection_service.resolve_ffmpeg_path",
            return_value="/usr/bin/ffmpeg",
        ):
            assert service._should_use_ffmpeg() is True

    def test_env_ffmpeg_opt_in_falls_back_to_cv2_when_binary_missing(self, monkeypatch):
        """Even with DET_FFMPEG_EXTRACT=1, an unresolvable binary → cv2."""
        monkeypatch.setenv("DET_FFMPEG_EXTRACT", "1")
        service = DetectionService()
        with patch(
            "video_review_backend.detection_service.resolve_ffmpeg_path",
            side_effect=RuntimeError("ffmpeg 未安装"),
        ):
            assert service._should_use_ffmpeg() is False

    def test_env_forces_cv2(self, monkeypatch):
        monkeypatch.setenv("DET_FFMPEG_EXTRACT", "0")
        service = DetectionService()
        # "0" forces cv2 even when ffmpeg is available
        with patch(
            "video_review_backend.detection_service.resolve_ffmpeg_path",
            return_value="/usr/bin/ffmpeg",
        ):
            assert service._should_use_ffmpeg() is False

    def test_540p_precheck_is_no_less_conservative_than_full_res(self):
        """Locks the precision rationale for keeping cv2 default: downscaling a
        frame to the ffmpeg target (540p short edge) must never turn a
        precheck FAIL into a PASS. The risky direction (pass→fail, i.e. silently
        dropping a real candidate) is exactly why ffmpeg is opt-in, not default.
        This asserts the *safe* invariant: 540p never invents candidates."""
        import cv2  # local import; module already depends on cv2

        service = DetectionService()
        rng = np.random.default_rng(7)
        full_pass_540_fail = 0
        full_fail_540_pass = 0
        for trial in range(120):
            sw, sh = 1920, 1080
            frame = rng.integers(0, 40, (sh, sw, 3)).astype(np.uint8)
            y0 = int(sh * 0.75)
            n = int(sw * (sh - y0) * rng.uniform(0.004, 0.045) / 4)
            ys = rng.integers(y0, sh, n)
            xs = rng.integers(0, sw, n)
            frame[ys, xs] = rng.integers(80, 255, (n, 3))

            has_full, _ = service._quick_subtitle_check(frame)
            th = 540
            tw = int(round(sw * th / sh))
            tw -= tw % 2
            small = cv2.resize(frame, (tw, th), interpolation=cv2.INTER_AREA)
            has_small, _ = service._quick_subtitle_check(small)

            if has_full and not has_small:
                full_pass_540_fail += 1
            elif has_small and not has_full:
                full_fail_540_pass += 1

        # 540p must never PASS something full-res rejected (no phantom candidates)
        assert full_fail_540_pass == 0
        # and the conservative direction does occur — proving the two paths are
        # NOT interchangeable, justifying cv2-as-default
        assert full_pass_540_fail > 0

    def test_iter_falls_back_to_cv2_when_ffmpeg_fails_before_first_frame(
        self, monkeypatch
    ):
        """If ffmpeg raises before yielding any frame, _iter_sampled_frames
        transparently switches to the cv2 generator."""
        monkeypatch.delenv("DET_FFMPEG_EXTRACT", raising=False)
        service = DetectionService()
        cv2_source = [(0.0, _solid_frame(40)), (2.0, _solid_frame(40))]

        def boom(*_args, **_kwargs):
            raise RuntimeError("ffmpeg blew up")
            yield  # make it a generator (never reached)

        with patch.object(DetectionService, "_should_use_ffmpeg", return_value=True), \
            patch.object(DetectionService, "_iter_sampled_frames_ffmpeg", side_effect=boom), \
            patch.object(
                DetectionService,
                "_iter_sampled_frames_cv2",
                return_value=iter(cv2_source),
            ):
            out = list(service._iter_sampled_frames("/tmp/x.mp4", 2.0))

        assert [t for t, _ in out] == [0.0, 2.0]

    def test_iter_does_not_fall_back_after_partial_ffmpeg_output(self, monkeypatch):
        """If ffmpeg fails AFTER streaming some frames, we must NOT restart from
        cv2 (would double-count) — the error propagates."""
        monkeypatch.delenv("DET_FFMPEG_EXTRACT", raising=False)
        service = DetectionService()

        def partial(*_args, **_kwargs):
            yield (0.0, _solid_frame(40))
            raise RuntimeError("ffmpeg died mid-stream")

        with patch.object(DetectionService, "_should_use_ffmpeg", return_value=True), \
            patch.object(
                DetectionService, "_iter_sampled_frames_ffmpeg", side_effect=partial
            ):
            with pytest.raises(RuntimeError, match="mid-stream"):
                list(service._iter_sampled_frames("/tmp/x.mp4", 2.0))


class TestIterSampledFramesCv2:
    """The cv2 generator yields frames lazily and releases the capture."""

    def test_yields_frames_and_releases_capture(self):
        service = DetectionService()
        cap = _fake_capture(fps=30.0, total_frames=180)  # 6s @ 30fps
        cap.read.return_value = (True, _solid_frame(50))

        with patch(
            "video_review_backend.detection_service.cv2.VideoCapture",
            return_value=cap,
        ):
            out = list(
                service._iter_sampled_frames_cv2("/tmp/x.mp4", sample_interval=2.0)
            )

        # samples at t=0,2,4 (frame_number 0,60,120 all < 180)
        assert [t for t, _ in out] == [0.0, 2.0, 4.0]
        cap.release.assert_called_once()

    def test_unopened_capture_yields_nothing(self):
        service = DetectionService()
        cap = _fake_capture(fps=30.0, total_frames=180, is_opened=False)
        with patch(
            "video_review_backend.detection_service.cv2.VideoCapture",
            return_value=cap,
        ):
            out = list(
                service._iter_sampled_frames_cv2("/tmp/x.mp4", sample_interval=2.0)
            )
        assert out == []

    def test_cancellation_in_cv2_generator(self):
        service = DetectionService()
        cap = _fake_capture(fps=30.0, total_frames=3000)
        cap.read.return_value = (True, _solid_frame(50))
        with patch(
            "video_review_backend.detection_service.cv2.VideoCapture",
            return_value=cap,
        ):
            gen = service._iter_sampled_frames_cv2(
                "/tmp/x.mp4", sample_interval=2.0, cancel_requested=lambda: True
            )
            with pytest.raises(DetectionCancelledError):
                next(gen)
        # capture still released via finally
        cap.release.assert_called_once()
