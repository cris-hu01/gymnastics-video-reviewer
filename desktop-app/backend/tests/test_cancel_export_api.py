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
from video_review_backend.jobs import JobCancelledError


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
