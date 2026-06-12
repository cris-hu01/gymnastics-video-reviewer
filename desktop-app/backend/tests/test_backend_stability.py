"""Unit tests for backend stability hardening (PR5).

Covers four independent fixes:

1. ffmpeg / ffprobe subprocess timeouts — a hung binary must surface a failure
   instead of blocking a job worker forever.
2. export cancellation — ``export_kept_clips`` stops at clip/upload boundaries
   when the cancel callback returns True, raising ``ExportCancelledError``.
3. ``import_videos_into_project`` lock-scope refactor — ffprobe runs outside the
   lock via ``probe_import_video_inputs`` and the import result is unchanged.
4. ``save_project_state`` temp-file leak — a failing ``json.dump`` must clean up
   the NamedTemporaryFile and leave the original file untouched.

All ffmpeg/ffprobe binaries are mocked; no real subprocess runs.
"""

from __future__ import annotations

import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from video_review_backend import storage as storage_module
from video_review_backend import video_metadata as video_metadata_module
from video_review_backend.deps.state_helpers import merge_export_state
from video_review_backend.export_service import (
    ExportCancelledError,
    ExportService,
    _estimate_ffmpeg_timeout,
)
from video_review_backend.models import (
    CandidateClip,
    PlatformRecord,
    ProjectState,
    VideoTask,
)
from video_review_backend.storage import load_project_state, save_project_state
from video_review_backend.video_import import (
    import_videos_into_project,
    probe_import_video_inputs,
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _make_service(ffmpeg_path: str = "/usr/bin/ffmpeg") -> ExportService:
    service = object.__new__(ExportService)
    service.ffmpeg_path = ffmpeg_path
    service.platform_client = MagicMock()
    service.oss_upload_service = MagicMock()
    return service


def _make_video(*, duration: float = 120.0) -> VideoTask:
    return VideoTask(
        id="video_exp",
        file_path="/tmp/movie.mp4",
        file_name="movie.mp4",
        source_kind="full_video",
        platform_scope_id="scope",
        match_name="赛事",
        duration=duration,
        resolution="1920x1080",
        status="reviewing",
    )


def _make_clip(
    *,
    clip_id: str = "clip_exp",
    review_start: float = 0.0,
    review_end: float = 10.0,
    platform_record_id: str | None = None,
) -> CandidateClip:
    return CandidateClip(
        id=clip_id,
        video_id="video_exp",
        linked_platform_record_id=platform_record_id,
        athlete_name="ZHANG Wei",
        country="CHN",
        candidate_start=review_start,
        candidate_end=review_end,
        review_start=review_start,
        review_end=review_end,
        subtitle_start=review_start,
        subtitle_end=review_end,
        segments=[],
        status="kept",
    )


def _make_record(*, record_id: str, is_local: bool = False) -> PlatformRecord:
    return PlatformRecord(
        id=record_id,
        video_id="video_exp",
        platform_scope_id="scope",
        match_name="测试比赛",
        category="EF",
        sport_item_label="FX",
        user_name="张伟",
        english_name="ZHANG Wei",
        difficulty_score="5.6",
        execution_score="8.500",
        total_score="14.100",
        is_local=is_local,
    )


def _ffprobe_meta(path: str) -> dict[str, object]:
    p = Path(path)
    return {
        "file_name": p.name,
        "file_path": str(p.resolve()),
        "duration": 30.0,
        "resolution": "1920x1080",
    }


# ---------------------------------------------------------------------------
# 1) subprocess timeouts
# ---------------------------------------------------------------------------


class TestEstimateFfmpegTimeout:
    def test_floor_applied_for_short_clips(self):
        # 5s clip * 3 = 15s, below the 60s floor.
        assert _estimate_ffmpeg_timeout(5.0) == 60

    def test_scales_with_duration(self):
        assert _estimate_ffmpeg_timeout(100.0) == 300  # 100 * 3

    def test_capped_at_one_hour(self):
        assert _estimate_ffmpeg_timeout(10_000.0) == 3600

    def test_none_falls_back_to_floor(self):
        assert _estimate_ffmpeg_timeout(None) == 60

    def test_invalid_falls_back_to_floor(self):
        assert _estimate_ffmpeg_timeout("not-a-number") == 60  # type: ignore[arg-type]


class TestRunFfmpegTimeout:
    def test_timeout_translated_to_runtime_error(self):
        service = _make_service()

        def boom(*args, **kwargs):
            raise subprocess.TimeoutExpired(cmd=["ffmpeg"], timeout=60)

        with patch("video_review_backend.export_service.subprocess.run", side_effect=boom):
            with pytest.raises(RuntimeError) as exc:
                service._run_ffmpeg(["ffmpeg", "-i", "x"], timeout=60)
        assert "超时" in str(exc.value)

    def test_timeout_passed_through_to_subprocess(self):
        service = _make_service()
        completed = subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr="")
        with patch(
            "video_review_backend.export_service.subprocess.run", return_value=completed
        ) as mock_run:
            service._run_ffmpeg(["ffmpeg", "-i", "x"], timeout=123)
        assert mock_run.call_args.kwargs["timeout"] == 123

    def test_export_clip_media_uses_duration_based_timeout(self):
        service = _make_service()
        clip = _make_clip(review_start=0.0, review_end=40.0)
        captured: dict[str, object] = {}

        def fake_run(cmd, timeout=None):
            captured["timeout"] = timeout

        with patch.object(service, "_run_ffmpeg", side_effect=fake_run):
            service._export_clip_media(
                video_path="/tmp/movie.mp4",
                clip=clip,
                output_file=Path("/tmp/out.mp4"),
                export_mode="standard",
            )
        # 40s * 3 = 120s.
        assert captured["timeout"] == 120


