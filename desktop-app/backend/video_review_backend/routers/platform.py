"""Platform (external scoring API) read-only endpoints + preview scope cache."""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query, Request

from ..deps.scope_cache import store_preview_scope_cache
from ..deps.services import get_platform_client
from ..deps.validators import (
    build_preview_video,
    build_scope_query_signature,
    format_platform_record_preview,
    parse_json_body,
    parse_scope_queries_payload,
    resolve_frequency_context,
    validate_platform_context,
)
from ..models import PlatformScopeQuery
from ..platform_client import PlatformApiError


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/platform", tags=["platform"])


@router.get("/matches")
def get_platform_matches():
    try:
        matches = get_platform_client().fetch_matches()
    except PlatformApiError as error:
        logger.warning("fetch_matches failed: %s", error)
        raise HTTPException(status_code=502, detail=str(error))
    return {"matches": matches}


@router.get("/frequencies")
def get_platform_frequencies(
    match_id: str | None = None,
    match_name: str | None = None,
    category: str | None = None,
):
    try:
        frequencies = get_platform_client().fetch_frequencies(
            match_id=match_id,
            match_name=match_name,
            category=category,
        )
    except PlatformApiError as error:
        logger.warning("fetch_frequencies failed: %s", error)
        raise HTTPException(status_code=502, detail=str(error))
    return {"frequencies": frequencies}


@router.get("/team-countries")
def get_platform_team_countries(
    frequency_info_id: str,
    sex: int,
    match_name: str | None = None,
    venue: str | None = None,
):
    try:
        countries = get_platform_client().fetch_team_countries(
            frequency_info_id=frequency_info_id,
            sex=sex,
            match_name=match_name,
            venue=venue,
        )
    except PlatformApiError as error:
        logger.warning("fetch_team_countries failed: %s", error)
        raise HTTPException(status_code=502, detail=str(error))
    return {"countries": countries}


@router.get("/records")
def get_platform_records(
    match_id: str | None = None,
    match_name: str | None = None,
    frequency_info_ids: list[str] = Query(default_factory=list),
    venues: list[str] = Query(default_factory=list),
    category: str | None = None,
    sport_selection_keys: list[str] = Query(default_factory=list),
    sport_item_ids: str | None = None,
):
    ids: list[str] = []
    for raw in (sport_item_ids or "").split(","):
        raw = raw.strip()
        if not raw:
            continue
        ids.append(raw)
    query = validate_platform_context(
        {
            "match_id": match_id,
            "match_name": match_name,
            "frequency_info_ids": list(frequency_info_ids),
            "venues": list(venues),
            "category": category,
            "sport_selection_keys": list(sport_selection_keys),
            "sport_item_ids": ids,
        }
    )
    query = resolve_frequency_context(query)
    preview_video = build_preview_video(query)
    try:
        records = get_platform_client().fetch_platform_records(preview_video)
    except PlatformApiError as error:
        logger.warning("fetch_platform_records failed: %s", error)
        raise HTTPException(status_code=502, detail=str(error))
    return {
        "count": len(records),
        "records": [format_platform_record_preview(record) for record in records],
    }


@router.post("/records/preview-scope")
async def preview_scope_platform_records(request: Request):
    payload = parse_json_body(await request.body())
    resolved_queries = parse_scope_queries_payload(payload.get("scope_queries"))
    scope_queries = [PlatformScopeQuery.from_dict(query) for query in resolved_queries]
    cache_key = build_scope_query_signature(resolved_queries)
    try:
        records = get_platform_client().fetch_scope_records(
            scope_id=cache_key,
            scope_queries=scope_queries,
        )
    except PlatformApiError as error:
        logger.warning("preview_scope fetch failed: %s", error)
        raise HTTPException(status_code=502, detail=str(error))
    store_preview_scope_cache(cache_key, cache_key, records)
    logger.info(
        "preview_scope cached key=%s queries=%d records=%d",
        cache_key,
        len(scope_queries),
        len(records),
    )
    return {
        "cache_key": cache_key,
        "count": len(records),
        "records": [format_platform_record_preview(record) for record in records],
    }
