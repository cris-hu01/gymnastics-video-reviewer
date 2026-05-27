"""State reconciliation, merging, and serialization helpers.

These functions are used by multiple routers; living in `deps` avoids
cross-router imports.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from ..models import ProjectState, utc_now_iso
from .services import detect_job_manager, list_all_jobs


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Serialization helpers.
# ---------------------------------------------------------------------------
def project_payload(state: ProjectState) -> dict[str, Any]:
    return state.to_dict()


def jobs_payload() -> list[dict[str, Any]]:
    return [job.to_dict() for job in list_all_jobs()]


# ---------------------------------------------------------------------------
# Reconciliation: re-derive runtime state from disk state after restarts.
# ---------------------------------------------------------------------------
def reconcile_video_sources(state: ProjectState) -> bool:
    changed = False
    for video in state.videos:
        path = Path(video.file_path)
        if path.exists():
            if video.error_message == "源视频文件不存在":
                video.error_message = None
                if video.status == "error":
                    video.status = "queued" if video.total_candidates == 0 else "ready_for_review"
                video.updated_at = utc_now_iso()
                changed = True
            continue

        if video.error_message != "源视频文件不存在" or video.status != "error":
            video.error_message = "源视频文件不存在"
            video.status = "error"
            video.updated_at = utc_now_iso()
            changed = True

    if changed:
        state.touch()
    return changed


def restore_video_after_interrupted_detection(
    state: ProjectState, video_id: str, message: str
) -> None:
    video = state.get_video(video_id)
    if video is None:
        return

    clips = state.get_video_clips(video_id)
    total = len(clips)
    reviewed = sum(1 for clip in clips if clip.status != "pending")
    pending = sum(1 for clip in clips if clip.status == "pending")
    kept = sum(1 for clip in clips if clip.status == "kept")
    exported = sum(1 for clip in clips if clip.status == "exported")

    video.total_candidates = total
    video.reviewed_candidates = reviewed
    video.error_message = None
    video.detection_progress = {
        "stage": "interrupted",
        "message": message,
    }
    if total == 0:
        video.status = "queued"
    elif pending == total:
        video.status = "ready_for_review"
    elif pending > 0 or kept > 0:
        video.status = "reviewing"
    elif exported > 0 and exported == total:
        video.status = "done"
    else:
        video.status = "done"
    video.updated_at = utc_now_iso()
    state.touch()


def reconcile_stale_detection_state(state: ProjectState) -> bool:
    active_detect_video_ids = {
        job.video_id
        for job in detect_job_manager.list_jobs()
        if job.kind == "detect" and job.status in {"queued", "running"} and job.video_id
    }
    recoverable_stages = {"start", "precheck_complete", "detecting", "cancel_requested"}
    changed = False

    for video in state.videos:
        stage = str(video.detection_progress.get("stage") or "")
        if video.id in active_detect_video_ids:
            continue
        if video.status != "detecting" and stage not in recoverable_stages:
            continue

        restore_video_after_interrupted_detection(
            state,
            video.id,
            "检测任务因应用异常退出而中断，请重新开始",
        )
        changed = True

    return changed


def reconcile_runtime_state(state: ProjectState) -> bool:
    """Re-derive video and job state after a backend restart."""
    changed = reconcile_video_sources(state)
    if reconcile_stale_detection_state(state):
        changed = True
    return changed


# ---------------------------------------------------------------------------
# Progress updates / cancel restoration.
# ---------------------------------------------------------------------------
def update_video_progress(state: ProjectState, video_id: str, progress: dict[str, Any]) -> None:
    video = state.get_video(video_id)
    if video is None:
        return
    video.detection_progress = {
        **video.detection_progress,
        **progress,
    }
    if progress.get("stage") == "start":
        video.status = "detecting"
    video.updated_at = utc_now_iso()
    state.touch()


def restore_video_after_detection_cancel(
    state: ProjectState, video_id: str, message: str
) -> None:
    video = state.get_video(video_id)
    if video is None:
        return

    clips = state.get_video_clips(video_id)
    total = len(clips)
    reviewed = sum(1 for clip in clips if clip.status != "pending")
    pending = sum(1 for clip in clips if clip.status == "pending")
    kept = sum(1 for clip in clips if clip.status == "kept")
    exported = sum(1 for clip in clips if clip.status == "exported")

    video.total_candidates = total
    video.reviewed_candidates = reviewed
    video.error_message = None
    video.detection_progress = {
        "stage": "cancelled",
        "message": message,
    }
    if total == 0:
        video.status = "queued"
    elif pending == total:
        video.status = "ready_for_review"
    elif pending > 0 or kept > 0:
        video.status = "reviewing"
    elif exported > 0 and exported == total:
        video.status = "done"
    else:
        video.status = "done"
    video.updated_at = utc_now_iso()
    state.touch()


# ---------------------------------------------------------------------------
# Merge helpers used by long-running job runners.
# ---------------------------------------------------------------------------
def merge_detect_video_state(
    latest_state: ProjectState,
    working_state: ProjectState,
    video_id: str,
) -> ProjectState:
    latest_video = latest_state.get_video(video_id)
    working_video = working_state.get_video(video_id)
    if latest_video is None or working_video is None:
        return latest_state

    latest_state.detection_blocks = [
        block for block in latest_state.detection_blocks if block.video_id != video_id
    ]
    latest_state.candidate_clips = [
        clip for clip in latest_state.candidate_clips if clip.video_id != video_id
    ]
    latest_video.file_path = working_video.file_path
    latest_video.file_name = working_video.file_name
    latest_video.source_kind = working_video.source_kind
    latest_video.platform_scope_id = working_video.platform_scope_id
    latest_video.match_id = working_video.match_id
    latest_video.match_name = working_video.match_name
    latest_video.frequency_info_id = working_video.frequency_info_id
    latest_video.frequency_info_ids = list(working_video.frequency_info_ids)
    latest_video.venue = working_video.venue
    latest_video.venues = list(working_video.venues)
    latest_video.category = working_video.category
    latest_video.sex = working_video.sex
    latest_video.sport_selection_keys = list(working_video.sport_selection_keys)
    latest_video.sport_item_ids = list(working_video.sport_item_ids)
    latest_video.team_country = working_video.team_country
    latest_video.duration = working_video.duration
    latest_video.resolution = working_video.resolution
    latest_video.status = working_video.status
    latest_video.total_candidates = working_video.total_candidates
    latest_video.reviewed_candidates = working_video.reviewed_candidates
    latest_video.error_message = working_video.error_message
    latest_video.detection_stats = dict(working_video.detection_stats)
    latest_video.detection_progress = dict(working_video.detection_progress)
    latest_video.updated_at = working_video.updated_at
    latest_state.upsert_platform_query_context(latest_video)

    latest_state.detection_blocks.extend(
        [block for block in working_state.detection_blocks if block.video_id == video_id]
    )
    latest_state.candidate_clips.extend(
        [clip for clip in working_state.candidate_clips if clip.video_id == video_id]
    )
    latest_state.rebuild_platform_record_links()
    latest_state.touch()
    return latest_state


def merge_export_state(
    latest_state: ProjectState,
    working_state: ProjectState,
    clip_ids: set[str],
) -> ProjectState:
    if not clip_ids:
        return latest_state

    working_clips = {
        clip.id: clip
        for clip in working_state.candidate_clips
        if clip.id in clip_ids
    }
    if not working_clips:
        return latest_state

    for clip in latest_state.candidate_clips:
        working_clip = working_clips.get(clip.id)
        if working_clip is None:
            continue
        clip.status = working_clip.status
        clip.exported_path = working_clip.exported_path
        clip.export_error_message = working_clip.export_error_message
        clip.uploaded_object_key = working_clip.uploaded_object_key
        clip.uploaded_url = working_clip.uploaded_url
        clip.platform_sync_status = working_clip.platform_sync_status
        clip.platform_sync_error_message = working_clip.platform_sync_error_message
        clip.updated_at = working_clip.updated_at

    touched_video_ids = {clip.video_id for clip in working_clips.values()}
    for video_id in touched_video_ids:
        latest_video = latest_state.get_video(video_id)
        working_video = working_state.get_video(video_id)
        if latest_video is None or working_video is None:
            continue
        latest_video.file_path = working_video.file_path
        latest_video.file_name = working_video.file_name
        latest_video.status = working_video.status
        latest_video.error_message = working_video.error_message
        latest_video.total_candidates = working_video.total_candidates
        latest_video.reviewed_candidates = working_video.reviewed_candidates
        latest_video.detection_progress = dict(working_video.detection_progress)
        latest_video.updated_at = working_video.updated_at

    latest_state.rebuild_platform_record_links()
    latest_state.touch()
    return latest_state
