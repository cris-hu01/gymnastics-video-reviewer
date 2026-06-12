"""HTTP contract for POST /api/project/cancel-export.

PR5 implemented the export cancellation primitives but never exposed an
endpoint, so the whole cancel path was dead code. These tests pin the wiring:
no active job -> 409; a running job -> 200 + cooperative cancel flag that the
runner observes and exits via JobCancelledError.
"""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from video_review_backend import api
from video_review_backend.deps import paths as deps_paths
from video_review_backend.deps import services as deps_services
from video_review_backend.deps.services import export_job_manager
from video_review_backend.export_service import ExportCancelledError
from video_review_backend.jobs import JobCancelledError
from video_review_backend.models import (
    CandidateClip,
    ClipSegment,
    PlatformScope,
    ProjectState,
    VideoTask,
)
from video_review_backend.routers import project as project_router
from video_review_backend.storage import save_project_state


@pytest.fixture
def client_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    project_file = tmp_path / "project_state.json"
    monkeypatch.setattr(deps_paths, "PROJECT_FILE", project_file)
    monkeypatch.setattr(deps_services, "_platform_client", None)
    monkeypatch.setattr(deps_services, "_export_service", None)
    with TestClient(api.app) as client:
        yield client


def _wait_until(predicate, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def test_cancel_export_without_active_job_returns_409(client_env):
    response = client_env.post("/api/project/cancel-export")
    assert response.status_code == 409
    assert "可取消" in response.json()["detail"]


def test_cancel_export_running_job_sets_flag_and_runner_exits(client_env):
    started = threading.Event()
    observed_cancel = threading.Event()

    def runner(progress_callback, is_cancel_requested):
        started.set()
        # Stay "running" until the cooperative cancel flag flips, mirroring the
        # real export runner's per-clip boundary check.
        while not is_cancel_requested():
            if not started.is_set():
                break
            time.sleep(0.02)
        observed_cancel.set()
        raise JobCancelledError()

    job = export_job_manager.start_job(
        kind="export",
        title="测试导出",
        runner=runner,
        initial_progress={"stage": "running", "total": 3},
    )
    assert _wait_until(started.is_set), "runner did not start"

    response = client_env.post("/api/project/cancel-export")
    assert response.status_code == 200
    body = response.json()
    assert body["message"] == "已请求取消导出任务"
    assert body["job"]["id"] == job.id

    # Runner observes the cooperative flag and raises -> job ends cancelled.
    assert _wait_until(observed_cancel.is_set), "runner never saw cancel flag"
    assert _wait_until(
        lambda: (export_job_manager.get_job(job.id) or job).status == "cancelled"
    ), "job did not reach cancelled status"


def test_cancel_export_queued_job_is_cancelled_outright(client_env):
    # Saturate the single export worker so the second job stays queued.
    block = threading.Event()
    first_started = threading.Event()

    def blocking_runner(progress_callback, is_cancel_requested):
        first_started.set()
        block.wait(timeout=5)
        return {}

    def queued_runner(progress_callback, is_cancel_requested):
        return {}

    first = export_job_manager.start_job(
        kind="export", title="占位导出", runner=blocking_runner,
        initial_progress={"stage": "running"},
    )
    assert _wait_until(first_started.is_set), "first job did not start"
    queued = export_job_manager.start_job(
        kind="export", title="排队导出", runner=queued_runner,
        initial_progress={"stage": "queued"},
    )

    try:
        response = client_env.post("/api/project/cancel-export")
        assert response.status_code == 200
        body = response.json()
        # The queued job is the cancellable one (running one can't future.cancel()).
        assert body["job"]["id"] == queued.id
        assert body["job"]["status"] == "cancelled"
        assert body["message"] == "已取消排队中的导出任务"
    finally:
        block.set()
        _wait_until(
            lambda: (export_job_manager.get_job(first.id) or first).status
            in {"completed", "failed", "cancelled"}
        )


def _make_kept_clip_state() -> ProjectState:
    """Minimal state with one kept clip — enough for the export endpoint to
    pass validation and reach the real runner."""
    return ProjectState(
        videos=[
            VideoTask(
                id="video_x",
                file_path="/tmp/video_x.mp4",
                file_name="video_x.mp4",
                source_kind="direct_clip",
                platform_scope_id="scope_x",
                status="reviewing",
                total_candidates=1,
                reviewed_candidates=1,
            )
        ],
        platform_scopes=[
            PlatformScope(id="scope_x", mode="direct_clip_batch", query_groups=[])
        ],
        candidate_clips=[
            CandidateClip(
                id="clip_x",
                video_id="video_x",
                candidate_start=0.0,
                candidate_end=5.0,
                review_start=0.0,
                review_end=5.0,
                subtitle_start=0.0,
                subtitle_end=5.0,
                segments=[ClipSegment(id="seg_x", start=0.0, end=5.0)],
                status="kept",
                confidence=1.0,
            )
        ],
    )


def test_real_runner_translates_export_cancel_to_cancelled_not_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """End-to-end closure of the synthetic-runner blind spot.

    Drives the REAL /api/project/export runner (routers/project.py) with a
    stubbed export service that raises ExportCancelledError, and asserts the job
    lands 'cancelled' — proving the ExportCancelledError -> JobCancelledError ->
    cancelled translation chain holds, NOT 'failed'.
    """
    project_file = tmp_path / "project_state.json"
    monkeypatch.setattr(deps_paths, "PROJECT_FILE", project_file)
    monkeypatch.setattr(deps_services, "_platform_client", None)
    monkeypatch.setattr(deps_services, "_export_service", None)
    save_project_state(project_file, _make_kept_clip_state())

    class _CancellingExportService:
        def export_kept_clips(self, *args, **kwargs):
            # Simulate the runner hitting a cancel boundary mid-export.
            raise ExportCancelledError("导出已取消", touched_clip_ids=set())

    monkeypatch.setattr(
        project_router, "get_export_service", lambda: _CancellingExportService()
    )

    with TestClient(api.app) as client:
        response = client.post(
            "/api/project/export",
            json={"output_dir": str(tmp_path / "out"), "operation": "export_only"},
        )
        assert response.status_code == 200
        job_id = response.json()["job"]["id"]

        def _terminal_status():
            resp = client.get(f"/api/jobs/{job_id}")
            if resp.status_code != 200:
                return None
            return resp.json()["job"]["status"]

        assert _wait_until(
            lambda: _terminal_status() in {"completed", "failed", "cancelled"}
        ), "export job never reached a terminal status"
        # The crux: real ExportCancelledError must surface as 'cancelled'.
        assert _terminal_status() == "cancelled"
