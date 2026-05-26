from __future__ import annotations

import json
import os
import re
import shutil
import time
import hashlib
from dataclasses import asdict
from pathlib import Path
from threading import RLock
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .export_service import ExportService
from .jobs import AppJob, JobCancelledError, JobManager
from .models import (
    CandidateClip,
    PlatformRecord,
    PlatformScope,
    PlatformScopeQuery,
    ProjectState,
    VideoTask,
    new_id,
    utc_now_iso,
)
from .platform_client import PlatformApiError, PlatformClient, SPORT_ITEM_LABELS
from .review_service import ReviewService
from .storage import (
    ensure_project_dir,
    load_project_state,
    project_state_lock,
    resolve_project_file,
    save_project_state,
)
from .thumbnail_service import ThumbnailService
from .video_import import (
    build_full_video_clip,
    import_direct_clips_into_project,
    import_videos_into_project,
    summarize_scope_queries,
)


BACKEND_ROOT = Path(
    os.environ.get("GYMCLIP_BACKEND_ROOT", Path(__file__).resolve().parents[1])
).resolve()
WORKSPACE_ROOT = Path(
    os.environ.get("GYMCLIP_WORKSPACE_ROOT", BACKEND_ROOT / "workspace")
).resolve()
UPLOADS_DIR = WORKSPACE_ROOT / "uploads"
EXPORTS_DIR = WORKSPACE_ROOT / "exports"
THUMBNAILS_DIR = WORKSPACE_ROOT / "thumbnails"
PROJECT_FILE = resolve_project_file(WORKSPACE_ROOT)

ensure_project_dir(WORKSPACE_ROOT)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)

MAG_SPORT_ITEM_IDS = {0, 1, 2, 3, 4, 5}
WAG_SPORT_ITEM_IDS = {0, 3, 6, 7}
ALLOWED_CATEGORIES = {"EF", "AA", "TF", "QF"}

review_service = ReviewService()
_detection_service = None
_export_service = None
_thumbnail_service = None
_platform_client = None
_preview_scope_cache_lock = RLock()
_preview_scope_cache: dict[str, dict[str, Any]] = {}
PREVIEW_SCOPE_CACHE_TTL_SECONDS = 600

app = FastAPI(title="GymClip Reviewer API", version="1.2.1")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def load_state() -> ProjectState:
    return load_project_state(PROJECT_FILE)


def persist_state(state: ProjectState) -> None:
    save_project_state(PROJECT_FILE, state)


def project_payload(state: ProjectState) -> dict[str, Any]:
    return state.to_dict()


def jobs_payload() -> list[dict[str, Any]]:
    return [job.to_dict() for job in list_all_jobs()]


def resolve_detect_parallelism() -> int:
    return 1


detect_job_manager = JobManager(max_workers=resolve_detect_parallelism())
export_job_manager = JobManager(max_workers=1)


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
    managers = []
    if kind == "detect":
        managers = [detect_job_manager]
    elif kind == "export":
        managers = [export_job_manager]
    else:
        managers = [detect_job_manager, export_job_manager]
    return any(manager.has_active_job(kind=kind, video_id=video_id) for manager in managers)


def get_detection_service():
    global _detection_service
    if _detection_service is None:
        from .detection_service import DetectionService

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


def restore_video_after_interrupted_detection(state: ProjectState, video_id: str, message: str) -> None:
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
    changed = reconcile_video_sources(state)
    if reconcile_stale_detection_state(state):
        changed = True
    return changed


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


def restore_video_after_detection_cancel(state: ProjectState, video_id: str, message: str) -> None:
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


def merge_detect_video_state(latest_state: ProjectState, working_state: ProjectState, video_id: str) -> ProjectState:
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


def merge_export_state(latest_state: ProjectState, working_state: ProjectState, clip_ids: set[str]) -> ProjectState:
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


