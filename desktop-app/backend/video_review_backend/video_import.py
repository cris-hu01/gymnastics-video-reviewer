from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from .models import CandidateClip, ClipSegment, ProjectState, VideoTask, new_id, utc_now_iso
from .video_metadata import probe_video_metadata


SUPPORTED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".flv", ".wmv"}
DIRECT_CLIP_METADATA_WORKERS = 6


def is_supported_video(path: str | Path) -> bool:
    target = Path(path)
    return not target.name.startswith(".") and target.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS


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


def _coerce_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def import_videos_into_project(
    state: ProjectState,
    video_inputs: list[str] | list[dict[str, object]],
) -> list[VideoTask]:
    imported: list[VideoTask] = []
    existing_paths = {video.file_path for video in state.videos}

    for item in video_inputs:
        if isinstance(item, dict):
            raw_path = str(item.get("path") or "")
            match_id = _coerce_str(item.get("match_id"))
            match_name = str(item.get("match_name") or "")
            frequency_info_id = _coerce_str(item.get("frequency_info_id"))
            frequency_info_ids = _as_str_list(item.get("frequency_info_ids"))
            venue = str(item.get("venue") or "")
            venues = _as_str_list(item.get("venues"))
            category = str(item.get("category") or "")
            sex = _coerce_int(item.get("sex"))
            sport_selection_keys = _as_str_list(item.get("sport_selection_keys"))
            sport_item_ids = [
                int(value)
                for value in item.get("sport_item_ids", [])
                if str(value).strip()
            ]
            team_country = str(item.get("team_country") or "").strip() or None
        else:
            raw_path = str(item)
            match_id = None
            match_name = ""
            frequency_info_id = None
            frequency_info_ids = []
            venue = ""
            venues = []
            category = ""
            sex = None
            sport_selection_keys = []
            sport_item_ids = []
            team_country = None

        if not frequency_info_ids and frequency_info_id:
            frequency_info_ids = [frequency_info_id]
        if not venues and venue:
            venues = [venue]
        if frequency_info_id is None and frequency_info_ids:
            frequency_info_id = frequency_info_ids[0]
        if not venue and venues:
            venue = venues[0]

        path = Path(raw_path).resolve()
        if not path.exists() or not path.is_file():
            continue
        if not is_supported_video(path):
            continue
        if str(path) in existing_paths:
            continue

        try:
            metadata = probe_video_metadata(str(path))
        except Exception:
            continue
        now = utc_now_iso()
        video = VideoTask(
            id=new_id("video"),
            file_path=metadata["file_path"],
            file_name=metadata["file_name"],
            source_kind="full_video",
            platform_scope_id="",
            match_id=match_id,
            match_name=match_name,
            frequency_info_id=frequency_info_id,
            frequency_info_ids=frequency_info_ids,
            venue=venue,
            venues=venues,
            category=category,
            sex=sex,
            sport_selection_keys=sport_selection_keys,
            sport_item_ids=sport_item_ids,
            team_country=team_country,
            duration=metadata["duration"],
            resolution=metadata["resolution"],
            status="queued",
            created_at=now,
            updated_at=now,
        )
        video.platform_scope_id = video.id
        state.videos.append(video)
        state.upsert_platform_query_context(video)
        existing_paths.add(str(path))
        imported.append(video)

    state.touch()
    return imported


def summarize_scope_queries(scope_queries: list[dict[str, object]]) -> dict[str, object]:
    match_names: list[str] = []
    frequency_info_ids: list[str] = []
    venues: list[str] = []
    categories: list[str] = []
    sport_selection_keys: list[str] = []
    sport_item_ids: list[int] = []
    sexes: list[int] = []
    match_ids: list[str] = []

    for query in scope_queries:
        match_id = _coerce_str(query.get("match_id"))
        match_name = str(query.get("match_name") or "").strip()
        category = str(query.get("category") or "").strip()
        sex = _coerce_int(query.get("sex"))

        if match_id and match_id not in match_ids:
            match_ids.append(match_id)
        if match_name and match_name not in match_names:
            match_names.append(match_name)
        if category and category not in categories:
            categories.append(category)
        if sex is not None and sex not in sexes:
            sexes.append(sex)

        for frequency_info_id in _as_str_list(query.get("frequency_info_ids")):
            if frequency_info_id not in frequency_info_ids:
                frequency_info_ids.append(frequency_info_id)
        for venue in _as_str_list(query.get("venues")):
            if venue not in venues:
                venues.append(venue)
        for selection_key in _as_str_list(query.get("sport_selection_keys")):
            if selection_key not in sport_selection_keys:
                sport_selection_keys.append(selection_key)
        for sport_item_id in [
            int(value)
            for value in query.get("sport_item_ids", [])
            if str(value).strip()
        ]:
            if sport_item_id not in sport_item_ids:
                sport_item_ids.append(sport_item_id)

    match_name = match_names[0] if len(match_names) == 1 else "多个比赛"
    venue = venues[0] if len(venues) == 1 else (venues[0] if venues else "")
    category = categories[0] if len(categories) == 1 else ""
    sex = sexes[0] if len(sexes) == 1 else None

    return {
        "match_id": match_ids[0] if len(match_ids) == 1 else None,
        "match_name": match_name,
        "frequency_info_id": frequency_info_ids[0] if frequency_info_ids else None,
        "frequency_info_ids": frequency_info_ids,
        "venue": venue,
        "venues": venues,
        "category": category,
        "sex": sex,
        "sport_selection_keys": sport_selection_keys,
        "sport_item_ids": sorted(sport_item_ids),
    }


