"""Request payload parsing and validation helpers.

Shared across project / platform / videos / clips routers.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Any

from fastapi import HTTPException, UploadFile

from ..models import PlatformRecord, VideoTask
from ..platform_client import PlatformApiError
from .constants import ALLOWED_CATEGORIES, MAG_SPORT_ITEM_IDS, WAG_SPORT_ITEM_IDS
from .paths import UPLOADS_DIR
from .services import get_platform_client


# ---------------------------------------------------------------------------
# Primitive coercion / normalization helpers.
# ---------------------------------------------------------------------------
def parse_json_body(body: bytes) -> dict[str, Any]:
    if not body:
        return {}
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=400, detail=f"Invalid JSON body: {error}")


def _coerce_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_str(value: Any) -> str | None:
    if value in (None, ""):
        return None
    text = str(value).strip()
    return text or None


def _as_str_list(values: Any) -> list[str]:
    result: list[str] = []
    for value in values or []:
        text = str(value or "").strip()
        if text:
            result.append(text)
    return result


def _normalize_venue_text(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "").strip())


# ---------------------------------------------------------------------------
# Sport-selection validators.
# ---------------------------------------------------------------------------
def validate_sport_selection_keys(values: list[Any]) -> list[str]:
    cleaned: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if not text:
            continue
        if not re.fullmatch(r"(1|2):([0-7])", text):
            raise HTTPException(status_code=400, detail=f"无效的项目选择键: {text}")
        cleaned.append(text)
    return sorted(set(cleaned))


def validate_sport_item_ids(sport_item_ids: list[Any]) -> list[int]:
    cleaned: list[int] = []
    for value in sport_item_ids:
        if value in (None, ""):
            continue
        try:
            cleaned.append(int(value))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"无效的项目键值: {value}")

    if not cleaned:
        raise HTTPException(status_code=400, detail="请至少选择一个项目")

    invalid = [
        value
        for value in cleaned
        if value not in MAG_SPORT_ITEM_IDS.union(WAG_SPORT_ITEM_IDS)
    ]
    if invalid:
        raise HTTPException(
            status_code=400,
            detail=f"无效的项目键值: {', '.join(map(str, invalid))}",
        )
    return sorted(set(cleaned))


# ---------------------------------------------------------------------------
# Platform context validation (used by import + platform records preview).
# ---------------------------------------------------------------------------
def validate_platform_context(payload: dict[str, Any]) -> dict[str, Any]:
    category = str(payload.get("category") or "").strip().upper()
    if category not in ALLOWED_CATEGORIES:
        raise HTTPException(status_code=400, detail="比赛类型必须是 EF / AA / TF / QF")

    sport_selection_keys = validate_sport_selection_keys(payload.get("sport_selection_keys", []))
    sport_item_ids = validate_sport_item_ids(payload.get("sport_item_ids", []))
    match_name = str(payload.get("match_name") or "").strip()
    if not match_name:
        raise HTTPException(status_code=400, detail="缺少赛事名称")

    frequency_info_ids = _as_str_list(payload.get("frequency_info_ids"))
    venues = _as_str_list(payload.get("venues"))
    if not frequency_info_ids:
        single_frequency_info_id = _coerce_str(payload.get("frequency_info_id"))
        if single_frequency_info_id:
            frequency_info_ids = [single_frequency_info_id]
    if not venues:
        single_venue = str(payload.get("venue") or "").strip()
        if single_venue:
            venues = [single_venue]

    if not venues:
        raise HTTPException(status_code=400, detail="缺少场次信息")

    return {
        "match_id": _coerce_str(payload.get("match_id")),
        "match_name": match_name,
        "frequency_info_id": frequency_info_ids[0] if frequency_info_ids else None,
        "frequency_info_ids": frequency_info_ids,
        "venue": venues[0],
        "venues": venues,
        "category": category,
        "sex": _coerce_int(payload.get("sex")),
        "sport_selection_keys": sport_selection_keys,
        "sport_item_ids": sport_item_ids,
        "team_country": str(payload.get("team_country") or "").strip() or None,
    }


def resolve_frequency_context(context: dict[str, Any]) -> dict[str, Any]:
    frequency_info_ids = list(context.get("frequency_info_ids") or [])
    venues = list(context.get("venues") or [])
    if frequency_info_ids and len(frequency_info_ids) == len(venues):
        return context
    if not venues:
        raise HTTPException(status_code=400, detail="缺少场次信息")

    try:
        available_frequencies = get_platform_client().fetch_frequencies(
            match_id=context.get("match_id"),
            match_name=context.get("match_name"),
            category=context.get("category"),
        )
    except PlatformApiError as error:
        raise HTTPException(status_code=502, detail=str(error))

    resolved_frequency_ids: list[str] = []
    resolved_venues: list[str] = []
    missing_venues: list[str] = []

    for venue in venues:
        normalized_venue = _normalize_venue_text(venue)
        matched = next(
            (
                frequency
                for frequency in available_frequencies
                if _normalize_venue_text(frequency.get("venue")) == normalized_venue
            ),
            None,
        )
        if matched is None:
            matched = next(
                (
                    frequency
                    for frequency in available_frequencies
                    if normalized_venue in _normalize_venue_text(frequency.get("venue"))
                    or _normalize_venue_text(frequency.get("venue")) in normalized_venue
                ),
                None,
            )
        if matched is None:
            missing_venues.append(str(venue))
            continue
        resolved_frequency_ids.append(str(matched.get("id")))
        resolved_venues.append(str(matched.get("venue") or venue))

    if missing_venues:
        raise HTTPException(
            status_code=400,
            detail=f"未找到场次对应ID: {' / '.join(missing_venues)}",
        )

    if not resolved_frequency_ids:
        raise HTTPException(status_code=400, detail="缺少场次 ID")

    return {
        **context,
        "frequency_info_id": resolved_frequency_ids[0],
        "frequency_info_ids": resolved_frequency_ids,
        "venue": resolved_venues[0],
        "venues": resolved_venues,
    }


def parse_contexts_json(raw_value: str | None) -> dict[str, dict[str, Any]]:
    if not raw_value:
        return {}
    try:
        data = json.loads(raw_value)
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=400, detail=f"Invalid contexts_json: {error}")

    if not isinstance(data, list):
        raise HTTPException(status_code=400, detail="contexts_json 必须是数组")

    parsed: dict[str, dict[str, Any]] = {}
    for item in data:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="contexts_json 项必须是对象")
        client_file_id = str(item.get("client_file_id") or "").strip()
        if not client_file_id:
            raise HTTPException(status_code=400, detail="contexts_json 缺少 client_file_id")
        parsed[client_file_id] = {
            "client_file_id": client_file_id,
            **validate_platform_context(item),
        }
    return parsed


def parse_scope_queries_payload(raw_value: Any) -> list[dict[str, Any]]:
    data = raw_value
    if isinstance(raw_value, str):
        try:
            data = json.loads(raw_value)
        except json.JSONDecodeError as error:
            raise HTTPException(status_code=400, detail=f"Invalid scope_queries payload: {error}")

    if not isinstance(data, list):
        raise HTTPException(status_code=400, detail="scope_queries 必须是数组")

    resolved_queries: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="scope_queries 项必须是对象")
        resolved_queries.append(resolve_frequency_context(validate_platform_context(item)))

    if not resolved_queries:
        raise HTTPException(status_code=400, detail="至少提供一组 scope_queries")
    return resolved_queries


# ---------------------------------------------------------------------------
# Upload persistence + input shaping.
# ---------------------------------------------------------------------------
def persist_uploaded_file(
    file: UploadFile,
    target_dir: Path = UPLOADS_DIR,
    *,
    overwrite: bool = False,
) -> str:
    original_name = file.filename or "upload.mp4"
    safe_name = re.sub(r"[^\w.\- ]", "_", original_name).strip() or "upload.mp4"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / safe_name
    if target.exists():
        if overwrite:
            target.unlink()
        else:
            return str(target.resolve())
    with target.open("wb") as handle:
        shutil.copyfileobj(file.file, handle)
    return str(target.resolve())


def build_import_inputs(
    files: list[UploadFile],
    client_ids: list[str],
    contexts_by_client_id: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    if len(files) != len(client_ids):
        raise HTTPException(status_code=400, detail="files 与 file_client_ids 数量不一致")

    import_inputs: list[dict[str, Any]] = []
    for file, client_id in zip(files, client_ids):
        context = contexts_by_client_id.get(client_id)
        if context is None:
            raise HTTPException(status_code=400, detail=f"缺少文件上下文: {client_id}")
        context = resolve_frequency_context(context)
        import_inputs.append(
            {
                "path": persist_uploaded_file(file),
                "match_id": context["match_id"],
                "match_name": context["match_name"],
                "frequency_info_id": context["frequency_info_id"],
                "frequency_info_ids": context["frequency_info_ids"],
                "venue": context["venue"],
                "venues": context["venues"],
                "category": context["category"],
                "sport_selection_keys": context["sport_selection_keys"],
                "sport_item_ids": context["sport_item_ids"],
            }
        )
    return import_inputs


def build_direct_clip_inputs(files: list[UploadFile]) -> list[dict[str, Any]]:
    return [
        {"path": persist_uploaded_file(file)}
        for file in files
        if hasattr(file, "filename") and hasattr(file, "file")
    ]


# ---------------------------------------------------------------------------
# Platform preview helpers.
# ---------------------------------------------------------------------------
def build_preview_video(query: dict[str, Any]) -> VideoTask:
    return VideoTask(
        id="preview_video",
        file_path="",
        file_name="预览查询",
        match_id=query["match_id"],
        match_name=query["match_name"],
        frequency_info_id=query["frequency_info_id"],
        frequency_info_ids=list(query["frequency_info_ids"]),
        venue=query["venue"],
        venues=list(query["venues"]),
        category=query["category"],
        sex=query["sex"],
        sport_selection_keys=list(query["sport_selection_keys"]),
        sport_item_ids=list(query["sport_item_ids"]),
        team_country=query["team_country"],
    )


def format_platform_record_preview(record: PlatformRecord) -> dict[str, Any]:
    return record.to_dict()


def _normalize_scope_query_for_signature(query: dict[str, Any]) -> dict[str, Any]:
    return {
        "match_id": _coerce_str(query.get("match_id")),
        "match_name": str(query.get("match_name") or "").strip(),
        "frequency_info_ids": sorted(_as_str_list(query.get("frequency_info_ids"))),
        "venues": _as_str_list(query.get("venues")),
        "category": str(query.get("category") or "").strip().upper(),
        "sport_selection_keys": sorted(
            validate_sport_selection_keys(query.get("sport_selection_keys", []))
        ),
        "sport_item_ids": sorted(validate_sport_item_ids(query.get("sport_item_ids", []))),
        "team_country": str(query.get("team_country") or "").strip() or None,
    }


def build_scope_query_signature(queries: list[dict[str, Any]]) -> str:
    normalized_queries = [
        _normalize_scope_query_for_signature(query) for query in queries
    ]
    normalized_queries.sort(
        key=lambda item: json.dumps(item, ensure_ascii=False, sort_keys=True)
    )
    payload = json.dumps(
        normalized_queries, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()
