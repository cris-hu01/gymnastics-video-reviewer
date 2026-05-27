from __future__ import annotations

import logging
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from threading import RLock
from typing import Any, Callable

from .models import new_id, utc_now_iso


logger = logging.getLogger(__name__)


JobRunner = Callable[
    [Callable[[dict[str, Any]], None], Callable[[], bool]],
    dict[str, Any] | None,
]


class JobCancelledError(RuntimeError):
    pass


@dataclass
class AppJob:
    id: str
    kind: str
    title: str
    status: str = "queued"
    video_id: str | None = None
    created_at: str = field(default_factory=utc_now_iso)
    started_at: str | None = None
    finished_at: str | None = None
    progress: dict[str, Any] = field(default_factory=dict)
    result: dict[str, Any] = field(default_factory=dict)
    error_message: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class JobManager:
    def __init__(self, max_workers: int = 4) -> None:
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="gymclip-job")
        self._jobs: dict[str, AppJob] = {}
        self._futures: dict[str, Future[None]] = {}
        self._cancel_requests: dict[str, bool] = {}
        self._lock = RLock()

    def list_jobs(self) -> list[AppJob]:
        with self._lock:
            return sorted(
                (self._clone_job(job) for job in self._jobs.values()),
                key=lambda job: (job.created_at, job.id),
                reverse=True,
            )

    def get_job(self, job_id: str) -> AppJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return self._clone_job(job) if job else None

    def has_active_job(self, kind: str | None = None, video_id: str | None = None) -> bool:
        with self._lock:
            for job in self._jobs.values():
                if job.status not in {"queued", "running"}:
                    continue
                if kind is not None and job.kind != kind:
                    continue
                if video_id is not None and job.video_id != video_id:
                    continue
                return True
        return False

    def start_job(
        self,
        *,
        kind: str,
        title: str,
        runner: JobRunner,
        video_id: str | None = None,
        initial_progress: dict[str, Any] | None = None,
    ) -> AppJob:
        job = AppJob(
            id=new_id("job"),
            kind=kind,
            title=title,
            video_id=video_id,
            progress=initial_progress or {},
        )
        with self._lock:
            self._jobs[job.id] = job
            self._cancel_requests[job.id] = False
            future = self._executor.submit(self._run_job, job.id, runner)
            self._futures[job.id] = future
        logger.info("job submitted id=%s kind=%s video=%s", job.id, kind, video_id)
        return self._clone_job(job)

    def cancel_job(self, job_id: str) -> AppJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            future = self._futures.get(job_id)
            if job is None or future is None or job.status != "queued":
                return None
            if not future.cancel():
                return None

            cancelled_job = self._clone_job(job)
            cancelled_job.status = "cancelled"
            cancelled_job.finished_at = utc_now_iso()
            cancelled_job.progress = {
                **cancelled_job.progress,
                "stage": "cancelled",
                "message": "任务已取消",
            }
            self._jobs.pop(job_id, None)
            self._futures.pop(job_id, None)
            self._cancel_requests.pop(job_id, None)
            return cancelled_job

    def request_cancel(self, job_id: str) -> AppJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            if job.status == "queued":
                return self.cancel_job(job_id)
            if job.status != "running":
                return None

            self._cancel_requests[job_id] = True
            job.progress = {
                **job.progress,
                "stage": "cancel_requested",
                "message": "正在取消任务...",
            }
            return self._clone_job(job)

    def update_job(self, job_id: str, **changes: Any) -> AppJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None

            progress = changes.pop("progress", None)
            if progress:
                job.progress = {
                    **job.progress,
                    **progress,
                }
            for key, value in changes.items():
                setattr(job, key, value)
            return self._clone_job(job)

    def _run_job(self, job_id: str, runner: JobRunner) -> None:
        self.update_job(
            job_id,
            status="running",
            started_at=utc_now_iso(),
        )

        def progress_callback(progress: dict[str, Any]) -> None:
            self.update_job(
                job_id,
                progress=progress,
                error_message=None,
            )

        try:
            result = runner(progress_callback, lambda: self.is_cancel_requested(job_id)) or {}
        except JobCancelledError as e:
            logger.info("job cancelled id=%s reason=%s", job_id, e)
            self.update_job(
                job_id,
                status="cancelled",
                finished_at=utc_now_iso(),
                error_message=None,
                progress={"stage": "cancelled", "message": str(e) or "任务已取消"},
            )
        except Exception as e:
            logger.exception("job failed id=%s", job_id)
            self.update_job(
                job_id,
                status="failed",
                finished_at=utc_now_iso(),
                error_message=str(e),
                progress={"stage": "error", "message": str(e)},
            )
        else:
            logger.info("job completed id=%s", job_id)
            self.update_job(
                job_id,
                status="completed",
                finished_at=utc_now_iso(),
                result=result,
            )
        finally:
            with self._lock:
                self._futures.pop(job_id, None)
                self._cancel_requests.pop(job_id, None)

    def is_cancel_requested(self, job_id: str) -> bool:
        with self._lock:
            return self._cancel_requests.get(job_id, False)

    def _clone_job(self, job: AppJob | None) -> AppJob | None:
        if job is None:
            return None
        return AppJob(**job.to_dict())
