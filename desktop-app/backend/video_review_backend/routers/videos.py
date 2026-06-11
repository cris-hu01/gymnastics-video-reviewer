"""Video lifecycle endpoints: detect / delete / stream / thumbnails / candidates.

Exposes two routers:
- `router`        with prefix `/api/videos`
- `thumbnail_router` with prefix `/api/thumbnails` (raw file fetch)
"""
from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from ..deps.finders import find_video_or_404
from ..deps.paths import UPLOADS_DIR
from ..deps.services import (
    detect_job_manager,
    get_detection_service,
    get_thumbnail_service,
    has_active_job,
)
from ..deps.state import load_state, persist_state, project_state_lock
from ..deps.state_helpers import (
    apply_detect_progress,
    merge_detect_video_state,
    project_payload,
    reconcile_runtime_state,
    restore_video_after_detection_cancel,
    update_video_progress,
)
from ..deps.validators import parse_json_body
from ..jobs import JobCancelledError
from ..video_import import build_full_video_clip


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/videos", tags=["videos"])
thumbnail_router = APIRouter(prefix="/api/thumbnails", tags=["thumbnails"])


# Backward-compat alias: existing client posts to /api/project/detect.
# We mount this on the project router via include_router below in api.py.
# For organizational sanity it lives next to the cancel-detect handler.
detect_router = APIRouter(prefix="/api/project", tags=["videos"])


@detect_router.post("/detect")
async def detect_video(request: Request):
    payload = parse_json_body(await request.body())
    video_id = payload.get("video_id")
    api_key = payload.get("api_key")
    if not video_id:
        raise HTTPException(status_code=400, detail="video_id is required")

    def runner(progress_callback, is_cancel_requested):
        state = load_state()
        reconcile_runtime_state(state)
        last_persist = {"time": 0.0, "stage": None}

        def persist_detect_progress(progress: dict[str, Any]) -> None:
            current_stage = progress.get("stage")
            now = time.monotonic()
            should_persist = (
                current_stage != last_persist["stage"]
                or now - last_persist["time"] >= 0.5
                or current_stage in {"completed", "error"}
            )
            if not should_persist:
                return

            with project_state_lock():
                current_state = load_state()
                reconcile_runtime_state(current_state)
                apply_detect_progress(current_state, video_id, progress)
                persist_state(current_state)
            progress_callback(progress)
            last_persist["time"] = now
            last_persist["stage"] = current_stage

        from ..detection_service import DetectionCancelledError

        try:
            result = get_detection_service().detect_video(
                state,
                video_id=video_id,
                api_key=api_key,
                progress_callback=persist_detect_progress,
                cancel_requested=is_cancel_requested,
            )
        except DetectionCancelledError as error:
            raise JobCancelledError(str(error))
        with project_state_lock():
            latest_state = load_state()
            reconcile_runtime_state(latest_state)
            merged_state = merge_detect_video_state(latest_state, state, video_id)
            persist_state(merged_state)
        logger.info(
            "detect_video completed video=%s candidates=%d blocks=%d",
            video_id,
            len(result.candidate_clips),
            len(result.detection_blocks),
        )
        return {
            "video_id": video_id,
            "total_candidates": len(result.candidate_clips),
            "detection_blocks": len(result.detection_blocks),
            "stats": result.stats,
        }

    with project_state_lock():
        state = load_state()
        reconcile_runtime_state(state)
        video = find_video_or_404(state, video_id)
        if video.source_kind == "direct_clip":
            raise HTTPException(status_code=400, detail="已有片段无需检测")
        if not Path(video.file_path).exists():
            raise HTTPException(
                status_code=400, detail="源视频文件不存在，请删除该任务后重新导入"
            )
        if has_active_job(kind="detect", video_id=video_id):
            raise HTTPException(status_code=409, detail="该视频已有检测任务在运行")

        update_video_progress(
            state,
            video_id,
            {
                "stage": "queued",
                "message": "等待检测任务开始",
                "completed": 0,
                "total": 0,
            },
        )
        video.status = "queued"
        persist_state(state)

        job = detect_job_manager.start_job(
            kind="detect",
            title=f"检测 {video.file_name}",
            runner=runner,
            video_id=video_id,
            initial_progress={
                "stage": "queued",
                "message": "等待检测任务开始",
                "completed": 0,
                "total": 0,
            },
        )
    logger.info("detect_video queued video=%s job=%s", video_id, job.id)
    return {
        "job": job.to_dict(),
        "project": project_payload(state),
    }


