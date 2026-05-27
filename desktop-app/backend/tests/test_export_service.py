"""Unit tests for ``export_service`` (D-4).

We exercise:

- ffmpeg command construction (no subprocess actually invoked)
- clip segment derivation (single, gapped, segmented)
- OSS multipart retry behaviour (SSL failure → 3 retries → success / fail)
  via a ``FakeBucket`` (no network)
- output file naming (with/without platform record, local card subfolder)
- score formula formatting (mirrors precision spec D 1d / E 3d / Total 3d)
- export-error marking sets the right stage tags
- ``retry_single_clip_stage`` stage validation surface
- platform writeback retry surface (mocked PlatformClient)

The ffmpeg binary path resolution is intentionally bypassed via
``object.__new__`` so tests work even when ffmpeg isn't installed in CI.
"""

from __future__ import annotations

import ssl
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from video_review_backend import oss_upload_service
from video_review_backend.export_service import (
    DEFAULT_PLATFORM_SYNC_RETRY_ATTEMPTS,
    ExportService,
    _clean_path_component,
    _coerce_sex,
    _derive_sex_from_sport_item,
    _format_score_expression,
    _format_score_precision,
    _is_zero_score,
)
from video_review_backend.models import (
    CandidateClip,
    ClipSegment,
    PlatformRecord,
    ProjectState,
    VideoTask,
)
from video_review_backend.oss_upload_service import OSSUploadService


# ---------------------------------------------------------------------------
# helpers — build an ExportService whose ffmpeg path is fixed (no real binary)
# ---------------------------------------------------------------------------


def _make_service(ffmpeg_path: str = "/usr/bin/ffmpeg") -> ExportService:
    service = object.__new__(ExportService)
    service.ffmpeg_path = ffmpeg_path
    service.platform_client = MagicMock()
    service.oss_upload_service = MagicMock()
    return service


def _make_video(*, source_kind: str = "full_video", duration: float = 120.0) -> VideoTask:
    return VideoTask(
        id="video_exp",
        file_path="/tmp/movie.mp4",
        file_name="movie.mp4",
        source_kind=source_kind,
        platform_scope_id="scope",
        match_name="赛事",
        duration=duration,
        resolution="1920x1080",
        status="reviewing",
    )


def _make_clip(
    *,
    video_id: str = "video_exp",
    review_start: float = 0.0,
    review_end: float = 10.0,
    segments: list[ClipSegment] | None = None,
    platform_record_id: str | None = None,
) -> CandidateClip:
    return CandidateClip(
        id="clip_exp",
        video_id=video_id,
        linked_platform_record_id=platform_record_id,
        athlete_name="ZHANG Wei",
        country="CHN",
        candidate_start=review_start,
        candidate_end=review_end,
        review_start=review_start,
        review_end=review_end,
        subtitle_start=review_start,
        subtitle_end=review_end,
        segments=list(segments) if segments else [],
        status="kept",
    )


def _make_record(*, is_local: bool = False) -> PlatformRecord:
    return PlatformRecord(
        id="rec1",
        video_id="video_exp",
        platform_scope_id="scope",
        match_name="测试比赛",
        category="EF",
        sport_item_label="FX",
        user_name="张伟",
        english_name="ZHANG Wei",
        difficulty_score="5.6",
        execution_score="8.500",
        bonus_score="0.3",
        penalty_score="0.0",
        total_score="14.400",
        is_local=is_local,
    )


# ---------------------------------------------------------------------------
# ffmpeg command construction
# ---------------------------------------------------------------------------


