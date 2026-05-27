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
