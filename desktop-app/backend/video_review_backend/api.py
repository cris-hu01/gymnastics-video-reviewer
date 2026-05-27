from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .deps.constants import ALLOWED_CATEGORIES, MAG_SPORT_ITEM_IDS, WAG_SPORT_ITEM_IDS
from .deps.finders import find_video_or_404
from .deps.paths import (
    BACKEND_ROOT,
    EXPORTS_DIR,
    PROJECT_FILE,
    THUMBNAILS_DIR,
    UPLOADS_DIR,
    WORKSPACE_ROOT,
    ensure_workspace_dirs,
)
from .deps.scope_cache import (
    load_preview_scope_cache,
    prune_preview_scope_cache,
    store_preview_scope_cache,
)
from .deps.services import (
    detect_job_manager,
    export_job_manager,
    get_detection_service,
    get_export_service,
    get_platform_client,
    get_thumbnail_service,
    get_job_by_id,
    has_active_job,
    list_all_jobs,
    review_service,
)
from .deps.state import load_state, persist_state, project_state_lock
from .deps.state_helpers import (
    jobs_payload,
    merge_detect_video_state,
    merge_export_state,
    project_payload,
    reconcile_runtime_state,
    restore_video_after_detection_cancel,
    update_video_progress,
)
from .deps.validators import (
    _as_str_list,
    _coerce_int,
    _coerce_str,
    _normalize_venue_text,
    build_direct_clip_inputs,
    build_import_inputs,
    build_preview_video,
    build_scope_query_signature,
    format_platform_record_preview,
    parse_contexts_json,
    parse_json_body,
    parse_scope_queries_payload,
    persist_uploaded_file,
    resolve_frequency_context,
    validate_platform_context,
    validate_sport_item_ids,
    validate_sport_selection_keys,
)
from .jobs import JobCancelledError
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
from .platform_client import PlatformApiError, SPORT_ITEM_LABELS
from .video_import import (
    build_full_video_clip,
    import_direct_clips_into_project,
    import_videos_into_project,
    summarize_scope_queries,
)


ensure_workspace_dirs()


app = FastAPI(title="GymClip Reviewer API", version="1.2.1")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


_api_logger = logging.getLogger("gymclip.api.exception_handler")


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    """
    Catch-all for un-handled non-HTTP exceptions.
    HTTPException is handled by FastAPI's built-in handler, so 4xx is preserved.
    Sentry capture is automatic via sentry-sdk FastAPI integration if initialized.
    """
    _api_logger.exception(
        "Unhandled %s on %s %s",
        type(exc).__name__,
        request.method,
        request.url.path,
    )
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Internal server error",
            "error_type": type(exc).__name__,
        },
    )



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
        record.sport_item_id = int(raw) if raw is not None and str(raw).strip() != "" else None
    if "sport_item_label" in payload:
        record.sport_item_label = str(payload.get("sport_item_label") or "").strip()
    if "sex" in payload:
        raw = payload.get("sex")
        record.sex = int(raw) if raw is not None and str(raw).strip() != "" else None
    if "difficulty_score" in payload:
        record.difficulty_score = _normalize_local_card_score(payload.get("difficulty_score"), "0")
    if "execution_score" in payload:
        record.execution_score = _normalize_local_card_score(payload.get("execution_score"), "0")
    if "bonus_score" in payload:
        record.bonus_score = _normalize_local_card_score(payload.get("bonus_score"), "0")
    if "penalty_score" in payload:
        record.penalty_score = _normalize_local_card_score(payload.get("penalty_score"), "0")
    if "total_score" in payload:
        record.total_score = _normalize_local_card_score(payload.get("total_score"), "0")
    if record.sport_item_label == "" and record.sport_item_id is not None:
        record.sport_item_label = SPORT_ITEM_LABELS.get(record.sport_item_id, "")
    record.updated_at = utc_now_iso()


@app.post("/api/videos/{video_id}/local-cards")
async def create_local_card(video_id: str, request: Request):
    payload = parse_json_body(await request.body())
    if not str(payload.get("user_name") or "").strip():
        raise HTTPException(status_code=400, detail="姓名不能为空")
    sport_item_value = payload.get("sport_item_id")
    if sport_item_value is None or (isinstance(sport_item_value, str) and not sport_item_value.strip()):
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
        return {"record": record.to_dict(), "project": project_payload(state)}


@app.patch("/api/videos/{video_id}/local-cards/{record_id}")
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
        return {"record": record.to_dict(), "project": project_payload(state)}


@app.delete("/api/videos/{video_id}/local-cards/{record_id}")
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
        return {"project": project_payload(state)}


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