class TestFfmpegCommand:
    def test_fast_mode_builds_expected_cli(self):
        service = _make_service("/opt/ffmpeg")
        out = Path("/tmp/out.mp4")
        cmd = service._build_ffmpeg_command(
            video_path="/in.mp4", start=5.0, end=15.0, output_file=out, export_mode="fast"
        )
        assert cmd[0] == "/opt/ffmpeg"
        assert "-ss" in cmd and "-i" in cmd and "-t" in cmd
        # duration arg follows -t
        t_idx = cmd.index("-t")
        assert cmd[t_idx + 1] == "10.0"
        # ultrafast preset for fast mode
        assert "ultrafast" in cmd
        assert str(out) == cmd[-1]

    def test_standard_mode_uses_fast_preset(self):
        service = _make_service()
        cmd = service._build_ffmpeg_command(
            video_path="/in.mp4",
            start=0.0,
            end=5.0,
            output_file=Path("/o.mp4"),
            export_mode="standard",
        )
        # standard uses '-preset fast' (different from fast mode's ultrafast)
        assert "fast" in cmd
        assert "ultrafast" not in cmd

    def test_invalid_mode_raises(self):
        service = _make_service()
        with pytest.raises(RuntimeError, match="不支持的导出模式"):
            service._build_ffmpeg_command(
                video_path="/x.mp4",
                start=0.0,
                end=5.0,
                output_file=Path("/o.mp4"),
                export_mode="bogus",
            )

    def test_zero_duration_rejected(self):
        service = _make_service()
        with pytest.raises(RuntimeError, match="无效的导出时间范围"):
            service._build_ffmpeg_command(
                video_path="/x.mp4",
                start=10.0,
                end=10.0,
                output_file=Path("/o.mp4"),
                export_mode="fast",
            )

    def test_negative_start_clamped_to_zero(self):
        service = _make_service()
        cmd = service._build_ffmpeg_command(
            video_path="/x.mp4",
            start=-5.0,
            end=10.0,
            output_file=Path("/o.mp4"),
            export_mode="fast",
        )
        # start clamped to 0.0 → -ss 00:00:00.000
        ss_idx = cmd.index("-ss")
        assert cmd[ss_idx + 1] == "00:00:00.000"


# ---------------------------------------------------------------------------
# clip segment derivation
# ---------------------------------------------------------------------------


class TestClipSegments:
    def test_single_review_range(self):
        service = _make_service()
        clip = _make_clip(review_start=3.0, review_end=12.0)
        out = service._clip_segments(clip)
        assert out == [(3.0, 12.0)]

    def test_explicit_segments_sorted(self):
        service = _make_service()
        clip = _make_clip(
            segments=[
                ClipSegment(id="b", start=20.0, end=30.0),
                ClipSegment(id="a", start=5.0, end=10.0),
            ]
        )
        out = service._clip_segments(clip)
        assert out == [(5.0, 10.0), (20.0, 30.0)]

    def test_gap_splits_into_two_segments(self):
        service = _make_service()
        clip = _make_clip(review_start=0.0, review_end=30.0)
        clip.gap_start = 10.0
        clip.gap_end = 15.0
        out = service._clip_segments(clip)
        assert out == [(0.0, 10.0), (15.0, 30.0)]

    def test_gap_outside_review_falls_back_to_single(self):
        service = _make_service()
        clip = _make_clip(review_start=0.0, review_end=10.0)
        clip.gap_start = 20.0
        clip.gap_end = 25.0  # gap_end <= start when clamped
        out = service._clip_segments(clip)
        # gap_end clamped to 10, gap_start clamped to 10 → no real gap
        assert out == [(0.0, 10.0)]


# ---------------------------------------------------------------------------
# output file naming
# ---------------------------------------------------------------------------