class TestEnsureFfmpegTimeout:
    def test_version_probe_timeout_becomes_runtime_error(self):
        service = _make_service()

        def boom(*args, **kwargs):
            raise subprocess.TimeoutExpired(cmd=["ffmpeg", "-version"], timeout=30)

        with patch("video_review_backend.export_service.subprocess.run", side_effect=boom):
            with pytest.raises(RuntimeError) as exc:
                service._ensure_ffmpeg()
        assert "超时" in str(exc.value)


class TestFfprobeTimeout:
    def test_probe_timeout_becomes_runtime_error(self, tmp_path: Path):
        video = tmp_path / "hang.mp4"
        video.write_bytes(b"x")

        def boom(*args, **kwargs):
            raise subprocess.TimeoutExpired(cmd=["ffprobe"], timeout=60)

        with patch.object(video_metadata_module.subprocess, "run", side_effect=boom):
            with patch.object(
                video_metadata_module, "resolve_ffprobe_path", return_value="/fake/ffprobe"
            ):
                with pytest.raises(RuntimeError) as exc:
                    video_metadata_module.probe_video_metadata(str(video))
        assert "超时" in str(exc.value)

    def test_probe_passes_timeout_to_subprocess(self, tmp_path: Path):
        video = tmp_path / "ok.mp4"
        video.write_bytes(b"x")
        completed = subprocess.CompletedProcess(
            args=["ffprobe"],
            returncode=0,
            stdout=json.dumps({"format": {"duration": "5.0"}, "streams": []}),
            stderr="",
        )
        with patch.object(
            video_metadata_module.subprocess, "run", return_value=completed
        ) as mock_run:
            with patch.object(
                video_metadata_module, "resolve_ffprobe_path", return_value="/fake/ffprobe"
            ):
                video_metadata_module.probe_video_metadata(str(video))
        assert mock_run.call_args.kwargs["timeout"] == video_metadata_module.FFPROBE_TIMEOUT_SECONDS


# ---------------------------------------------------------------------------
# 2) export cancellation
# ---------------------------------------------------------------------------


