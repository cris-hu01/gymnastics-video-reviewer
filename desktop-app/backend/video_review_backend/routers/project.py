"""Project-level endpoints (read, import, export, restore)."""
from __future__ import annotations

import logging
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ..deps.finders import find_video_or_404
from ..deps.scope_cache import load_preview_scope_cache, store_preview_scope_cache
from ..deps.services import (export_job_manager, get_export_service,
                             get_platform_client, has_active_job,
                             review_service)
from ..deps.state import load_state, persist_state, project_state_lock
from ..deps.state_helpers import (merge_export_state, project_payload,
                                  reconcile_runtime_state)
from ..deps.validators import (_coerce_int, _coerce_str,
                               build_direct_clip_inputs, build_import_inputs,
                               build_scope_query_signature, parse_contexts_json,
                               parse_json_body, parse_scope_queries_payload,
                               validate_platform_context)
from ..jobs import JobCancelledError
from ..models import CandidateClip, PlatformScope, PlatformScopeQuery, new_id
from ..platform_client import PlatformApiError
from ..video_import import (import_direct_clips_into_project,
                            import_videos_into_project,
                            probe_import_video_inputs, summarize_scope_queries)


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/project", tags=["project"])


_EXPORT_OP_BASE_TITLE = {
    "export_only": ("仅导出所选片段", "仅导出已保留片段", "仅导出"),
    "upload_only": ("仅上传所选片段", "仅上传已保留片段", "仅上传"),
    "export_and_upload": ("导出并上传所选片段", "导出并上传已保留片段", "导出并上传"),
}


def _build_export_title(operation: str, has_clip_ids: bool, video_file_name: str | None) -> str:
    """Compose the user-facing export job title."""
    selected, full, named_prefix = _EXPORT_OP_BASE_TITLE[operation]
    if video_file_name:
        return f"{named_prefix} {video_file_name}"
    return selected if has_clip_ids else full


@router.get("")
def get_project():
    with project_state_lock():
        state = load_state()
        if reconcile_runtime_state(state):
            persist_state(state)
        return project_payload(state)


@router.post("/import")
async def import_project_files(request: Request):
    content_type = request.headers.get("content-type", "")
    import_inputs: list[dict[str, Any]] = []

    if "multipart/form-data" in content_type:
        form = await request.form()
        files = form.getlist("files")
        upload_files = [
            file
            for file in files
            if hasattr(file, "filename") and hasattr(file, "file")
        ]
        client_ids = [str(value).strip() for value in form.getlist("file_client_ids")]
        contexts_by_client_id = parse_contexts_json(
            form.get("contexts_json")
            if isinstance(form.get("contexts_json"), str)
            else None
        )
        import_inputs.extend(
            build_import_inputs(upload_files, client_ids, contexts_by_client_id)
        )
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

    logger.info("import_project_files count=%d", len(import_inputs))

    # 1) ffprobe metadata probing happens OUTSIDE the project-state lock so the
    #    per-file subprocess work doesn't block GET /api/project polling.
    metadata_by_path = probe_import_video_inputs(import_inputs)

    # 2) Briefly hold the lock to merge the imported videos into the *latest*
    #    state (re-read inside the lock — never overwrite with a stale snapshot).
    #    No ffprobe / network runs here; only the metadata we already probed.
    with project_state_lock():
        state = load_state()
        reconcile_runtime_state(state)
        imported_videos = import_videos_into_project(
            state, import_inputs, metadata_by_path=metadata_by_path
        )
        if state.name == "Untitled Project":
            first_match_name = next(
                (video.match_name for video in imported_videos if video.match_name),
                None,
            )
            if first_match_name:
                state.name = first_match_name
        persist_state(state)
        imported_video_ids = [video.id for video in imported_videos]

    # 3) Platform record fetching (network I/O) happens OUTSIDE the lock.
    records_by_video_id: dict[str, Any] = {}
    try:
        for video in imported_videos:
            records_by_video_id[video.id] = get_platform_client().fetch_platform_records(video)
    except PlatformApiError as error:
        logger.warning("import_project_files PlatformApiError: %s", error)
        raise HTTPException(status_code=502, detail=str(error))

    # 4) Re-acquire the lock briefly to attach the fetched records to videos that
    #    still exist in the latest state (a concurrent request may have removed one).
    with project_state_lock():
        state = load_state()
        reconcile_runtime_state(state)
        existing_video_ids = {video.id for video in state.videos}
        for video_id in imported_video_ids:
            if video_id in existing_video_ids and video_id in records_by_video_id:
                state.replace_video_platform_records(video_id, records_by_video_id[video_id])
        persist_state(state)

    logger.info(
        "import_project_files imported=%d names=%s",
        len(imported_videos),
        [video.file_name for video in imported_videos],
    )
    return {
        "imported_count": len(imported_videos),
        "imported_videos": [video.to_dict() for video in imported_videos],
        "project": project_payload(state),
    }