class TestBuildOutputFile:
    def test_no_record_uses_athlete_country(self, tmp_path: Path):
        service = _make_service()
        video = _make_video()
        clip = _make_clip()
        out = service._build_output_file(tmp_path, video, clip, index=1)
        assert out.parent == tmp_path
        assert "ZHANG-Wei" in out.name or "ZHANG_Wei" in out.name
        assert "CHN" in out.name
        assert out.suffix == ".mp4"

    def test_record_drives_filename(self, tmp_path: Path):
        service = _make_service()
        video = _make_video()
        record = _make_record()
        clip = _make_clip(platform_record_id=record.id)
        state = ProjectState(
            videos=[video], candidate_clips=[clip], platform_records=[record]
        )
        out = service._build_output_file(tmp_path, video, clip, index=1, state=state)
        # filename is match-athlete-apparatus-score.mp4
        assert "测试比赛" in out.name
        assert "FX" in out.name
        assert out.parent == tmp_path

    def test_local_record_goes_into_subfolder(self, tmp_path: Path):
        service = _make_service()
        video = _make_video()
        record = _make_record(is_local=True)
        clip = _make_clip(platform_record_id=record.id)
        state = ProjectState(
            videos=[video], candidate_clips=[clip], platform_records=[record]
        )
        out = service._build_output_file(tmp_path, video, clip, index=1, state=state)
        assert out.parent.name == "本地补录"
        assert out.parent.parent == tmp_path
        assert out.parent.exists()  # mkdir was called

    def test_unique_path_appends_index(self, tmp_path: Path):
        service = _make_service()
        existing = tmp_path / "file.mp4"
        existing.write_bytes(b"x")
        result = service._ensure_unique_path(existing)
        assert result.name == "file_02.mp4"

    def test_unique_path_not_modified_when_free(self, tmp_path: Path):
        service = _make_service()
        target = tmp_path / "new.mp4"
        result = service._ensure_unique_path(target)
        assert result == target


# ---------------------------------------------------------------------------
# score formula & helpers (precision spec from memory)
# ---------------------------------------------------------------------------


class TestScoreFormula:
    def test_difficulty_1d_execution_3d(self):
        service = _make_service()
        rec = PlatformRecord(
            id="r",
            video_id="v",
            difficulty_score="5.6",
            execution_score="8.5",
            total_score="14.100",
        )
        out = service._build_score_formula(rec)
        # D=5.6, E=8.500, Total=14.100
        assert out == "5.6+8.500=14.100"

    def test_zero_bonus_and_penalty_omitted(self):
        # spec: Bonus/Penalty 1d, omitted when zero
        service = _make_service()
        rec = PlatformRecord(
            id="r",
            video_id="v",
            difficulty_score="6.0",
            execution_score="8.300",
            bonus_score="0",
            penalty_score="0",
            total_score="14.300",
        )
        out = service._build_score_formula(rec)
        assert out == "6.0+8.300=14.300"

    def test_nonzero_bonus_kept(self):
        service = _make_service()
        rec = PlatformRecord(
            id="r",
            video_id="v",
            difficulty_score="5.6",
            execution_score="8.500",
            bonus_score="0.3",
            total_score="14.400",
        )
        out = service._build_score_formula(rec)
        assert "0.3" in out

    def test_format_score_precision_handles_invalid(self):
        assert _format_score_precision("abc", 3) == "abc"
        assert _format_score_precision("", 3) == "0"

    def test_is_zero_score(self):
        assert _is_zero_score("0") is True
        assert _is_zero_score("0.0") is True
        assert _is_zero_score("0.1") is False
        assert _is_zero_score("foo") is False

    def test_format_score_expression_signed_terms(self):
        out = _format_score_expression(["5.6", "8.500", "-0.3"])
        assert out == "5.6+8.500-0.3"


# ---------------------------------------------------------------------------
# misc helpers
# ---------------------------------------------------------------------------


class TestHelpers:
    def test_clean_path_component_strips_unsafe_chars(self):
        # Each run of unsafe chars collapses to a single '-'.
        assert _clean_path_component('a/b?c<d>') == "a-b-c-d-"
        # Filesystem-reserved chars get scrubbed.
        assert _clean_path_component("foo/bar") == "foo-bar"
        # Empty / whitespace-only falls back to placeholder.
        assert _clean_path_component("   ") == "未命名"

    def test_coerce_sex_numeric(self):
        assert _coerce_sex(1) == 1
        assert _coerce_sex(2) == 2
        assert _coerce_sex(3) is None
        assert _coerce_sex("男") == 1
        assert _coerce_sex("女") == 2
        assert _coerce_sex(None) is None

    def test_derive_sex_from_sport_item(self):
        assert _derive_sex_from_sport_item(1) == 1  # men
        assert _derive_sex_from_sport_item(6) == 2  # women
        assert _derive_sex_from_sport_item(99) is None


