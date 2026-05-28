"""Local-card (本地补录) CRUD endpoints scoped under a video."""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ..deps.state import load_state, persist_state, project_state_lock
from ..deps.state_helpers import project_payload, reconcile_runtime_state
from ..deps.validators import parse_json_body
from ..models import PlatformRecord, new_id, utc_now_iso
from ..platform_client import SPORT_ITEM_LABELS


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/videos/{video_id}/local-cards", tags=["local-cards"])


_LOCAL_CARD_EDITABLE_FIELDS = {
    "user_name",
    "english_name",
    "country",
    "sport_item_id",
    "sport_item_label",
    "sex",
    "difficulty_score",
    "execution_score",
    "bonus_score",
    "penalty_score",
    "total_score",
}


def _normalize_local_card_score(value: Any, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _apply_local_card_fields(record: PlatformRecord, payload: dict[str, Any]) -> None:
    if "user_name" in payload:
        record.user_name = str(payload.get("user_name") or "").strip()
    if "english_name" in payload:
        record.english_name = str(payload.get("english_name") or "").strip()
    if "country" in payload:
        record.country = str(payload.get("country") or "").strip()
    if "sport_item_id" in payload:
        raw = payload.get("sport_item_id")
        record.sport_item_id = (
            int(raw) if raw is not None and str(raw).strip() != "" else None
        )
    if "sport_item_label" in payload:
        record.sport_item_label = str(payload.get("sport_item_label") or "").strip()
    if "sex" in payload:
        raw = payload.get("sex")
        record.sex = int(raw) if raw is not None and str(raw).strip() != "" else None
    if "difficulty_score" in payload:
        record.difficulty_score = _normalize_local_card_score(
            payload.get("difficulty_score"), "0"
        )
    if "execution_score" in payload:
        record.execution_score = _normalize_local_card_score(
            payload.get("execution_score"), "0"
        )
    if "bonus_score" in payload:
        record.bonus_score = _normalize_local_card_score(
            payload.get("bonus_score"), "0"
        )
    if "penalty_score" in payload:
        record.penalty_score = _normalize_local_card_score(
            payload.get("penalty_score"), "0"
        )
    if "total_score" in payload:
        record.total_score = _normalize_local_card_score(
            payload.get("total_score"), "0"
        )
    if record.sport_item_label == "" and record.sport_item_id is not None:
        record.sport_item_label = SPORT_ITEM_LABELS.get(record.sport_item_id, "")
    record.updated_at = utc_now_iso()


@router.post("")
async def create_local_card(video_id: str, request: Request):
    payload = parse_json_body(await request.body())
    if not str(payload.get("user_name") or "").strip():
        raise HTTPException(status_code=400, detail="姓名不能为空")
    sport_item_value = payload.get("sport_item_id")
    if sport_item_value is None or (
        isinstance(sport_item_value, str) and not sport_item_value.strip()
    ):
        raise HTTPException(status_code=400, detail="必须指定项目")

    with project_state_lock():
        state = load_state()
        reconcile_runtime_state(state)
        video = state.get_video(video_id)
        if video is None:
            raise HTTPException(status_code=404, detail="视频不存在")

        record = PlatformRecord(
            id=new_id("platform"),
            video_id=video.id,
            platform_scope_id=video.platform_scope_id or video.id,
            platform_id=None,
            match_id=None,
            match_name=video.match_name,
            frequency_info_id=None,
            venue=video.venue or "",
            category=video.category or "",
            team_country=None,
            raw_record={},
            is_local=True,
        )
        _apply_local_card_fields(record, payload)
        state.platform_records.append(record)
        state.rebuild_platform_record_links()
        state.touch()
        persist_state(state)
        logger.info(
            "create_local_card video=%s record=%s user=%s",
            video_id,
            record.id,
            record.user_name,
        )
        return {"record": record.to_dict(), "project": project_payload(state)}


@router.patch("/{record_id}")
async def update_local_card(video_id: str, record_id: str, request: Request):
    payload = parse_json_body(await request.body())
    unknown_fields = set(payload.keys()) - _LOCAL_CARD_EDITABLE_FIELDS
    if unknown_fields:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的字段: {', '.join(sorted(unknown_fields))}",
        )

    with project_state_lock():
        state = load_state()
        reconcile_runtime_state(state)
        video = state.get_video(video_id)
        if video is None:
            raise HTTPException(status_code=404, detail="视频不存在")
        record = state.get_platform_record(record_id)
        scope_id = video.platform_scope_id or video.id
        if record is None or record.platform_scope_id != scope_id:
            raise HTTPException(status_code=404, detail="本地补录卡片不存在")
        if not record.is_local:
            raise HTTPException(status_code=403, detail="仅可编辑本地补录卡片")
        _apply_local_card_fields(record, payload)
        state.rebuild_platform_record_links()
        state.touch()
        persist_state(state)
        logger.info(
            "update_local_card video=%s record=%s keys=%s",
            video_id,
            record_id,
            sorted(payload.keys()),
        )
        return {"record": record.to_dict(), "project": project_payload(state)}


@router.delete("/{record_id}")
def delete_local_card(video_id: str, record_id: str):
    with project_state_lock():
        state = load_state()
        reconcile_runtime_state(state)
        video = state.get_video(video_id)
        if video is None:
            raise HTTPException(status_code=404, detail="视频不存在")
        record = state.get_platform_record(record_id)
        scope_id = video.platform_scope_id or video.id
        if record is None or record.platform_scope_id != scope_id:
            raise HTTPException(status_code=404, detail="本地补录卡片不存在")
        if not record.is_local:
            raise HTTPException(status_code=403, detail="仅可删除本地补录卡片")
        state.platform_records = [r for r in state.platform_records if r.id != record_id]
        state.rebuild_platform_record_links()
        state.touch()
        persist_state(state)
        logger.info(
            "delete_local_card video=%s record=%s",
            video_id,
            record_id,
        )
        return {"project": project_payload(state)}