def import_direct_clips_into_project(
    state: ProjectState,
    clip_inputs: list[str] | list[dict[str, object]],
    *,
    platform_scope_id: str,
    scope_summary: dict[str, object],
) -> tuple[list[VideoTask], list[CandidateClip]]:
    imported_videos: list[VideoTask] = []
    imported_clips: list[CandidateClip] = []
    existing_paths = {video.file_path for video in state.videos}
    pending_paths: list[Path] = []

    for item in clip_inputs:
        raw_path = str(item.get("path") or "") if isinstance(item, dict) else str(item)
        path = Path(raw_path).resolve()
        if not path.exists() or not path.is_file():
            continue
        if not is_supported_video(path):
            continue
        if str(path) in existing_paths:
            continue
        existing_paths.add(str(path))
        pending_paths.append(path)

    if not pending_paths:
        state.touch()
        return imported_videos, imported_clips

    metadata_by_path: dict[str, dict[str, object]] = {}

    def probe_one(target_path: Path) -> tuple[str, dict[str, object]]:
        return str(target_path), probe_video_metadata(str(target_path))

    if len(pending_paths) == 1:
        try:
            key, metadata = probe_one(pending_paths[0])
        except Exception:
            key = ""
            metadata = {}
        if key:
            metadata_by_path[key] = metadata
    else:
        with ThreadPoolExecutor(max_workers=min(DIRECT_CLIP_METADATA_WORKERS, len(pending_paths)), thread_name_prefix="gymclip-ffprobe") as executor:
            futures = [executor.submit(probe_one, path) for path in pending_paths]
            for future in as_completed(futures):
                try:
                    key, metadata = future.result()
                except Exception:
                    continue
                metadata_by_path[key] = metadata

    for path in pending_paths:
        metadata = metadata_by_path.get(str(path))
        if metadata is None:
            continue
        now = utc_now_iso()
        duration = float(metadata["duration"] or 0.0)
        video = VideoTask(
            id=new_id("video"),
            file_path=metadata["file_path"],
            file_name=metadata["file_name"],
            source_kind="direct_clip",
            platform_scope_id=platform_scope_id,
            match_id=_coerce_str(scope_summary.get("match_id")),
            match_name=str(scope_summary.get("match_name") or ""),
            frequency_info_id=_coerce_str(scope_summary.get("frequency_info_id")),
            frequency_info_ids=_as_str_list(scope_summary.get("frequency_info_ids")),
            venue=str(scope_summary.get("venue") or ""),
            venues=_as_str_list(scope_summary.get("venues")),
            category=str(scope_summary.get("category") or ""),
            sex=_coerce_int(scope_summary.get("sex")),
            sport_selection_keys=_as_str_list(scope_summary.get("sport_selection_keys")),
            sport_item_ids=[
                int(value)
                for value in scope_summary.get("sport_item_ids", [])
                if str(value).strip()
            ],
            duration=metadata["duration"],
            resolution=metadata["resolution"],
            status="reviewing",
            total_candidates=1,
            reviewed_candidates=1,
            detection_progress={
                "stage": "direct_clip_imported",
                "message": "已有片段已导入，无需检测",
            },
            created_at=now,
            updated_at=now,
        )
        clip = CandidateClip(
            id=new_id("clip"),
            video_id=video.id,
            detection_block_id=None,
            linked_platform_record_id=None,
            athlete_name="",
            country="",
            subtitle_start=0.0,
            subtitle_end=duration,
            candidate_start=0.0,
            candidate_end=duration,
            review_start=0.0,
            review_end=duration,
            segments=[ClipSegment(id=new_id("seg"), start=0.0, end=duration)],
            confidence=1.0,
            status="kept",
            notes="",
            created_at=now,
            updated_at=now,
        )
        state.videos.append(video)
        state.candidate_clips.append(clip)
        imported_videos.append(video)
        imported_clips.append(clip)

    state.touch()
    return imported_videos, imported_clips
