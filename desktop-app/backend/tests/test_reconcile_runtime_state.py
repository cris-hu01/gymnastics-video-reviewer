"""Restart-recovery tests for ``reconcile_runtime_state`` and its helpers.

On backend restart the persisted ProjectState may contain *runtime* state that
no longer matches reality: a job that was ``detecting`` when the app crashed, or
a source video whose file has since moved. ``reconcile_runtime_state`` re-derives
a consistent state. This path was previously untested.

Two independent reconcilers run:

* ``reconcile_video_sources`` — source file gone -> status ``error`` +
  "源视频文件不存在"; file back -> clear the error and re-derive a live status.
* ``reconcile_stale_detection_state`` — a video stuck mid-detection with NO
  active detect job (the job died with the process) -> restore it to a
  consistent status derived from its clips, with a 'interrupted' progress stage.

The detect-job liveness check reads the module-level ``detect_job_manager``
singleton, so tests patch ``state_helpers.detect_job_manager.list_jobs`` to
inject the "what jobs survived the restart" set deterministically. File presence
uses real files under ``tmp_path`` — no mocking of the filesystem.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from video_review_backend.deps import state_helpers
from video_review_backend.deps.state_helpers import (
    reconcile_runtime_state,
    reconcile_stale_detection_state,
    reconcile_video_sources,
)
from video_review_backend.jobs import AppJob
from video_review_backend.models import CandidateClip, ProjectState, VideoTask


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _video(
    *,
    video_id: str = "video_1",
    file_path: str = "/nonexistent/movie.mp4",
    status: str = "queued",
    error_message: str | None = None,
    total_candidates: int = 0,
    detection_progress: dict | None = None,
) -> VideoTask:
    return VideoTask(
        id=video_id,
        file_path=file_path,
        file_name=Path(file_path).name,
        status=status,
        error_message=error_message,
        total_candidates=total_candidates,
        detection_progress=detection_progress or {},
    )


def _clip(video_id: str, clip_id: str, status: str) -> CandidateClip:
    return CandidateClip(id=clip_id, video_id=video_id, status=status)


def _detect_job(video_id: str, status: str) -> AppJob:
    return AppJob(id=f"job_{video_id}", kind="detect", title="detect", status=status, video_id=video_id)


@pytest.fixture
def no_active_jobs():
    """Patch the detect-job singleton to report zero surviving jobs."""
    with patch.object(state_helpers.detect_job_manager, "list_jobs", return_value=[]):
        yield


def _with_active_jobs(jobs):
    return patch.object(state_helpers.detect_job_manager, "list_jobs", return_value=jobs)


# ---------------------------------------------------------------------------
# 1) reconcile_video_sources
# ---------------------------------------------------------------------------


class TestReconcileVideoSources:
    def test_missing_file_marks_video_error(self):
        state = ProjectState()
        state.videos.append(_video(status="ready_for_review", file_path="/gone/x.mp4"))

        changed = reconcile_video_sources(state)

        assert changed is True
        v = state.videos[0]
        assert v.status == "error"
        assert v.error_message == "源视频文件不存在"

    def test_returning_file_with_no_candidates_resets_to_queued(self, tmp_path: Path):
        movie = tmp_path / "movie.mp4"
        movie.write_bytes(b"x")
        state = ProjectState()
        state.videos.append(
            _video(
                file_path=str(movie),
                status="error",
                error_message="源视频文件不存在",
                total_candidates=0,
            )
        )

        changed = reconcile_video_sources(state)

        assert changed is True
        v = state.videos[0]
        assert v.error_message is None
        assert v.status == "queued"

    def test_returning_file_with_candidates_resets_to_ready_for_review(self, tmp_path: Path):
        movie = tmp_path / "movie.mp4"
        movie.write_bytes(b"x")
        state = ProjectState()
        state.videos.append(
            _video(
                file_path=str(movie),
                status="error",
                error_message="源视频文件不存在",
                total_candidates=5,
            )
        )

        reconcile_video_sources(state)
        assert state.videos[0].status == "ready_for_review"

    def test_existing_file_already_clean_is_noop(self, tmp_path: Path):
        movie = tmp_path / "movie.mp4"
        movie.write_bytes(b"x")
        state = ProjectState()
        state.videos.append(_video(file_path=str(movie), status="reviewing"))

        changed = reconcile_video_sources(state)

        assert changed is False
        assert state.videos[0].status == "reviewing"

    def test_already_errored_missing_file_is_noop(self):
        state = ProjectState()
        state.videos.append(
            _video(status="error", error_message="源视频文件不存在", file_path="/gone.mp4")
        )
        # Already in the correct error state -> no further change.
        assert reconcile_video_sources(state) is False


# ---------------------------------------------------------------------------
# 2) reconcile_stale_detection_state
# ---------------------------------------------------------------------------


class TestReconcileStaleDetection:
    def test_detecting_video_without_active_job_is_restored(self, no_active_jobs):
        """The crash case: video stuck 'detecting', its job gone -> restored."""
        state = ProjectState()
        state.videos.append(
            _video(
                status="detecting",
                detection_progress={"stage": "detecting", "message": "AI 检测中"},
            )
        )

        changed = reconcile_stale_detection_state(state)

        assert changed is True
        v = state.videos[0]
        # No clips -> back to queued, with an 'interrupted' marker.
        assert v.status == "queued"
        assert v.detection_progress["stage"] == "interrupted"
        assert "中断" in v.detection_progress["message"]

    def test_recoverable_stage_without_active_job_is_restored(self, no_active_jobs):
        """Even if status isn't literally 'detecting', a recoverable progress
        stage with no live job is treated as interrupted."""
        state = ProjectState()
        state.videos.append(
            _video(status="reviewing", detection_progress={"stage": "extracting"})
        )
        # 'extracting' is NOT in the recoverable set; must be left alone.
        assert reconcile_stale_detection_state(state) is False
        assert state.videos[0].status == "reviewing"

    def test_cancel_requested_stage_is_recoverable(self, no_active_jobs):
        state = ProjectState()
        state.videos.append(
            _video(status="reviewing", detection_progress={"stage": "cancel_requested"})
        )
        assert reconcile_stale_detection_state(state) is True
        assert state.videos[0].detection_progress["stage"] == "interrupted"

    def test_detecting_video_with_live_job_is_left_running(self):
        """If the detect job actually survived (queued/running), do not disturb
        the in-flight video."""
        state = ProjectState()
        state.videos.append(_video(status="detecting", detection_progress={"stage": "detecting"}))

        with _with_active_jobs([_detect_job("video_1", "running")]):
            changed = reconcile_stale_detection_state(state)

        assert changed is False
        assert state.videos[0].status == "detecting"

    def test_status_derived_from_clip_counts_on_restore(self, no_active_jobs):
        """Restore must re-derive status from the clips that DID get persisted:
        all pending -> ready_for_review; some kept/pending -> reviewing."""
        state = ProjectState()
        state.videos.append(_video(status="detecting", detection_progress={"stage": "detecting"}))
        state.candidate_clips.append(_clip("video_1", "c1", "pending"))
        state.candidate_clips.append(_clip("video_1", "c2", "pending"))

        reconcile_stale_detection_state(state)
        v = state.videos[0]
        assert v.status == "ready_for_review"
        assert v.total_candidates == 2
        assert v.reviewed_candidates == 0

    def test_partially_reviewed_restores_to_reviewing(self, no_active_jobs):
        state = ProjectState()
        state.videos.append(_video(status="detecting", detection_progress={"stage": "detecting"}))
        state.candidate_clips.append(_clip("video_1", "c1", "kept"))
        state.candidate_clips.append(_clip("video_1", "c2", "pending"))

        reconcile_stale_detection_state(state)
        v = state.videos[0]
        assert v.status == "reviewing"
        assert v.reviewed_candidates == 1  # the kept clip

    def test_other_videos_active_job_does_not_protect_this_one(self, no_active_jobs):
        """A live job for a *different* video must not shield this stale one."""
        state = ProjectState()
        state.videos.append(_video(video_id="video_stale", status="detecting",
                                   detection_progress={"stage": "detecting"}))
        with _with_active_jobs([_detect_job("video_other", "running")]):
            changed = reconcile_stale_detection_state(state)
        assert changed is True
        assert state.videos[0].status == "queued"


# ---------------------------------------------------------------------------
# 3) reconcile_runtime_state (composed)
# ---------------------------------------------------------------------------


class TestReconcileRuntimeState:
    def test_composes_both_reconcilers(self, tmp_path: Path, no_active_jobs):
        """One video with a missing file, one stuck detecting: a single
        reconcile_runtime_state call fixes both and reports changed=True."""
        state = ProjectState()
        state.videos.append(
            _video(video_id="video_missing", file_path="/gone.mp4", status="ready_for_review")
        )
        good = tmp_path / "good.mp4"
        good.write_bytes(b"x")
        state.videos.append(
            _video(
                video_id="video_stuck",
                file_path=str(good),
                status="detecting",
                detection_progress={"stage": "detecting"},
            )
        )

        changed = reconcile_runtime_state(state)

        assert changed is True
        missing = state.get_video("video_missing")
        stuck = state.get_video("video_stuck")
        assert missing.status == "error"
        assert missing.error_message == "源视频文件不存在"
        assert stuck.status == "queued"
        assert stuck.detection_progress["stage"] == "interrupted"

    def test_clean_state_reports_no_change(self, tmp_path: Path, no_active_jobs):
        movie = tmp_path / "m.mp4"
        movie.write_bytes(b"x")
        state = ProjectState()
        state.videos.append(_video(file_path=str(movie), status="reviewing"))

        assert reconcile_runtime_state(state) is False
        assert state.videos[0].status == "reviewing"
