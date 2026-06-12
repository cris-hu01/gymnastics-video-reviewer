"""Concurrency / cancellation tests for ``JobManager`` (video_review_backend.jobs).

The job manager had zero direct coverage. These tests pin down the runtime
mechanics that the export/detect cancel chains rely on:

* ``cancel_job`` only cancels a *queued* future (``future.cancel()`` succeeds
  before the worker picks it up); once running, it returns ``None``.
* ``request_cancel`` routes ``queued`` -> ``cancel_job`` and ``running`` -> set
  the cooperative cancel flag (``is_cancel_requested`` returns True).
* ``_run_job`` three-way terminal status: a clean return -> ``completed``, a
  ``JobCancelledError`` -> ``cancelled``, any other exception -> ``failed``.
* The cancel/complete race is resolved deterministically: a runner that ignores
  the cancel flag and returns normally still ends ``completed`` even if a cancel
  was requested mid-flight.
* Independent jobs do not interfere: cancelling one leaves the others alone.

Determinism is built with ``threading.Event``/``Barrier`` — no ``sleep``-based
timing bets. A single shared worker (``max_workers=1``) is used where queue
ordering matters so the second submission is provably still ``queued``.
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from video_review_backend.jobs import JobCancelledError, JobManager


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def manager():
    """A 2-worker manager, cleanly shut down after each test."""
    mgr = JobManager(max_workers=2)
    yield mgr
    mgr._executor.shutdown(wait=True)


@pytest.fixture
def single_worker_manager():
    """A 1-worker manager so a second submission is provably still queued."""
    mgr = JobManager(max_workers=1)
    yield mgr
    mgr._executor.shutdown(wait=True)


def _wait(event: threading.Event, timeout: float = 5.0) -> None:
    assert event.wait(timeout), "timed out waiting for job synchronization event"


def _wait_for_status(mgr: JobManager, job_id: str, status: str, timeout: float = 5.0) -> None:
    """Poll the (in-memory) job until it reaches ``status``.

    Used only to observe a terminal state that the worker thread sets; the
    worker progress itself is gated by Events, so this never races forward.
    """
    deadline = threading.Event()
    timer = threading.Timer(timeout, deadline.set)
    timer.start()
    try:
        while not deadline.is_set():
            job = mgr.get_job(job_id)
            if job is not None and job.status == status:
                return
        job = mgr.get_job(job_id)
        raise AssertionError(
            f"job {job_id} did not reach status={status!r}; "
            f"last status={getattr(job, 'status', None)!r}"
        )
    finally:
        timer.cancel()


# ---------------------------------------------------------------------------
# 1) queued-state cancellation
# ---------------------------------------------------------------------------


class TestCancelQueuedJob:
    def test_cancel_queued_job_removes_it_and_reports_cancelled(self, single_worker_manager):
        """A job still in the queue (worker busy on another) cancels cleanly."""
        mgr = single_worker_manager
        block_first = threading.Event()
        first_running = threading.Event()

        def first_runner(progress, is_cancel_requested):
            first_running.set()
            _wait(block_first)
            return {}

        def second_runner(progress, is_cancel_requested):  # pragma: no cover - never runs
            raise AssertionError("queued job must never start after cancellation")

        first = mgr.start_job(kind="detect", title="first", runner=first_runner)
        _wait(first_running)  # single worker is now busy -> next job stays queued

        queued = mgr.start_job(kind="detect", title="second", runner=second_runner)
        assert mgr.get_job(queued.id).status == "queued"

        cancelled = mgr.cancel_job(queued.id)
        assert cancelled is not None
        assert cancelled.status == "cancelled"
        assert cancelled.finished_at is not None
        assert cancelled.progress["stage"] == "cancelled"

        # Cancelled queued job is dropped from the registry entirely.
        assert mgr.get_job(queued.id) is None

        block_first.set()
        _wait_for_status(mgr, first.id, "completed")

    def test_request_cancel_on_queued_routes_to_cancel_job(self, single_worker_manager):
        mgr = single_worker_manager
        block_first = threading.Event()
        first_running = threading.Event()

        def first_runner(progress, is_cancel_requested):
            first_running.set()
            _wait(block_first)
            return {}

        def second_runner(progress, is_cancel_requested):  # pragma: no cover
            raise AssertionError("queued job must never start")

        first = mgr.start_job(kind="detect", title="first", runner=first_runner)
        _wait(first_running)
        queued = mgr.start_job(kind="detect", title="second", runner=second_runner)

        result = mgr.request_cancel(queued.id)
        assert result is not None
        assert result.status == "cancelled"
        assert mgr.get_job(queued.id) is None

        block_first.set()
        _wait_for_status(mgr, first.id, "completed")

    def test_cancel_unknown_job_returns_none(self, manager):
        assert manager.cancel_job("job_does_not_exist") is None
        assert manager.request_cancel("job_does_not_exist") is None


# ---------------------------------------------------------------------------
# 2) running-state cancellation (cooperative flag)
# ---------------------------------------------------------------------------


class TestCancelRunningJob:
    def test_request_cancel_running_sets_cooperative_flag(self, manager):
        """A running job can only be cancelled cooperatively: request_cancel
        flips is_cancel_requested, the runner observes it and raises."""
        mgr = manager
        running = threading.Event()
        may_check_cancel = threading.Event()
        observed: dict[str, bool] = {}

        def runner(progress, is_cancel_requested):
            running.set()
            _wait(may_check_cancel)
            observed["cancel"] = is_cancel_requested()
            if is_cancel_requested():
                raise JobCancelledError("任务已取消")
            return {}

        job = mgr.start_job(kind="export", title="cancelable", runner=runner)
        _wait(running)

        # cancel_job alone must NOT cancel a running job (future already started).
        assert mgr.cancel_job(job.id) is None

        updated = mgr.request_cancel(job.id)
        assert updated is not None
        assert updated.status == "running"  # still running; cancel is cooperative
        assert updated.progress["stage"] == "cancel_requested"
        assert mgr.is_cancel_requested(job.id) is True

        may_check_cancel.set()
        _wait_for_status(mgr, job.id, "cancelled")

        assert observed["cancel"] is True
        final = mgr.get_job(job.id)
        assert final.status == "cancelled"
        assert final.finished_at is not None

    def test_running_job_not_cancelled_keeps_running_flag_false(self, manager):
        """Sanity: with no cancel request, is_cancel_requested stays False."""
        mgr = manager
        running = threading.Event()
        may_finish = threading.Event()
        observed: dict[str, bool] = {}

        def runner(progress, is_cancel_requested):
            running.set()
            _wait(may_finish)
            observed["cancel"] = is_cancel_requested()
            return {}

        job = mgr.start_job(kind="export", title="job", runner=runner)
        _wait(running)
        may_finish.set()
        _wait_for_status(mgr, job.id, "completed")
        assert observed["cancel"] is False


# ---------------------------------------------------------------------------
# 3) _run_job three-way terminal status
# ---------------------------------------------------------------------------


class TestRunJobTerminalStatus:
    def test_clean_return_marks_completed_and_stores_result(self, manager):
        mgr = manager

        def runner(progress, is_cancel_requested):
            return {"final_count": 7}

        job = mgr.start_job(kind="detect", title="ok", runner=runner)
        _wait_for_status(mgr, job.id, "completed")

        final = mgr.get_job(job.id)
        assert final.status == "completed"
        assert final.result == {"final_count": 7}
        assert final.error_message is None
        assert final.finished_at is not None

    def test_none_return_completes_with_empty_result(self, manager):
        mgr = manager

        def runner(progress, is_cancel_requested):
            return None

        job = mgr.start_job(kind="detect", title="ok-none", runner=runner)
        _wait_for_status(mgr, job.id, "completed")
        assert mgr.get_job(job.id).result == {}

    def test_job_cancelled_error_marks_cancelled(self, manager):
        mgr = manager

        def runner(progress, is_cancel_requested):
            raise JobCancelledError("用户取消")

        job = mgr.start_job(kind="export", title="cancel", runner=runner)
        _wait_for_status(mgr, job.id, "cancelled")

        final = mgr.get_job(job.id)
        assert final.status == "cancelled"
        assert final.error_message is None  # cancellation is not an error
        assert final.progress["stage"] == "cancelled"
        assert "用户取消" in final.progress["message"]

    def test_other_exception_marks_failed_with_message(self, manager):
        mgr = manager

        def runner(progress, is_cancel_requested):
            raise ValueError("boom")

        job = mgr.start_job(kind="export", title="fail", runner=runner)
        _wait_for_status(mgr, job.id, "failed")

        final = mgr.get_job(job.id)
        assert final.status == "failed"
        assert final.error_message == "boom"
        assert final.progress["stage"] == "error"
        assert "boom" in final.progress["message"]

    def test_completed_job_drops_future_and_cancel_state(self, manager):
        """After terminal status, cancel/future bookkeeping is cleaned up so a
        late request_cancel cannot resurrect the job."""
        mgr = manager
        done = threading.Event()

        def runner(progress, is_cancel_requested):
            return {}

        job = mgr.start_job(kind="detect", title="cleanup", runner=runner)
        _wait_for_status(mgr, job.id, "completed")
        done.set()

        # internal bookkeeping cleared
        assert job.id not in mgr._futures
        assert job.id not in mgr._cancel_requests
        # a late cancel on a finished job is a no-op (not queued, not running)
        assert mgr.request_cancel(job.id) is None
        assert mgr.get_job(job.id).status == "completed"


# ---------------------------------------------------------------------------
# 4) cancel / complete race
# ---------------------------------------------------------------------------


class TestCancelCompleteRace:
    def test_cancel_requested_but_runner_ignores_it_still_completes(self, manager):
        """Deterministic race: a cancel is requested while the job is running,
        but the runner ignores the flag and returns normally. The terminal
        status follows what the runner actually did -> completed, never a
        spurious 'cancelled'. The cancel flag is torn down regardless."""
        mgr = manager
        running = threading.Event()
        cancel_done = threading.Event()

        def runner(progress, is_cancel_requested):
            running.set()
            # Wait until the cancel has definitely been registered, then ignore
            # it and return cleanly -> the race resolves to 'completed'.
            _wait(cancel_done)
            return {"ignored_cancel": True}

        job = mgr.start_job(kind="export", title="ignore-cancel", runner=runner)
        _wait(running)

        updated = mgr.request_cancel(job.id)
        assert updated.status == "running"
        assert mgr.is_cancel_requested(job.id) is True
        cancel_done.set()

        _wait_for_status(mgr, job.id, "completed")
        final = mgr.get_job(job.id)
        assert final.status == "completed"
        assert final.result == {"ignored_cancel": True}
        # cooperative flag cleaned up by the finally block
        assert job.id not in mgr._cancel_requests
        assert mgr.is_cancel_requested(job.id) is False

    def test_cancel_after_completion_does_not_revive_job(self, manager):
        """If completion wins the race, a subsequent request_cancel is a no-op
        and the status stays 'completed'."""
        mgr = manager
        may_finish = threading.Event()
        running = threading.Event()

        def runner(progress, is_cancel_requested):
            running.set()
            _wait(may_finish)
            return {}

        job = mgr.start_job(kind="detect", title="race", runner=runner)
        _wait(running)
        may_finish.set()
        _wait_for_status(mgr, job.id, "completed")

        # Completion already won; cancel arrives late.
        assert mgr.request_cancel(job.id) is None
        assert mgr.get_job(job.id).status == "completed"


# ---------------------------------------------------------------------------
# 5) concurrent independent jobs
# ---------------------------------------------------------------------------


class TestConcurrentJobs:
    def test_cancel_one_does_not_affect_others(self, manager):
        """Two jobs run concurrently (2 workers). Cancelling one must leave the
        other to finish normally."""
        mgr = manager
        both_running = threading.Barrier(2, timeout=5.0)
        keep_a = threading.Event()
        a_observed: dict[str, bool] = {}

        def runner_a(progress, is_cancel_requested):
            both_running.wait()
            _wait(keep_a)
            a_observed["cancel"] = is_cancel_requested()
            if is_cancel_requested():
                raise JobCancelledError("a cancelled")
            return {}

        def runner_b(progress, is_cancel_requested):
            both_running.wait()
            # B is independent: it never sees a cancel request.
            assert is_cancel_requested() is False
            return {"who": "b"}

        job_a = mgr.start_job(kind="export", title="a", runner=runner_a)
        job_b = mgr.start_job(kind="export", title="b", runner=runner_b)

        # B finishes on its own; cancelling A must not have touched B.
        _wait_for_status(mgr, job_b.id, "completed")
        assert mgr.get_job(job_b.id).result == {"who": "b"}
        assert mgr.is_cancel_requested(job_a.id) is False

        mgr.request_cancel(job_a.id)
        assert mgr.is_cancel_requested(job_a.id) is True
        assert mgr.is_cancel_requested(job_b.id) is False  # B unaffected
        keep_a.set()

        _wait_for_status(mgr, job_a.id, "cancelled")
        assert a_observed["cancel"] is True
        assert mgr.get_job(job_b.id).status == "completed"

    def test_has_active_job_tracks_queued_and_running(self, single_worker_manager):
        """has_active_job reflects queued+running jobs and filters by kind/video."""
        mgr = single_worker_manager
        running = threading.Event()
        may_finish = threading.Event()

        def runner(progress, is_cancel_requested):
            running.set()
            _wait(may_finish)
            return {}

        def queued_runner(progress, is_cancel_requested):  # pragma: no cover
            _wait(may_finish)
            return {}

        job = mgr.start_job(kind="detect", title="r", runner=runner, video_id="vid_1")
        _wait(running)
        mgr.start_job(kind="export", title="q", runner=queued_runner, video_id="vid_2")

        assert mgr.has_active_job() is True
        assert mgr.has_active_job(kind="detect") is True
        assert mgr.has_active_job(kind="export") is True
        assert mgr.has_active_job(video_id="vid_1") is True
        assert mgr.has_active_job(kind="detect", video_id="vid_2") is False

        may_finish.set()
        _wait_for_status(mgr, job.id, "completed")

    def test_list_jobs_returns_independent_clones(self, manager):
        """list_jobs/get_job hand back clones; mutating one must not corrupt the
        manager's internal state (defensive copy)."""
        mgr = manager
        may_finish = threading.Event()
        running = threading.Event()

        def runner(progress, is_cancel_requested):
            running.set()
            _wait(may_finish)
            return {}

        job = mgr.start_job(kind="detect", title="clone", runner=runner)
        _wait(running)

        snapshot = mgr.get_job(job.id)
        snapshot.status = "TAMPERED"
        snapshot.progress["injected"] = True

        fresh = mgr.get_job(job.id)
        assert fresh.status == "running"
        assert "injected" not in fresh.progress

        may_finish.set()
        _wait_for_status(mgr, job.id, "completed")