class TestExportCancellation:
    def _state_with_two_clips(self) -> ProjectState:
        state = ProjectState()
        state.videos.append(_make_video())
        state.candidate_clips.append(_make_clip(clip_id="clip_a"))
        state.candidate_clips.append(_make_clip(clip_id="clip_b"))
        return state

    def test_cancel_before_first_clip_stops_immediately(self, tmp_path: Path):
        service = _make_service()
        state = self._state_with_two_clips()
        export_calls: list[str] = []

        with patch.object(service, "_ensure_ffmpeg"), patch.object(
            service, "_export_clip_media", side_effect=lambda **kw: export_calls.append("x")
        ):
            with pytest.raises(ExportCancelledError):
                service.export_kept_clips(
                    state,
                    output_dir=str(tmp_path / "out"),
                    operation="export_only",
                    is_cancel_requested=lambda: True,
                )
        # Cancellation fires at the loop boundary before any clip is exported.
        assert export_calls == []

    def test_cancel_after_first_clip_stops_before_second(self, tmp_path: Path):
        service = _make_service()
        state = self._state_with_two_clips()
        export_calls: list[str] = []
        # Return False on the first boundary check, True on the second.
        flags = iter([False, True, True, True])

        def fake_export(**kwargs):
            export_calls.append(kwargs["clip"].id)

        with patch.object(service, "_ensure_ffmpeg"), patch.object(
            service, "_export_clip_media", side_effect=fake_export
        ):
            with pytest.raises(ExportCancelledError):
                service.export_kept_clips(
                    state,
                    output_dir=str(tmp_path / "out"),
                    operation="export_only",
                    is_cancel_requested=lambda: next(flags),
                )
        # Exactly one clip processed before the next boundary cancels.
        assert len(export_calls) == 1

    def test_no_cancel_runs_to_completion(self, tmp_path: Path):
        service = _make_service()
        state = self._state_with_two_clips()
        with patch.object(service, "_ensure_ffmpeg"), patch.object(
            service, "_export_clip_media", side_effect=lambda **kw: None
        ):
            result = service.export_kept_clips(
                state,
                output_dir=str(tmp_path / "out"),
                operation="export_only",
                is_cancel_requested=lambda: False,
            )
        assert result.attempted == 2
        assert result.failed == 0

    def test_cancel_exposes_only_touched_clip_ids(self, tmp_path: Path):
        """Scoped persistence: the cancel error must carry only processed clips."""
        service = _make_service()
        state = ProjectState()
        state.videos.append(_make_video())
        state.candidate_clips.append(_make_clip(clip_id="clip_a"))
        state.candidate_clips.append(_make_clip(clip_id="clip_b"))
        state.candidate_clips.append(_make_clip(clip_id="clip_c"))
        # Cancel only after the first clip has been exported.
        flags = iter([False, True, True, True, True])

        with patch.object(service, "_ensure_ffmpeg"), patch.object(
            service, "_export_clip_media", side_effect=lambda **kw: None
        ):
            with pytest.raises(ExportCancelledError) as exc:
                service.export_kept_clips(
                    state,
                    output_dir=str(tmp_path / "out"),
                    operation="export_only",
                    is_cancel_requested=lambda: next(flags),
                )
        # Only clip_a was processed; clip_b / clip_c untouched -> must NOT be merged.
        assert exc.value.touched_clip_ids == {"clip_a"}

    def test_upload_path_cancel_raises_not_swallowed(self, tmp_path: Path):
        """export_and_upload with multiple upload futures: cancelling at the upload
        boundary must raise ExportCancelledError (-> JobCancelledError / cancelled),
        not be swallowed into a failed/completed upload result.
        """
        service = _make_service()
        out_dir = tmp_path / "out"

        state = ProjectState()
        state.videos.append(_make_video())
        state.platform_records.append(_make_record(record_id="rec_a"))
        state.platform_records.append(_make_record(record_id="rec_b"))
        state.candidate_clips.append(_make_clip(clip_id="clip_a", platform_record_id="rec_a"))
        state.candidate_clips.append(_make_clip(clip_id="clip_b", platform_record_id="rec_b"))

        # _export_clip_media must produce a real file (the upload path stat()s it).
        def fake_export(*, video_path, clip, output_file, export_mode):
            Path(output_file).write_bytes(b"fake-mp4")

        upload_calls: list[str] = []

        def fake_upload(**kwargs):
            upload_calls.append(kwargs["clip"].id)
            return ("object/key", "https://example.com/clip.mp4")

        # Two clips -> two clip-loop boundary checks (both must pass so both get
        # queued for upload), then the upload-worker boundary fires the cancel.
        uploads_phase = {"flag": False}

        def cancel() -> bool:
            return uploads_phase["flag"]

        with patch.object(service, "_ensure_ffmpeg"), patch.object(
            service, "_export_clip_media", side_effect=fake_export
        ), patch.object(
            service, "_upload_clip_output", side_effect=fake_upload
        ), patch.object(
            service, "_sync_platform_video_url"
        ):
            # The clip loop runs first (cancel False -> both exported + queued).
            # Patch the executor's submit so we flip the cancel flag right before
            # any upload worker starts, exercising the upload boundary.
            real_submit = ThreadPoolExecutor.submit

            def flip_then_submit(self, fn, *a, **kw):
                uploads_phase["flag"] = True
                return real_submit(self, fn, *a, **kw)

            with patch.object(ThreadPoolExecutor, "submit", flip_then_submit):
                with pytest.raises(ExportCancelledError):
                    service.export_kept_clips(
                        state,
                        output_dir=str(out_dir),
                        operation="export_and_upload",
                        upload_parallel_files=2,
                        is_cancel_requested=cancel,
                    )
        # Both local exports completed, but no upload ran: cancelled at the upload
        # boundary (inside _process_upload, before _upload_clip_output).
        assert upload_calls == []

    def test_cancel_in_upload_mode_persists_locally_exported_clips(self, tmp_path: Path):
        """Regression: in export_and_upload, clips whose LOCAL export finished but
        whose upload hasn't run yet are queued in upload_work and NOT yet in
        results_by_clip_id. They must still be in touched_clip_ids on cancel — they
        have status=exported + a real file on disk; dropping them would orphan the
        files and lose progress. (export_only happened to be correct because every
        processed clip lands in results_by_clip_id; this mode exposes the gap.)
        """
        service = _make_service()
        out_dir = tmp_path / "out"

        state = ProjectState()
        state.videos.append(_make_video())
        state.platform_records.append(_make_record(record_id="rec_a"))
        state.platform_records.append(_make_record(record_id="rec_b"))
        state.candidate_clips.append(_make_clip(clip_id="clip_a", platform_record_id="rec_a"))
        state.candidate_clips.append(_make_clip(clip_id="clip_b", platform_record_id="rec_b"))

        def fake_export(*, video_path, clip, output_file, export_mode):
            Path(output_file).write_bytes(b"fake-mp4")

        uploads_phase = {"flag": False}

        def cancel() -> bool:
            return uploads_phase["flag"]

        with patch.object(service, "_ensure_ffmpeg"), patch.object(
            service, "_export_clip_media", side_effect=fake_export
        ), patch.object(
            service, "_upload_clip_output", side_effect=lambda **k: ("k", "u")
        ), patch.object(
            service, "_sync_platform_video_url"
        ):
            real_submit = ThreadPoolExecutor.submit

            def flip_then_submit(self, fn, *a, **kw):
                uploads_phase["flag"] = True
                return real_submit(self, fn, *a, **kw)

            with patch.object(ThreadPoolExecutor, "submit", flip_then_submit):
                with pytest.raises(ExportCancelledError) as exc:
                    service.export_kept_clips(
                        state,
                        output_dir=str(out_dir),
                        operation="export_and_upload",
                        upload_parallel_files=2,
                        is_cancel_requested=cancel,
                    )

        # 1) Both locally-exported clips are in the touched set (the regression).
        assert exc.value.touched_clip_ids == {"clip_a", "clip_b"}

        # 2) Their progress is real: working state shows status=exported + a path.
        working_by_id = {c.id: c for c in state.candidate_clips}
        for cid in ("clip_a", "clip_b"):
            assert working_by_id[cid].status == "exported"
            assert working_by_id[cid].exported_path
            assert Path(working_by_id[cid].exported_path).exists()

        # 3) End-to-end: merging ONLY the touched set into a fresh latest_state
        #    (as the router cancel path does) preserves status=exported + path,
        #    instead of leaving them as kept with no exported_path.
        latest = ProjectState()
        latest.videos.append(_make_video())
        latest.candidate_clips.append(_make_clip(clip_id="clip_a", platform_record_id="rec_a"))
        latest.candidate_clips.append(_make_clip(clip_id="clip_b", platform_record_id="rec_b"))
        merged = merge_export_state(latest, state, exc.value.touched_clip_ids)
        merged_by_id = {c.id: c for c in merged.candidate_clips}
        for cid in ("clip_a", "clip_b"):
            assert merged_by_id[cid].status == "exported"
            assert merged_by_id[cid].exported_path == working_by_id[cid].exported_path


