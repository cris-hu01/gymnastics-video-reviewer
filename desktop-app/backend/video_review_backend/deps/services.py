"""Lazy-singleton service registry.

Heavy services (DetectionService, ThumbnailService, PlatformClient, etc.) are
created on first use so that import time stays cheap. Tests that need to swap
implementations can call `reset_service_cache()` after monkeypatching.
"""
from __future__ import annotations

from threading import RLock
from typing import Any

from ..export_service import ExportService
from ..jobs import AppJob, JobManager
from ..platform_client import PlatformClient
from ..review_service import ReviewService
from ..thumbnail_service import ThumbnailService
from .paths import THUMBNAILS_DIR


# ---------------------------------------------------------------------------
# Eager singletons (cheap to create).
# ---------------------------------------------------------------------------
review_service: ReviewService = ReviewService()


# ---------------------------------------------------------------------------
# Job managers (created eagerly; have their own threadpools).
# ---------------------------------------------------------------------------
def resolve_detect_parallelism() -> int:
    return 1


detect_job_manager: JobManager = JobManager(max_workers=resolve_detect_parallelism())
export_job_manager: JobManager = JobManager(max_workers=1)


# ---------------------------------------------------------------------------
# Lazy service singletons.
# ---------------------------------------------------------------------------
_detection_service: Any = None
_export_service: ExportService | None = None
_thumbnail_service: ThumbnailService | None = None
_platform_client: PlatformClient | None = None


def get_detection_service():
    global _detection_service
    if _detection_service is None:
        from ..detection_service import DetectionService

        _detection_service = DetectionService()
    return _detection_service


def get_export_service() -> ExportService:
    global _export_service
    if _export_service is None:
        _export_service = ExportService()
    return _export_service


def get_thumbnail_service() -> ThumbnailService:
    global _thumbnail_service
    if _thumbnail_service is None:
        _thumbnail_service = ThumbnailService(THUMBNAILS_DIR)
    return _thumbnail_service


def get_platform_client() -> PlatformClient:
    global _platform_client
    if _platform_client is None:
        _platform_client = PlatformClient()
    return _platform_client


def reset_service_cache() -> None:
    """Drop all lazy-init singletons. Intended for tests."""
    global _detection_service, _export_service, _thumbnail_service, _platform_client
    _detection_service = None
    _export_service = None
    _thumbnail_service = None
    _platform_client = None


# ---------------------------------------------------------------------------
# Preview-scope cache (shared between platform router and direct-clip import).
# ---------------------------------------------------------------------------
PREVIEW_SCOPE_CACHE_TTL_SECONDS: int = 600
_preview_scope_cache_lock: RLock = RLock()
_preview_scope_cache: dict[str, dict[str, Any]] = {}


def preview_scope_cache_lock() -> RLock:
    return _preview_scope_cache_lock


def preview_scope_cache() -> dict[str, dict[str, Any]]:
    return _preview_scope_cache


# ---------------------------------------------------------------------------
# Job lookup helpers (multi-manager fan-out).
# ---------------------------------------------------------------------------
def list_all_jobs() -> list[AppJob]:
    jobs = [
        *detect_job_manager.list_jobs(),
        *export_job_manager.list_jobs(),
    ]
    return sorted(jobs, key=lambda job: (job.created_at, job.id), reverse=True)


def get_job_by_id(job_id: str) -> AppJob | None:
    for manager in (detect_job_manager, export_job_manager):
        job = manager.get_job(job_id)
        if job is not None:
            return job
    return None


def has_active_job(kind: str | None = None, video_id: str | None = None) -> bool:
    if kind == "detect":
        managers = [detect_job_manager]
    elif kind == "export":
        managers = [export_job_manager]
    else:
        managers = [detect_job_manager, export_job_manager]
    return any(manager.has_active_job(kind=kind, video_id=video_id) for manager in managers)