# ---------------------------------------------------------------------------
# OSS upload retry boundary (mock OSS SDK; no network)
# ---------------------------------------------------------------------------


class _RetryFakeBucket:
    """Fails ``fail_count`` times with SSL error, then succeeds."""

    def __init__(self, fail_count: int) -> None:
        self.fail_count = fail_count
        self.upload_part_calls = 0
        self.completed_parts: list | None = None
        self.abort_called = False

    def init_multipart_upload(self, _key):
        return SimpleNamespace(upload_id="uid")

    def upload_part(self, _key, _uid, _part_number, progress_reader):
        self.upload_part_calls += 1
        # mimic progress reader behaviour (read some bytes)
        progress_reader.read(2)
        if self.upload_part_calls <= self.fail_count:
            raise ssl.SSLError("SSL EOF")
        progress_reader.read()
        return SimpleNamespace(etag=f"etag-{self.upload_part_calls}", crc=1)

    def complete_multipart_upload(self, _key, _uid, parts):
        self.completed_parts = parts

    def abort_multipart_upload(self, _key, _uid):
        self.abort_called = True


class TestOssRetryBoundary:
    def test_succeeds_within_retry_budget(self, tmp_path, monkeypatch):
        source = tmp_path / "blob.bin"
        source.write_bytes(b"abcdef")
        monkeypatch.setattr(oss_upload_service.time, "sleep", lambda _s: None)

        bucket = _RetryFakeBucket(fail_count=2)
        service = OSSUploadService()
        service._multipart_upload_with_progress(
            bucket=bucket,
            object_key="k",
            source_path=source,
            num_threads=1,
            progress_callback=None,
        )

        # 2 failures then success → 3 calls total
        assert bucket.upload_part_calls == 3
        assert bucket.completed_parts is not None
        assert not bucket.abort_called

    def test_exhausted_retries_raise_and_abort(self, tmp_path, monkeypatch):
        source = tmp_path / "blob.bin"
        source.write_bytes(b"abcdef")
        monkeypatch.setattr(oss_upload_service.time, "sleep", lambda _s: None)

        # Budget is len(DEFAULT_OSS_PART_RETRY_BACKOFF_SECONDS)+1 = 4 attempts
        bucket = _RetryFakeBucket(fail_count=99)
        service = OSSUploadService()
        with pytest.raises(ssl.SSLError):
            service._multipart_upload_with_progress(
                bucket=bucket,
                object_key="k",
                source_path=source,
                num_threads=1,
                progress_callback=None,
            )
        # multipart abort triggered on exhaustion
        assert bucket.abort_called is True
        # 4 attempts capped
        assert bucket.upload_part_calls == 4


# ---------------------------------------------------------------------------
# error marking (stage tags)
# ---------------------------------------------------------------------------


class TestMarkExportFailed:
    def test_failure_sets_platform_sync_failed(self):
        service = _make_service()
        clip = _make_clip()
        result = service._mark_export_failed(clip, "ffmpeg died")
        assert result.success is False
        assert result.error_message == "ffmpeg died"
        assert clip.export_error_message == "ffmpeg died"
        assert clip.platform_sync_status == "failed"
        assert clip.platform_sync_error_message == "ffmpeg died"

    def test_reset_clip_export_state_clears_uploaded(self):
        service = _make_service()
        clip = _make_clip()
        clip.exported_path = "/x.mp4"
        clip.uploaded_object_key = "key"
        clip.uploaded_url = "http://x"
        clip.platform_sync_status = "synced"
        clip.platform_sync_error_message = "old"

        service._reset_clip_export_state(clip)
        assert clip.exported_path is None
        assert clip.uploaded_object_key is None
        assert clip.uploaded_url is None
        assert clip.platform_sync_status is None
        assert clip.platform_sync_error_message is None

    def test_reset_clip_export_state_keeps_output_when_asked(self):
        service = _make_service()
        clip = _make_clip()
        clip.exported_path = "/keep.mp4"
        clip.uploaded_url = "http://x"
        service._reset_clip_export_state(clip, keep_output_file=True)
        assert clip.exported_path == "/keep.mp4"
        assert clip.uploaded_url is None