@router.post("/import-direct-clips")
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

    records = load_preview_scope_cache(
        preview_cache_key, scope_signature, scope_id=scope_id
    )
    if records is None:
        try:
            records = get_platform_client().fetch_scope_records(
                scope_id=scope_id,
                scope_queries=scope_queries,
            )
        except PlatformApiError as error:
            logger.warning("import_direct_clip_files fetch_scope_records: %s", error)
            raise HTTPException(status_code=502, detail=str(error))
        store_preview_scope_cache(scope_signature, scope_signature, records)

    logger.info(
        "import_direct_clip_files count=%d scope=%s",
        len(import_inputs),
        scope_id,
    )
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
            first_match_name = next(
                (query.match_name for query in scope_queries if query.match_name),
                None,
            )
            if first_match_name:
                state.name = first_match_name
        persist_state(state)

    logger.info(
        "import_direct_clip_files imported=%d scope=%s",
        len(imported_videos),
        scope_id,
    )
    return {
        "imported_count": len(imported_videos),
        "imported_videos": [video.to_dict() for video in imported_videos],
        "project": project_payload(state),
    }


@router.post("/candidate-clips/restore")
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
        logger.info("restore_candidate_clips restored=%d", len(restored_clips))
        return {
            "project": project_payload(state),
        }


@router.post("/export")
async def export_project(request: Request):
    payload = parse_json_body(await request.body())
    output_dir = str(payload.get("output_dir") or "").strip()
    export_mode = payload.get("export_mode", "standard")
    operation = (
        str(payload.get("operation") or "export_and_upload").strip()
        or "export_and_upload"
    )
    video_id = payload.get("video_id")
    clip_ids = payload.get("clip_ids")
    oss_access_key_id = str(payload.get("oss_access_key_id") or "").strip() or None
    oss_access_key_secret = (
        str(payload.get("oss_access_key_secret") or "").strip() or None
    )
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
                detail="没有可导出的已选片段"
                if clip_ids is not None
                else "没有可导出的保留片段",
            )

        video_file_name = (
            find_video_or_404(state, video_id).file_name if video_id else None
        )
        title = _build_export_title(operation, clip_ids is not None, video_file_name)

    steps_per_clip = {"export_only": 1, "upload_only": 2}.get(operation, 3)

    def _merge_and_persist(touched: set[str], current_state) -> None:
        with project_state_lock():
            latest_state = load_state()
            reconcile_runtime_state(latest_state)
            persist_state(merge_export_state(latest_state, current_state, touched))

    def runner(progress_callback, is_cancel_requested):
        current_state = load_state()
        reconcile_runtime_state(current_state)

        from ..export_service import ExportCancelledError

        try:
            result = get_export_service().export_kept_clips(
                current_state,
                output_dir=output_dir, export_mode=export_mode, operation=operation,
                video_id=video_id, clip_ids=clip_ids,
                oss_access_key_id=oss_access_key_id,
                oss_access_key_secret=oss_access_key_secret,
                progress_callback=progress_callback,
                state_change_callback=lambda ids: _merge_and_persist(ids, current_state),
                upload_parallel_files=upload_parallel_files,
                upload_part_threads=upload_part_threads,
                is_cancel_requested=is_cancel_requested,
            )
        except ExportCancelledError as error:
            # Persist whatever clips finished before the cancel boundary so the
            # project reflects the partial export, then surface cancellation.
            _merge_and_persist(
                {clip.id for clip in current_state.candidate_clips},
                current_state,
            )
            raise JobCancelledError(str(error))
        _merge_and_persist({item.clip_id for item in result.clips}, current_state)
        logger.info(
            "export_project completed attempted=%d exported=%d uploaded=%d synced=%d failed=%d",
            result.attempted, result.exported, result.uploaded, result.synced, result.failed,
        )
        return {
            "output_directory": result.output_directory,
            "attempted": result.attempted, "exported": result.exported,
            "failed": result.failed, "uploaded": result.uploaded,
            "synced": result.synced,
            "clips": [asdict(item) for item in result.clips],
        }

    job = export_job_manager.start_job(
        kind="export", title=title, runner=runner, video_id=video_id,
        initial_progress={
            "stage": "queued", "message": "等待任务开始",
            "completed": 0, "total": len(selected_clips),
            "output_directory": output_dir, "operation": operation,
            "steps_per_clip": steps_per_clip,
            "upload_parallel_files": upload_parallel_files,
            "upload_part_threads": upload_part_threads,
        },
    )
    logger.info(
        "export_project queued job=%s operation=%s clips=%d",
        job.id, operation, len(selected_clips),
    )
    return {"job": job.to_dict(), "project": project_payload(state)}
