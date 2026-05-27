"""Candidate-clip review endpoints (update / split / extract / delete / bind)."""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request

from ..deps.services import review_service
from ..deps.state import load_state, persist_state, project_state_lock
from ..deps.state_helpers import project_payload, reconcile_runtime_state
from ..deps.validators import parse_json_body
from ..models import utc_now_iso


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/clips", tags=["clips"])


@router.patch("/{clip_id}")
async def update_clip(clip_id: str, request: Request):
    payload = parse_json_body(await request.body())
    logger.info("update_clip id=%s keys=%s", clip_id, sorted(payload.keys()))
    with project_state_lock():
        state = load_state()
        reconcile_runtime_state(state)
        state.rebuild_platform_record_links()
        try:
            review_service.update_clip(
                state,
                clip_id=clip_id,
                status=payload.get("status"),
                review_start=payload.get("review_start"),
                review_end=payload.get("review_end"),
                segments=payload.get("segments"),
                segments_provided="segments" in payload,
                notes=payload.get("notes"),
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error))

        state.rebuild_platform_record_links()
        persist_state(state)
        return {"project": project_payload(state)}


@router.post("/{clip_id}/split")
async def split_clip_legacy(clip_id: str, request: Request):
    payload = parse_json_body(await request.body())
    split_at = payload.get("split_at")
    if split_at in (None, ""):
        raise HTTPException(status_code=400, detail="缺少拆分点")

    logger.info("split_clip_legacy id=%s split_at=%s", clip_id, split_at)
    with project_state_lock():
        state = load_state()
        reconcile_runtime_state(state)
        state.rebuild_platform_record_links()
        try:
            clip = review_service._find_clip(state, clip_id)
            if not clip.segments:
                raise ValueError("当前候选片段没有可编辑选区")
            review_service.split_segment(
                state,
                clip_id=clip_id,
                segment_id=clip.segments[0].id,
                split_at=float(split_at),
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error))

        state.rebuild_platform_record_links()
        persist_state(state)
        return {
            "project": project_payload(state),
            "new_clip_id": clip_id,
        }


@router.post("/{clip_id}/split-segment")
async def split_clip_segment(clip_id: str, request: Request):
    payload = parse_json_body(await request.body())
    split_at = payload.get("split_at")
    segment_id = str(payload.get("segment_id") or "").strip()
    if split_at in (None, ""):
        raise HTTPException(status_code=400, detail="缺少拆分点")
    if not segment_id:
        raise HTTPException(status_code=400, detail="缺少选区ID")

    logger.info(
        "split_clip_segment clip=%s segment=%s split_at=%s",
        clip_id,
        segment_id,
        split_at,
    )
    with project_state_lock():
        state = load_state()
        reconcile_runtime_state(state)
        state.rebuild_platform_record_links()
        try:
            review_service.split_segment(
                state,
                clip_id=clip_id,
                segment_id=segment_id,
                split_at=float(split_at),
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error))

        state.rebuild_platform_record_links()
        persist_state(state)
        return {
            "project": project_payload(state),
        }


@router.post("/{clip_id}/extract-segment")
async def extract_clip_segment(clip_id: str, request: Request):
    payload = parse_json_body(await request.body())
    segment_id = str(payload.get("segment_id") or "").strip()
    if not segment_id:
        raise HTTPException(status_code=400, detail="缺少选区ID")

    logger.info("extract_clip_segment clip=%s segment=%s", clip_id, segment_id)
    with project_state_lock():
        state = load_state()
        reconcile_runtime_state(state)
        state.rebuild_platform_record_links()
        try:
            _, new_clip = review_service.extract_segment(
                state,
                clip_id=clip_id,
                segment_id=segment_id,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error))

        state.rebuild_platform_record_links()
        persist_state(state)
        return {
            "project": project_payload(state),
            "new_clip_id": new_clip.id,
        }


@router.post("/{clip_id}/delete-segment")
async def delete_clip_segment(clip_id: str, request: Request):
    payload = parse_json_body(await request.body())
    segment_id = str(payload.get("segment_id") or "").strip()
    if not segment_id:
        raise HTTPException(status_code=400, detail="缺少选区ID")

    logger.info("delete_clip_segment clip=%s segment=%s", clip_id, segment_id)
    with project_state_lock():
        state = load_state()
        reconcile_runtime_state(state)
        state.rebuild_platform_record_links()
        try:
            deleted_clip, surviving_clip_id = review_service.delete_segment(
                state,
                clip_id=clip_id,
                segment_id=segment_id,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error))

        state.rebuild_platform_record_links()
        persist_state(state)
        return {
            "project": project_payload(state),
            "deleted_clip": deleted_clip,
            "surviving_clip_id": surviving_clip_id,
        }


@router.patch("/{clip_id}/binding")
async def bind_clip_platform_record(clip_id: str, request: Request):
    payload = parse_json_body(await request.body())
    requested_record_id = payload.get("platform_record_id")
    platform_record_id = (
        str(requested_record_id).strip() if requested_record_id is not None else None
    )
    if platform_record_id == "":
        platform_record_id = None

    logger.info(
        "bind_clip_platform_record clip=%s record=%s",
        clip_id,
        platform_record_id,
    )
    with project_state_lock():
        state = load_state()
        reconcile_runtime_state(state)
        state.rebuild_platform_record_links()
        clip = review_service._find_clip(state, clip_id)
        if platform_record_id is not None:
            record = state.get_platform_record(platform_record_id)
            if record is None:
                raise HTTPException(status_code=404, detail="平台成绩卡片不存在")
            video = state.get_video(clip.video_id)
            if video is None:
                raise HTTPException(status_code=404, detail="片段对应视频不存在")
            if record.platform_scope_id != video.platform_scope_id:
                raise HTTPException(
                    status_code=400,
                    detail="当前片段只能绑定同一导入批次的卡片",
                )
            existing_links = [
                linked_clip_id
                for linked_clip_id in record.linked_clip_ids
                if linked_clip_id != clip.id
            ]
            if existing_links:
                raise HTTPException(
                    status_code=400,
                    detail="该平台成绩卡片已绑定其他片段，请先解绑",
                )

        clip.linked_platform_record_id = platform_record_id
        clip.updated_at = utc_now_iso()
        state.rebuild_platform_record_links()
        persist_state(state)
        return {"project": project_payload(state)}