def find_video_or_404(state: ProjectState, video_id: str) -> VideoTask:
    video = state.get_video(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    return video


def parse_json_body(body: bytes) -> dict[str, Any]:
    if not body:
        return {}
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=400, detail=f"Invalid JSON body: {error}")


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
    cleaned = []
    for value in sport_item_ids:
        if value in (None, ""):
            continue
        try:
            cleaned.append(int(value))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"无效的项目键值: {value}")

    if not cleaned:
        raise HTTPException(status_code=400, detail="请至少选择一个项目")

    invalid = [value for value in cleaned if value not in MAG_SPORT_ITEM_IDS.union(WAG_SPORT_ITEM_IDS)]
    if invalid:
        raise HTTPException(status_code=400, detail=f"无效的项目键值: {', '.join(map(str, invalid))}")
    return sorted(set(cleaned))


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
        "sport_selection_keys": sorted(validate_sport_selection_keys(query.get("sport_selection_keys", []))),
        "sport_item_ids": sorted(validate_sport_item_ids(query.get("sport_item_ids", []))),
        "team_country": str(query.get("team_country") or "").strip() or None,
    }


def build_scope_query_signature(queries: list[dict[str, Any]]) -> str:
    normalized_queries = [
        _normalize_scope_query_for_signature(query)
        for query in queries
    ]
    normalized_queries.sort(key=lambda item: json.dumps(item, ensure_ascii=False, sort_keys=True))
    payload = json.dumps(normalized_queries, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def prune_preview_scope_cache() -> None:
    now = time.time()
    with _preview_scope_cache_lock:
        expired_keys = [
            cache_key
            for cache_key, entry in _preview_scope_cache.items()
            if now - float(entry.get("created_at") or 0) > PREVIEW_SCOPE_CACHE_TTL_SECONDS
        ]
        for cache_key in expired_keys:
            _preview_scope_cache.pop(cache_key, None)


def store_preview_scope_cache(
    cache_key: str,
    signature: str,
    records: list[PlatformRecord],
) -> None:
    prune_preview_scope_cache()
    with _preview_scope_cache_lock:
        _preview_scope_cache[cache_key] = {
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
    with _preview_scope_cache_lock:
        entry = _preview_scope_cache.get(cache_key)
    if entry is None or entry.get("signature") != signature:
        return None
    cached_records = [
        PlatformRecord.from_dict(item)
        for item in entry.get("records", [])
        if isinstance(item, dict)
    ]
    return get_platform_client().clone_records_for_scope(scope_id, cached_records)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.on_event("startup")
def recover_stale_runtime_state():
    with project_state_lock():
        state = load_state()
        if reconcile_runtime_state(state):
            persist_state(state)


@app.get("/api/jobs")
def list_jobs():
    return {"jobs": jobs_payload()}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = get_job_by_id(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job": job.to_dict()}


@app.get("/api/project")
def get_project():
    with project_state_lock():
        state = load_state()
        if reconcile_runtime_state(state):
            persist_state(state)
        return project_payload(state)


@app.get("/api/platform/matches")
def get_platform_matches():
    try:
        matches = get_platform_client().fetch_matches()
    except PlatformApiError as error:
        raise HTTPException(status_code=502, detail=str(error))
    return {"matches": matches}


@app.get("/api/platform/frequencies")
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
        raise HTTPException(status_code=502, detail=str(error))
    return {"frequencies": frequencies}


@app.get("/api/platform/team-countries")
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
        raise HTTPException(status_code=502, detail=str(error))
    return {"countries": countries}


@app.get("/api/platform/records")
def get_platform_records(
    match_id: str | None = None,
    match_name: str | None = None,
    frequency_info_ids: list[str] = Query(default_factory=list),
    venues: list[str] = Query(default_factory=list),
    category: str | None = None,
    sport_selection_keys: list[str] = Query(default_factory=list),
    sport_item_ids: str | None = None,
):
    ids = []
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
        raise HTTPException(status_code=502, detail=str(error))
    return {
        "count": len(records),
        "records": [format_platform_record_preview(record) for record in records],
    }


@app.post("/api/platform/records/preview-scope")
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
        raise HTTPException(status_code=502, detail=str(error))
    store_preview_scope_cache(cache_key, cache_key, records)
    return {
        "cache_key": cache_key,
        "count": len(records),
        "records": [format_platform_record_preview(record) for record in records],
    }


@app.post("/api/project/import")
async def import_project_files(request: Request):
    content_type = request.headers.get("content-type", "")
    import_inputs: list[dict[str, Any]] = []

    if "multipart/form-data" in content_type:
        form = await request.form()
        files = form.getlist("files")
        upload_files = [
            file for file in files
            if hasattr(file, "filename") and hasattr(file, "file")
        ]
        client_ids = [str(value).strip() for value in form.getlist("file_client_ids")]
        contexts_by_client_id = parse_contexts_json(
            form.get("contexts_json") if isinstance(form.get("contexts_json"), str) else None
        )
        import_inputs.extend(build_import_inputs(upload_files, client_ids, contexts_by_client_id))
    else:
        body = await request.body()
        payload = parse_json_body(body)
        import_inputs.extend(
            [
                {
                    "path": str(item.get("path") or ""),
                    **validate_platform_context(item),
                }
                for item in payload.get("files", [])
                if isinstance(item, dict)
            ]
        )

    if not import_inputs:
        raise HTTPException(status_code=400, detail="No files or paths provided")

    try:
        with project_state_lock():
            state = load_state()
            reconcile_runtime_state(state)
            imported_videos = import_videos_into_project(state, import_inputs)
            for video in imported_videos:
                records = get_platform_client().fetch_platform_records(video)
                state.replace_video_platform_records(video.id, records)
            if state.name == "Untitled Project":
                first_match_name = next((video.match_name for video in imported_videos if video.match_name), None)
                if first_match_name:
                    state.name = first_match_name
            persist_state(state)
    except PlatformApiError as error:
        raise HTTPException(status_code=502, detail=str(error))

    return {
        "imported_count": len(imported_videos),
        "imported_videos": [video.to_dict() for video in imported_videos],
        "project": project_payload(state),
    }


@app.post("/api/project/import-direct-clips")
async def import_direct_clip_files(request: Request):
    content_type = request.headers.get("content-type", "")
    import_inputs: list[dict[str, Any]] = []
    resolved_queries: list[dict[str, Any]] = []
    preview_cache_key: str | None = None

    if "multipart/form-data" in content_type:
        form = await request.form()
        files = form.getlist("files")
        import_inputs.extend(build_direct_clip_inputs(files))
        resolved_queries = parse_scope_queries_payload(form.get("scope_queries_json"))
        preview_cache_key = _coerce_str(form.get("preview_cache_key"))
    else:
        payload = parse_json_body(await request.body())
        resolved_queries = parse_scope_queries_payload(payload.get("scope_queries"))
        preview_cache_key = _coerce_str(payload.get("preview_cache_key"))
        import_inputs.extend(
            [
                {"path": str(item.get("path") or "")}
                for item in payload.get("files", [])
                if isinstance(item, dict)
            ]
        )

    if not import_inputs:
        raise HTTPException(status_code=400, detail="No files or paths provided")

    scope_id = new_id("scope")
    scope_queries = [PlatformScopeQuery.from_dict(query) for query in resolved_queries]
    scope_signature = build_scope_query_signature(resolved_queries)

    records = load_preview_scope_cache(preview_cache_key, scope_signature, scope_id=scope_id)
    if records is None:
        try:
            records = get_platform_client().fetch_scope_records(
                scope_id=scope_id,
                scope_queries=scope_queries,
            )
        except PlatformApiError as error:
            raise HTTPException(status_code=502, detail=str(error))
        store_preview_scope_cache(scope_signature, scope_signature, records)

    with project_state_lock():
        state = load_state()
        reconcile_runtime_state(state)
        state.upsert_platform_scope(
            PlatformScope(
                id=scope_id,
                mode="direct_clip_batch",
                query_groups=scope_queries,
            )
        )
        imported_videos, _ = import_direct_clips_into_project(
            state,
            import_inputs,
            platform_scope_id=scope_id,
            scope_summary=summarize_scope_queries(resolved_queries),
        )
        if imported_videos:
            state.replace_scope_platform_records(scope_id, records)
        else:
            state.remove_unreferenced_platform_scope(scope_id)
        if state.name == "Untitled Project":
            first_match_name = next((query.match_name for query in scope_queries if query.match_name), None)
            if first_match_name:
                state.name = first_match_name
        persist_state(state)

    return {
        "imported_count": len(imported_videos),
        "imported_videos": [video.to_dict() for video in imported_videos],
        "project": project_payload(state),
    }


@app.post("/api/project/detect")
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

                if current_stage == "start":
                    update_video_progress(
                        current_state,
                        video_id,
                        {
                            "stage": "start",
                            "message": "准备开始检测",
                            "completed": 0,
                            "total": 0,
                        },
                    )
                elif current_stage == "extracting":
                    completed = int(progress.get("completed", 0))
                    total = int(progress.get("total", 0))
                    update_video_progress(
                        current_state,
                        video_id,
                        {
                            "stage": "extracting",
                            "message": "正在采样视频帧",
                            "completed": completed,
                            "total": total,
                        },
                    )
                elif current_stage == "precheck_complete":
                    update_video_progress(
                        current_state,
                        video_id,
                        {
                            "stage": "precheck_complete",
                            "message": "预检查完成",
                            "completed": progress.get("precheck_passed", 0),
                            "total": progress.get("precheck_passed", 0),
                            "total_samples": progress.get("total_samples", 0),
                            "precheck_passed": progress.get("precheck_passed", 0),
                        },
                    )
                elif current_stage == "detecting":
                    current_name = progress.get("current_name") or "处理中"
                    update_video_progress(
                        current_state,
                        video_id,
                        {
                            "stage": "detecting",
                            "message": f"AI 检测中: {current_name}",
                            "completed": progress.get("completed", 0),
                            "total": progress.get("total", 0),
                            "current_name": progress.get("current_name"),
                            "matched": progress.get("matched", False),
                        },
                    )
                elif current_stage == "completed":
                    update_video_progress(
                        current_state,
                        video_id,
                        {
                            "stage": "completed",
                            "message": "检测完成",
                            "final_count": progress.get("final_count"),
                        },
                    )
                elif current_stage == "error":
                    update_video_progress(
                        current_state,
                        video_id,
                        {
                            "stage": "error",
                            "message": progress.get("message", "检测失败"),
                        },
                    )
                elif current_stage == "cancelled":
                    restore_video_after_detection_cancel(
                        current_state,
                        video_id,
                        str(progress.get("message") or "检测已取消"),
                    )

                persist_state(current_state)
            progress_callback(progress)
            last_persist["time"] = now
            last_persist["stage"] = current_stage

        from .detection_service import DetectionCancelledError

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
            raise HTTPException(status_code=400, detail="源视频文件不存在，请删除该任务后重新导入")
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
    return {
        "job": job.to_dict(),
        "project": project_payload(state),
    }


@app.post("/api/videos/{video_id}/cancel-detect")
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
            if job.kind == "detect" and job.video_id == video_id and job.status in {"queued", "running"}
        ]
        if not detect_jobs:
            raise HTTPException(status_code=409, detail="当前视频没有可取消的检测任务")

        queued_job = next((job for job in detect_jobs if job.status == "queued"), None)
        if queued_job is not None:
            cancelled_job = detect_job_manager.cancel_job(queued_job.id)
            if cancelled_job is None:
                raise HTTPException(status_code=409, detail="检测任务已开始执行，请稍后重试取消")
            restore_video_after_detection_cancel(state, video_id, "检测已取消")
            persist_state(state)
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
        return {
            "project": project_payload(state),
            "message": "已请求取消检测任务",
        }


@app.patch("/api/clips/{clip_id}")
async def update_clip(clip_id: str, request: Request):
    payload = parse_json_body(await request.body())
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


@app.post("/api/clips/{clip_id}/split")
async def split_clip_legacy(clip_id: str, request: Request):
    payload = parse_json_body(await request.body())
    split_at = payload.get("split_at")
    if split_at in (None, ""):
        raise HTTPException(status_code=400, detail="缺少拆分点")

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


@app.post("/api/clips/{clip_id}/split-segment")
async def split_clip_segment(clip_id: str, request: Request):
    payload = parse_json_body(await request.body())
    split_at = payload.get("split_at")
    segment_id = str(payload.get("segment_id") or "").strip()
    if split_at in (None, ""):
        raise HTTPException(status_code=400, detail="缺少拆分点")
    if not segment_id:
        raise HTTPException(status_code=400, detail="缺少选区ID")

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


@app.post("/api/clips/{clip_id}/extract-segment")
async def extract_clip_segment(clip_id: str, request: Request):
    payload = parse_json_body(await request.body())
    segment_id = str(payload.get("segment_id") or "").strip()
    if not segment_id:
        raise HTTPException(status_code=400, detail="缺少选区ID")

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


@app.post("/api/clips/{clip_id}/delete-segment")
async def delete_clip_segment(clip_id: str, request: Request):
    payload = parse_json_body(await request.body())
    segment_id = str(payload.get("segment_id") or "").strip()
    if not segment_id:
        raise HTTPException(status_code=400, detail="缺少选区ID")

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


@app.post("/api/project/candidate-clips/restore")
async def restore_candidate_clips(request: Request):
    payload = parse_json_body(await request.body())
    raw_candidate_clips = payload.get("candidate_clips")
    if not isinstance(raw_candidate_clips, list):
        raise HTTPException(status_code=400, detail="缺少候选片段快照")

    with project_state_lock():
        state = load_state()
        reconcile_runtime_state(state)

        restored_clips: list[CandidateClip] = []
        try:
            for item in raw_candidate_clips:
                if not isinstance(item, dict):
                    raise ValueError("候选片段快照格式错误")
                clip = CandidateClip.from_dict(item)
                video = state.get_video(clip.video_id)
                if video is None:
                    raise ValueError("候选片段对应的视频不存在")
                clip.segments = review_service._normalize_segments(
                    raw_segments=[segment.to_dict() for segment in clip.segments],
                    candidate_start=clip.candidate_start,
                    candidate_end=clip.candidate_end,
                    duration=video.duration,
                )
                review_service._sync_clip_summary(clip)
                clip.gap_start = None
                clip.gap_end = None
                restored_clips.append(clip)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error))

        state.candidate_clips = restored_clips
        for video in state.videos:
            review_service._recalculate_video_progress(state, video.id)
        state.rebuild_platform_record_links()
        state.touch()
        persist_state(state)
        return {
            "project": project_payload(state),
        }