# ---------------------------------------------------------------------------
# platform writeback retry (mocked PlatformClient)
# ---------------------------------------------------------------------------


class TestPlatformWriteback:
    def test_writeback_success_first_try(self):
        service = _make_service()
        # mock platform client
        service.platform_client.update_video_urls = MagicMock()
        clip = _make_clip()
        record = _make_record()

        service._sync_platform_video_url(
            clip=clip,
            platform_record=record,
            source_file=Path("/x.mp4"),
            uploaded_url="https://oss/x.mp4",
        )

        assert clip.platform_sync_status == "synced"
        assert clip.platform_sync_error_message is None
        assert service.platform_client.update_video_urls.call_count == 1

    def test_writeback_retries_then_succeeds(self, monkeypatch):
        service = _make_service()
        call_count = {"n": 0}

        def flaky(records, url_map):
            call_count["n"] += 1
            if call_count["n"] < 2:
                raise RuntimeError("flaky network")

        service.platform_client.update_video_urls = MagicMock(side_effect=flaky)
        monkeypatch.setattr(
            "video_review_backend.export_service.time.sleep", lambda _s: None
        )

        clip = _make_clip()
        record = _make_record()
        service._sync_platform_video_url(
            clip=clip,
            platform_record=record,
            source_file=Path("/x.mp4"),
            uploaded_url="https://oss/x.mp4",
        )
        assert clip.platform_sync_status == "synced"
        assert call_count["n"] == 2

    def test_writeback_all_attempts_fail_raises(self, monkeypatch):
        service = _make_service()
        service.platform_client.update_video_urls = MagicMock(
            side_effect=RuntimeError("nope")
        )
        monkeypatch.setattr(
            "video_review_backend.export_service.time.sleep", lambda _s: None
        )

        clip = _make_clip()
        record = _make_record()
        with pytest.raises(RuntimeError, match="nope"):
            service._sync_platform_video_url(
                clip=clip,
                platform_record=record,
                source_file=Path("/x.mp4"),
                uploaded_url="https://oss/x.mp4",
            )
        assert (
            service.platform_client.update_video_urls.call_count
            == DEFAULT_PLATFORM_SYNC_RETRY_ATTEMPTS
        )


# ---------------------------------------------------------------------------
# retry_single_clip_stage surface (input validation only — no real ffmpeg/OSS)
# ---------------------------------------------------------------------------


class TestRetrySingleClipStage:
    def test_unknown_stage_raises(self):
        service = _make_service()
        clip = _make_clip()
        video = _make_video()
        state = ProjectState(videos=[video], candidate_clips=[clip])
        with pytest.raises(ValueError, match="不支持的重试阶段"):
            service.retry_single_clip_stage(state, clip.id, stage="bogus")

    def test_missing_clip_raises(self):
        service = _make_service()
        state = ProjectState(videos=[], candidate_clips=[])
        with pytest.raises(ValueError, match="片段不存在"):
            service.retry_single_clip_stage(state, "nope", stage="oss")

    def test_oss_stage_requires_exported_file(self):
        service = _make_service()
        clip = _make_clip()  # exported_path is None
        video = _make_video()
        state = ProjectState(videos=[video], candidate_clips=[clip])
        with pytest.raises(ValueError, match="本地导出文件不存在"):
            service.retry_single_clip_stage(state, clip.id, stage="oss")

    def test_platform_stage_requires_upload(self):
        service = _make_service()
        clip = _make_clip()
        clip.exported_path = "/some/path.mp4"
        # no uploaded_url
        video = _make_video()
        state = ProjectState(videos=[video], candidate_clips=[clip])
        with pytest.raises(ValueError, match="OSS 上传未完成"):
            service.retry_single_clip_stage(state, clip.id, stage="platform")