# ---------------------------------------------------------------------------
# 2b) half-written output cleanup on ffmpeg failure / timeout
# ---------------------------------------------------------------------------


class TestHalfWrittenOutputCleanup:
    def test_single_segment_failure_removes_partial_output(self, tmp_path: Path):
        service = _make_service()
        clip = _make_clip(review_start=0.0, review_end=5.0)
        output_file = tmp_path / "out.mp4"

        # Simulate ffmpeg writing a partial file then failing (e.g. timeout).
        def boom(cmd, timeout=None):
            output_file.write_bytes(b"half-written-garbage")
            raise RuntimeError("ffmpeg 导出超时（超过 15 秒）")

        with patch.object(service, "_run_ffmpeg", side_effect=boom):
            with pytest.raises(RuntimeError):
                service._export_clip_media(
                    video_path="/tmp/movie.mp4",
                    clip=clip,
                    output_file=output_file,
                    export_mode="standard",
                )
        # The corrupt partial file must be gone.
        assert not output_file.exists()

    def test_multi_segment_concat_failure_removes_partial_output(self, tmp_path: Path):
        from video_review_backend.models import ClipSegment

        service = _make_service()
        clip = _make_clip(review_start=0.0, review_end=20.0)
        clip.segments = [
            ClipSegment(id="s1", start=0.0, end=5.0),
            ClipSegment(id="s2", start=10.0, end=15.0),
        ]
        output_file = tmp_path / "out.mp4"
        calls = {"n": 0}

        def run(cmd, timeout=None):
            calls["n"] += 1
            # First two calls are the per-segment exports (into a temp dir);
            # the third is the concat into output_file -> fail after partial write.
            if calls["n"] >= 3:
                output_file.write_bytes(b"half-written-concat")
                raise RuntimeError("ffmpeg 导出失败")

        with patch.object(service, "_run_ffmpeg", side_effect=run):
            with pytest.raises(RuntimeError):
                service._export_clip_media(
                    video_path="/tmp/movie.mp4",
                    clip=clip,
                    output_file=output_file,
                    export_mode="standard",
                )
        assert not output_file.exists()

    def test_success_leaves_output_in_place(self, tmp_path: Path):
        service = _make_service()
        clip = _make_clip(review_start=0.0, review_end=5.0)
        output_file = tmp_path / "out.mp4"

        def run(cmd, timeout=None):
            output_file.write_bytes(b"complete-mp4")

        with patch.object(service, "_run_ffmpeg", side_effect=run):
            service._export_clip_media(
                video_path="/tmp/movie.mp4",
                clip=clip,
                output_file=output_file,
                export_mode="standard",
            )
        assert output_file.read_bytes() == b"complete-mp4"