@app.patch("/api/clips/{clip_id}/binding")
async def bind_clip_platform_record(clip_id: str, request: Request):
    payload = parse_json_body(await request.body())
    requested_record_id = payload.get("platform_record_id")
    platform_record_id = str(requested_record_id).strip() if requested_record_id is not None else None
    if platform_record_id == "":
        platform_record_id = None

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
                raise HTTPException(status_code=400, detail="当前片段只能绑定同一导入批次的卡片")
            existing_links = [linked_clip_id for linked_clip_id in record.linked_clip_ids if linked_clip_id != clip.id]
            if existing_links:
                raise HTTPException(status_code=400, detail="该平台成绩卡片已绑定其他片段，请先解绑")

        clip.linked_platform_record_id = platform_record_id
        clip.updated_at = utc_now_iso()
        state.rebuild_platform_record_links()
        persist_state(state)
        return {"project": project_payload(state)}


@app.delete("/api/videos/{video_id}")
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
                if job.kind == "detect" and job.video_id == video_id and job.status == "queued"
            ]
            if video.status == "detecting":
                raise HTTPException(status_code=409, detail="当前视频正在检测中，无法删除")

            for job in queued_detect_jobs:
                detect_job_manager.cancel_job(job.id)

            if has_active_job(video_id=video_id):
                raise HTTPException(status_code=409, detail="当前视频存在进行中的后台任务，无法删除")

        source_path = Path(video.file_path)
        if source_path.exists():
            try:
                if UPLOADS_DIR.resolve() in source_path.resolve().parents:
                    source_path.unlink()
            except OSError as error:
                raise HTTPException(status_code=500, detail=f"删除源视频失败: {error}")

        state.remove_video(video_id)
        persist_state(state)
        return project_payload(state)


