"""TTL cache for preview-scope platform record fetches.

Shared between the platform router (which populates it during preview) and the
project router (which consumes it during direct-clip import).
"""
from __future__ import annotations

import time

from ..models import PlatformRecord
from .services import (
    PREVIEW_SCOPE_CACHE_TTL_SECONDS,
    get_platform_client,
    preview_scope_cache,
    preview_scope_cache_lock,
)


def prune_preview_scope_cache() -> None:
    now = time.time()
    cache = preview_scope_cache()
    with preview_scope_cache_lock():
        expired_keys = [
            cache_key
            for cache_key, entry in cache.items()
            if now - float(entry.get("created_at") or 0) > PREVIEW_SCOPE_CACHE_TTL_SECONDS
        ]
        for cache_key in expired_keys:
            cache.pop(cache_key, None)


def store_preview_scope_cache(
    cache_key: str,
    signature: str,
    records: list[PlatformRecord],
) -> None:
    prune_preview_scope_cache()
    cache = preview_scope_cache()
    with preview_scope_cache_lock():
        cache[cache_key] = {
            "signature": signature,
            "created_at": time.time(),
            "records": [record.to_dict() for record in records],
        }


def load_preview_scope_cache(
    cache_key: str | None,
    signature: str,
    *,
    scope_id: str,
) -> list[PlatformRecord] | None:
    if not cache_key:
        return None
    prune_preview_scope_cache()
    cache = preview_scope_cache()
    with preview_scope_cache_lock():
        entry = cache.get(cache_key)
    if entry is None or entry.get("signature") != signature:
        return None
    cached_records = [
        PlatformRecord.from_dict(item)
        for item in entry.get("records", [])
        if isinstance(item, dict)
    ]
    return get_platform_client().clone_records_for_scope(scope_id, cached_records)