# ---------------------------------------------------------------------------
# 3) lock-scope refactor — probe outside lock, import result unchanged
# ---------------------------------------------------------------------------


class TestProbeImportVideoInputs:
    def test_probes_supported_existing_files_only(self, tmp_path: Path):
        good = tmp_path / "a.mp4"
        good.write_bytes(b"x")
        missing = tmp_path / "missing.mp4"
        unsupported = tmp_path / "notes.txt"
        unsupported.write_bytes(b"x")

        with patch(
            "video_review_backend.video_import.probe_video_metadata", side_effect=_ffprobe_meta
        ):
            meta = probe_import_video_inputs([str(good), str(missing), str(unsupported)])

        assert str(good.resolve()) in meta
        assert str(missing.resolve()) not in meta
        assert str(unsupported.resolve()) not in meta

    def test_probe_failure_is_omitted(self, tmp_path: Path):
        good = tmp_path / "a.mp4"
        good.write_bytes(b"x")
        bad = tmp_path / "b.mp4"
        bad.write_bytes(b"x")

        def probe(path: str):
            if path == str(bad.resolve()):
                raise RuntimeError("ffprobe boom")
            return _ffprobe_meta(path)

        with patch("video_review_backend.video_import.probe_video_metadata", side_effect=probe):
            meta = probe_import_video_inputs([str(good), str(bad)])

        assert str(good.resolve()) in meta
        assert str(bad.resolve()) not in meta

    def test_import_uses_cached_metadata_without_reprobing(self, tmp_path: Path):
        video = tmp_path / "v.mp4"
        video.write_bytes(b"x")
        state = ProjectState()

        with patch(
            "video_review_backend.video_import.probe_video_metadata", side_effect=_ffprobe_meta
        ):
            meta = probe_import_video_inputs([str(video)])

        # With cached metadata supplied, the import must NOT call ffprobe again.
        with patch(
            "video_review_backend.video_import.probe_video_metadata",
            side_effect=AssertionError("ffprobe must not run under the lock"),
        ):
            imported = import_videos_into_project(
                state, [str(video)], metadata_by_path=meta
            )

        assert len(imported) == 1
        assert imported[0].duration == 30.0
        assert state.videos[0].id == imported[0].id

    def test_import_result_matches_legacy_path(self, tmp_path: Path):
        """Regression: same inputs, same imported videos with/without cache."""
        v1 = tmp_path / "1.mp4"
        v1.write_bytes(b"x")
        v2 = tmp_path / "2.mp4"
        v2.write_bytes(b"x")

        with patch(
            "video_review_backend.video_import.probe_video_metadata", side_effect=_ffprobe_meta
        ):
            legacy_state = ProjectState()
            legacy = import_videos_into_project(legacy_state, [str(v1), str(v2)])

            meta = probe_import_video_inputs([str(v1), str(v2)])
        cached_state = ProjectState()
        with patch(
            "video_review_backend.video_import.probe_video_metadata",
            side_effect=AssertionError("ffprobe must not run under the lock"),
        ):
            cached = import_videos_into_project(cached_state, [str(v1), str(v2)], metadata_by_path=meta)

        assert [v.file_path for v in legacy] == [v.file_path for v in cached]
        assert [v.duration for v in legacy] == [v.duration for v in cached]