@app.post("/api/videos/{video_id}/add-as-candidate")
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
        return project_payload(state)


@app.post("/api/project/export")
async def export_project(request: Request):
    payload = parse_json_body(await request.body())
    output_dir = str(payload.get("output_dir") or "").strip()
    export_mode = payload.get("export_mode", "standard")
    operation = str(payload.get("operation") or "export_and_upload").strip() or "export_and_upload"
    video_id = payload.get("video_id")
    clip_ids = payload.get("clip_ids")
    oss_access_key_id = str(payload.get("oss_access_key_id") or "").strip() or None
    oss_access_key_secret = str(payload.get("oss_access_key_secret") or "").strip() or None
    upload_parallel_files = _coerce_int(payload.get("upload_parallel_files")) or 2
    upload_part_threads = _coerce_int(payload.get("upload_part_threads")) or 4

    if not output_dir:
        raise HTTPException(status_code=400, detail="请选择导出目录")
    if operation not in {"export_only", "upload_only", "export_and_upload"}:
        raise HTTPException(status_code=400, detail="不支持的导出执行模式")
    if upload_parallel_files < 1:
        raise HTTPException(status_code=400, detail="同时上传文件数至少为 1")
    if upload_part_threads < 1:
        raise HTTPException(status_code=400, detail="单文件分片线程数至少为 1")

    with project_state_lock():
        state = load_state()
        reconcile_runtime_state(state)
        if has_active_job(kind="export"):
            raise HTTPException(status_code=409, detail="已有导出任务在运行")

        allowed_statuses = {"kept", "exported"} if clip_ids is not None else {"kept"}
        selected_clips = [
            clip
            for clip in state.candidate_clips
            if clip.status in allowed_statuses
            and (video_id is None or clip.video_id == video_id)
            and (clip_ids is None or clip.id in set(clip_ids))
        ]
        if not selected_clips:
            raise HTTPException(
                status_code=400,
                detail="没有可导出的已选片段" if clip_ids is not None else "没有可导出的保留片段",
            )

        if operation == "export_only":
            title = "仅导出所选片段" if clip_ids is not None else "仅导出已保留片段"
        elif operation == "upload_only":
            title = "仅上传所选片段" if clip_ids is not None else "仅上传已保留片段"
        else:
            title = "导出并上传所选片段" if clip_ids is not None else "导出并上传已保留片段"
        if video_id:
            video = find_video_or_404(state, video_id)
            if operation == "export_only":
                title = f"仅导出 {video.file_name}"
            elif operation == "upload_only":
                title = f"仅上传 {video.file_name}"
            else:
                title = f"导出并上传 {video.file_name}"

    def runner(progress_callback, _is_cancel_requested):
        current_state = load_state()
        reconcile_runtime_state(current_state)

        def persist_export_state(changed_clip_ids: set[str]) -> None:
            with project_state_lock():
                latest_state = load_state()
                reconcile_runtime_state(latest_state)
                merged_state = merge_export_state(latest_state, current_state, changed_clip_ids)
                persist_state(merged_state)

        result = get_export_service().export_kept_clips(
            current_state,
            output_dir=output_dir,
            export_mode=export_mode,
            operation=operation,
            video_id=video_id,
            clip_ids=clip_ids,
            oss_access_key_id=oss_access_key_id,
            oss_access_key_secret=oss_access_key_secret,
            progress_callback=progress_callback,
            state_change_callback=persist_export_state,
            upload_parallel_files=upload_parallel_files,
            upload_part_threads=upload_part_threads,
        )
        touched_clip_ids = {item.clip_id for item in result.clips}
        with project_state_lock():
            latest_state = load_state()
            reconcile_runtime_state(latest_state)
            merged_state = merge_export_state(latest_state, current_state, touched_clip_ids)
            persist_state(merged_state)
        return {
            "output_directory": result.output_directory,
            "attempted": result.attempted,
            "exported": result.exported,
            "failed": result.failed,
            "uploaded": result.uploaded,
            "synced": result.synced,
            "clips": [asdict(item) for item in result.clips],
        }

    job = export_job_manager.start_job(
        kind="export",
        title=title,
        runner=runner,
        video_id=video_id,
        initial_progress={
            "stage": "queued",
            "message": "等待任务开始",
            "completed": 0,
            "total": len(selected_clips),
            "output_directory": output_dir,
            "operation": operation,
            "steps_per_clip": 1 if operation == "export_only" else 2 if operation == "upload_only" else 3,
            "upload_parallel_files": upload_parallel_files,
            "upload_part_threads": upload_part_threads,
        },
    )
    return {
        "job": job.to_dict(),
        "project": project_payload(state),
    }


@app.get("/api/videos/{video_id}/stream")
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


@app.get("/api/videos/{video_id}/thumbnails")
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


@app.get("/api/thumbnails/{video_id}/{file_name}")
def get_thumbnail_file(video_id: str, file_name: str):
    path = get_thumbnail_service().resolve_file(video_id, file_name)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(path)