@router.post("/{video_id}/cancel-detect")
def cancel_detect(video_id: str):
    with project_state_lock():
        state = load_state()
        if reconcile_runtime_state(state):
            persist_state(state)
        video = state.get_video(video_id)
        if video is None:
            raise HTTPException(status_code=404, detail="Video not found")

        detect_jobs = [
            job
            for job in detect_job_manager.list_jobs()
            if job.kind == "detect"
            and job.video_id == video_id
            and job.status in {"queued", "running"}
        ]
        if not detect_jobs:
            raise HTTPException(status_code=409, detail="当前视频没有可取消的检测任务")

        queued_job = next((job for job in detect_jobs if job.status == "queued"), None)
        if queued_job is not None:
            cancelled_job = detect_job_manager.cancel_job(queued_job.id)
            if cancelled_job is None:
                raise HTTPException(
                    status_code=409, detail="检测任务已开始执行，请稍后重试取消"
                )
            restore_video_after_detection_cancel(state, video_id, "检测已取消")
            persist_state(state)
            logger.info("cancel_detect cancelled-queued video=%s job=%s", video_id, queued_job.id)
            return {
                "project": project_payload(state),
                "message": "已取消排队中的检测任务",
            }

        running_job = next((job for job in detect_jobs if job.status == "running"), None)
        if running_job is None:
            raise HTTPException(status_code=409, detail="当前视频没有可取消的检测任务")

        requested_job = detect_job_manager.request_cancel(running_job.id)
        if requested_job is None:
            raise HTTPException(status_code=409, detail="检测任务状态已变化，请刷新后重试")

        update_video_progress(
            state,
            video_id,
            {
                "stage": "cancel_requested",
                "message": "正在取消检测...",
                "completed": video.detection_progress.get("completed", 0),
                "total": video.detection_progress.get("total", 0),
            },
        )
        persist_state(state)
        logger.info("cancel_detect requested video=%s job=%s", video_id, running_job.id)
        return {
            "project": project_payload(state),
            "message": "已请求取消检测任务",
        }


@router.delete("/{video_id}")
def delete_video(video_id: str):
    with project_state_lock():
        state = load_state()
        if reconcile_runtime_state(state):
            persist_state(state)
        video = state.get_video(video_id)
        if video is None:
            raise HTTPException(status_code=404, detail="Video not found")
        if video.status == "detecting" or has_active_job(video_id=video_id):
            queued_detect_jobs = [
                job
                for job in detect_job_manager.list_jobs()
                if job.kind == "detect"
                and job.video_id == video_id
                and job.status == "queued"
            ]
            if video.status == "detecting":
                raise HTTPException(status_code=409, detail="当前视频正在检测中，无法删除")

            for job in queued_detect_jobs:
                detect_job_manager.cancel_job(job.id)

            if has_active_job(video_id=video_id):
                raise HTTPException(
                    status_code=409, detail="当前视频存在进行中的后台任务，无法删除"
                )

        source_path = Path(video.file_path)
        if source_path.exists():
            try:
                if UPLOADS_DIR.resolve() in source_path.resolve().parents:
                    source_path.unlink()
            except OSError as error:
                logger.exception("delete_video unlink failed video=%s", video_id)
                raise HTTPException(status_code=500, detail=f"删除源视频失败: {error}")

        state.remove_video(video_id)
        persist_state(state)
        logger.info("delete_video video=%s name=%s", video_id, video.file_name)
        return project_payload(state)


@router.post("/{video_id}/add-as-candidate")
def add_video_as_candidate(video_id: str):
    with project_state_lock():
        state = load_state()
        video = state.get_video(video_id)
        if video is None:
            raise HTTPException(status_code=404, detail="Video not found")
        clip = build_full_video_clip(video, source_label="manual_full_video")
        state.candidate_clips.append(clip)
        state.touch()
        persist_state(state)
        logger.info(
            "add_video_as_candidate video=%s new_clip=%s",
            video_id,
            clip.id,
        )
        return project_payload(state)


@router.get("/{video_id}/stream")
def stream_video(video_id: str):
    state = load_state()
    reconcile_runtime_state(state)
    video = state.get_video(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")

    path = Path(video.file_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")
    return FileResponse(path)


@router.get("/{video_id}/thumbnails")
def get_video_thumbnails(
    video_id: str,
    start: float,
    end: float,
    count: int = 12,
):
    state = load_state()
    reconcile_runtime_state(state)
    video = find_video_or_404(state, video_id)
    path = Path(video.file_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")

    try:
        thumbnails = get_thumbnail_service().build_timeline(
            video_id=video_id,
            video_path=str(path),
            start=start,
            end=end,
            count=count,
        )
    except Exception as error:
        logger.warning("get_video_thumbnails failed video=%s: %s", video_id, error)
        raise HTTPException(status_code=400, detail=str(error))

    return {
        "video_id": video_id,
        "start": start,
        "end": end,
        "count": count,
        "thumbnails": [
            {
                "time_seconds": item.time_seconds,
                "url": item.url,
            }
            for item in thumbnails
        ],
    }


@thumbnail_router.get("/{video_id}/{file_name}")
def get_thumbnail_file(video_id: str, file_name: str):
    try:
        path = get_thumbnail_service().resolve_file(video_id, file_name)
    except ValueError:
        # Traversal attempt (e.g. `..%5c` sequences). Respond identically to
        # a missing thumbnail so the rejection leaks nothing about the FS.
        logger.warning(
            "get_thumbnail_file rejected suspicious path video_id=%r file_name=%r",
            video_id,
            file_name,
        )
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    if not path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(path)