# ---------------------------------------------------------------------------
# 4) storage temp-file leak
# ---------------------------------------------------------------------------


class TestSaveProjectStateTempLeak:
    def test_dump_failure_cleans_temp_and_preserves_original(self, tmp_path: Path):
        project_file = tmp_path / "project_state.json"
        # Seed a valid original file so we can prove it survives untouched.
        original = ProjectState()
        original.name = "ORIGINAL"
        save_project_state(project_file, original)
        original_bytes = project_file.read_bytes()

        before = set(tmp_path.iterdir())

        def boom(*args, **kwargs):
            raise RuntimeError("disk full mid-dump")

        with patch.object(storage_module.json, "dump", side_effect=boom):
            with pytest.raises(RuntimeError):
                save_project_state(project_file, ProjectState())

        after = set(tmp_path.iterdir())
        # No leftover NamedTemporaryFile.
        assert after == before
        # Original untouched.
        assert project_file.read_bytes() == original_bytes
        assert load_project_state(project_file).name == "ORIGINAL"

    def test_successful_save_round_trips(self, tmp_path: Path):
        project_file = tmp_path / "project_state.json"
        state = ProjectState()
        state.name = "测试项目"
        save_project_state(project_file, state)
        assert load_project_state(project_file).name == "测试项目"
        # Only the final file remains, no temp residue.
        assert {p.name for p in tmp_path.iterdir()} == {"project_state.json"}

    def test_fsync_called_before_replace(self, tmp_path: Path):
        """Durability: the temp file is fsync'd before the atomic replace."""
        project_file = tmp_path / "project_state.json"
        with patch.object(storage_module.os, "fsync") as mock_fsync:
            save_project_state(project_file, ProjectState())
        mock_fsync.assert_called_once()
        # File still written correctly.
        assert project_file.exists()
