from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import Any, Callable

from .media_binaries import resolve_ffmpeg_path
from .models import CandidateClip, PlatformRecord, ProjectState, VideoTask, utc_now_iso
from .oss_upload_service import OSSUploadService
from .platform_client import PlatformClient, SPORT_ITEM_LABELS


logger = logging.getLogger(__name__)


ProgressCallback = Callable[[dict[str, Any]], None]


DEFAULT_PLATFORM_SYNC_RETRY_ATTEMPTS = 3
DEFAULT_PLATFORM_SYNC_RETRY_BACKOFF_SECONDS = (1, 2, 4)


def _clean_path_component(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\\\|?*]+', "-", value.strip())
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    return cleaned or "未命名"


def _first_non_empty(*values: object) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _format_score_expression(values: list[str]) -> str:
    result = ""
    for index, value in enumerate(values):
        if index == 0:
            result = value
        elif value.startswith(("+", "-")):
            result = f"{result}{value}"
        else:
            result = f"{result}+{value}"
    return result


def _is_zero_score(value: str) -> bool:
    try:
        return float(value) == 0
    except (TypeError, ValueError):
        return False


def _coerce_sex(value: object) -> int | None:
    if value in (None, ""):
        return None
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        text = str(value).strip()
        if text in {"男", "男子", "M", "m"}:
            return 1
        if text in {"女", "女子", "W", "w"}:
            return 2
        return None
    return numeric if numeric in {1, 2} else None


def _derive_sex_from_text(*values: object) -> int | None:
    merged = "".join(str(value or "") for value in values)
    if "男子" in merged or "男" in merged:
        return 1
    if "女子" in merged or "女" in merged:
        return 2
    return None


def _derive_sex_from_sport_item(sport_item_id: int | None) -> int | None:
    if sport_item_id in {1, 2, 4, 5}:
        return 1
    if sport_item_id in {6, 7}:
        return 2
    return None


def _derive_sex_from_selection_keys(
    selection_keys: list[str],
    sport_item_id: int | None,
) -> int | None:
    if sport_item_id is None:
        return None
    matching_sexes: set[int] = set()
    for key in selection_keys:
        try:
            sex_part, sport_part = key.split(":", 1)
            if int(sport_part) != sport_item_id:
                continue
            sex = _coerce_sex(sex_part)
            if sex is not None:
                matching_sexes.add(sex)
        except (TypeError, ValueError):
            continue
    if len(matching_sexes) == 1:
        return next(iter(matching_sexes))
    return None


@dataclass
class ExportedClipResult:
    clip_id: str
    video_id: str
    output_file: str | None
    success: bool
    uploaded_object_key: str | None = None
    uploaded_url: str | None = None
    platform_synced: bool = False
    error_message: str | None = None


@dataclass
class ExportRunResult:
    output_directory: str
    attempted: int
    exported: int
    failed: int
    uploaded: int
    synced: int
    clips: list[ExportedClipResult]


class ExportService:
    def __init__(self) -> None:
        self.ffmpeg_path = resolve_ffmpeg_path()
        self.platform_client = PlatformClient()
        self.oss_upload_service = OSSUploadService()

    def export_kept_clips(
        self,
        state: ProjectState,
        output_dir: str,
        export_mode: str = "standard",
        operation: str = "export_and_upload",
        video_id: str | None = None,
        clip_ids: list[str] | None = None,
        oss_access_key_id: str | None = None,
        oss_access_key_secret: str | None = None,
        progress_callback: ProgressCallback | None = None,
        state_change_callback: Callable[[set[str]], None] | None = None,
        upload_parallel_files: int = 2,
        upload_part_threads: int = 4,
    ) -> ExportRunResult:
        if operation not in {"export_only", "upload_only", "export_and_upload"}:
            raise RuntimeError(f"不支持的导出执行模式: {operation}")
        if operation != "upload_only":
            self._ensure_ffmpeg()

        output_path = Path(output_dir).resolve()
        output_path.mkdir(parents=True, exist_ok=True)
        upload_parallel_files = max(1, int(upload_parallel_files or 1))
        upload_part_threads = max(1, int(upload_part_threads or 1))

        clips = self._select_exportable_clips(
            state=state,
            video_id=video_id,
            clip_ids=clip_ids,
        )
        ordered_clips = sorted(clips, key=lambda clip: (clip.video_id, clip.review_start, clip.id))
        ordered_clip_ids = [clip.id for clip in ordered_clips]
        per_video_index: dict[str, int] = {}
        results_by_clip_id: dict[str, ExportedClipResult] = {}
        steps_per_clip = 1 if operation == "export_only" else 2 if operation == "upload_only" else 3
        initial_stage = "oss_upload" if operation == "upload_only" else "local_export"
        initial_message = (
            "准备导出片段"
            if operation == "export_only"
            else "准备上传片段"
            if operation == "upload_only"
            else "准备导出并上传片段"
        )
        runtime_lock = RLock()
        upload_items: dict[str, dict[str, Any]] = {}
        upload_progress_fraction: dict[str, float] = {}
        local_export_completed = 0
        platform_completed = 0
        skipped_local_count = 0

        def _completed_steps_unlocked() -> float:
            completed_steps = float(local_export_completed)
            if operation != "export_only":
                completed_steps += sum(upload_progress_fraction.values())
                completed_steps += float(platform_completed)
            return completed_steps

        def _upload_completed_unlocked() -> int:
            return sum(1 for fraction in upload_progress_fraction.values() if fraction >= 1.0)

        def _snapshot_upload_items_unlocked() -> list[dict[str, Any]]:
            stage_order = {
                "queued": 0,
                "oss_upload": 1,
                "platform_callback": 2,
                "completed": 3,
                "failed": 4,
            }
            return sorted(
                (
                    {
                        **item,
                        "percent": round(float(item.get("percent") or 0.0), 1),
                        "speed_bps": float(item.get("speed_bps") or 0.0),
                    }
                    for item in upload_items.values()
                ),
                key=lambda item: (
                    stage_order.get(str(item.get("stage") or ""), 99),
                    str(item.get("file_name") or ""),
                    str(item.get("clip_id") or ""),
                ),
            )

        def _emit_export_progress(
            stage: str,
            message: str,
            *,
            clip_id: str | None = None,
            success: bool | None = None,
            error_message: str | None = None,
            output_file: str | None = None,
            uploaded_url: str | None = None,
            summary_file: str | None = None,
        ) -> None:
            with runtime_lock:
                upload_items_payload = _snapshot_upload_items_unlocked()
                aggregate_upload_speed_bps = sum(
                    float(item.get("speed_bps") or 0.0)
                    for item in upload_items_payload
                    if str(item.get("stage") or "") == "oss_upload"
                )
                active_upload_count = sum(
                    1 for item in upload_items_payload if str(item.get("stage") or "") == "oss_upload"
                )
                payload = {
                    "stage": stage,
                    "total": len(ordered_clips),
                    "completed": len(results_by_clip_id),
                    "operation": operation,
                    "steps_per_clip": steps_per_clip,
                    "message": message,
                    "output_directory": str(output_path),
                    "clip_id": clip_id,
                    "success": success,
                    "error_message": error_message,
                    "output_file": output_file,
                    "uploaded_url": uploaded_url,
                    "summary_file": summary_file,
                    "total_steps": len(ordered_clips) * steps_per_clip,
                    "completed_steps": _completed_steps_unlocked(),
                    "local_exported": local_export_completed,
                    "uploaded": _upload_completed_unlocked(),
                    "synced": platform_completed,
                    "skipped_local_count": skipped_local_count,
                    "upload_items": upload_items_payload,
                    "aggregate_upload_speed_bps": aggregate_upload_speed_bps,
                    "active_upload_count": active_upload_count,
                    "upload_parallel_files": upload_parallel_files,
                    "upload_part_threads": upload_part_threads,
                }
            self._emit(progress_callback, **payload)

        def _persist_export_state(changed_clip_ids: set[str]) -> None:
            with runtime_lock:
                self._update_video_statuses(state)
                state.touch()
                if state_change_callback is not None and changed_clip_ids:
                    state_change_callback(set(changed_clip_ids))

        self._emit(
            progress_callback,
            stage=initial_stage,
            total=len(ordered_clips),
            completed=0,
            operation=operation,
            steps_per_clip=steps_per_clip,
            message=initial_message,
            output_directory=str(output_path),
            total_steps=len(ordered_clips) * steps_per_clip,
            completed_steps=0,
            local_exported=0,
            uploaded=0,
            synced=0,
            skipped_local_count=0,
            upload_items=[],
            aggregate_upload_speed_bps=0.0,
            active_upload_count=0,
            upload_parallel_files=upload_parallel_files,
            upload_part_threads=upload_part_threads,
        )

        upload_work: list[dict[str, Any]] = []
        for clip in ordered_clips:
            video = state.get_video(clip.video_id)
            if video is None:
                with runtime_lock:
                    result = self._mark_export_failed(
                        clip=clip,
                        error_message=f"Video not found for clip: {clip.video_id}",
                    )
                    results_by_clip_id[clip.id] = result
                    _persist_export_state({clip.id})
                _emit_export_progress(
                    initial_stage,
                    result.error_message or "导出失败",
                    clip_id=clip.id,
                    success=False,
                    error_message=result.error_message,
                )
                continue

            platform_record = (
                state.get_platform_record(clip.linked_platform_record_id)
                if clip.linked_platform_record_id
                else None
            )
            is_local_record = platform_record is not None and platform_record.is_local
            if is_local_record and operation == "upload_only":
                skipped_local_count += 1
                with runtime_lock:
                    results_by_clip_id[clip.id] = ExportedClipResult(
                        clip_id=clip.id,
                        video_id=video.id,
                        output_file=clip.exported_path or "",
                        success=True,
                    )
                _emit_export_progress(
                    "progress",
                    "已跳过本地补录片段（不上传、不回写）",
                    clip_id=clip.id,
                    success=True,
                    output_file=clip.exported_path or None,
                )
                continue
            try:
                if operation == "upload_only":
                    with runtime_lock:
                        self._reset_clip_export_state(clip, keep_output_file=True)
                    source_file: Path | None = None
                    if clip.exported_path:
                        with runtime_lock:
                            clip.status = "exported"
                            clip.updated_at = utc_now_iso()
                            _persist_export_state({clip.id})
                        source_file = Path(clip.exported_path).resolve()
                    elif self._is_direct_source_upload_eligible(video, clip):
                        with runtime_lock:
                            source_file = self._rename_direct_source_for_upload(
                                video=video,
                                clip=clip,
                                state=state,
                            )
                            clip.status = "exported"
                            clip.updated_at = utc_now_iso()
                            _persist_export_state({clip.id})
                    else:
                        with runtime_lock:
                            clip.status = "exported"
                            clip.updated_at = utc_now_iso()
                            _persist_export_state({clip.id})
                    if source_file is None and not clip.exported_path:
                        raise RuntimeError("仅上传要求片段已有本地导出文件，或是未编辑的已有片段")
                    if platform_record is None:
                        raise RuntimeError("仅上传要求片段已绑定平台卡片")
                    if not source_file.exists():
                        raise RuntimeError(f"仅上传的本地导出文件不存在: {source_file}")
                    with runtime_lock:
                        upload_progress_fraction[clip.id] = 0.0
                        upload_items[clip.id] = {
                            "clip_id": clip.id,
                            "file_name": source_file.name,
                            "stage": "queued",
                            "bytes_sent": 0,
                            "total_bytes": source_file.stat().st_size,
                            "percent": 0.0,
                            "speed_bps": 0.0,
                            "error_message": None,
                        }
                    upload_work.append(
                        {
                            "clip": clip,
                            "video": video,
                            "platform_record": platform_record,
                            "source_file": source_file,
                        }
                    )
                    _emit_export_progress(
                        "oss_upload",
                        f"等待上传: {source_file.name}",
                        clip_id=clip.id,
                        output_file=str(source_file),
                    )
                    continue

                with runtime_lock:
                    self._reset_clip_export_state(clip)
                per_video_index[video.id] = per_video_index.get(video.id, 0) + 1
                output_file = self._build_output_file(
                    output_dir=output_path,
                    video=video,
                    clip=clip,
                    index=per_video_index[video.id],
                    state=state,
                )
                _emit_export_progress(
                    "local_export",
                    f"正在导出 {Path(output_file).name}",
                    clip_id=clip.id,
                )
                self._export_clip_media(
                    video_path=video.file_path,
                    clip=clip,
                    output_file=output_file,
                    export_mode=export_mode,
                )
                with runtime_lock:
                    clip.status = "exported"
                    clip.exported_path = str(output_file)
                    clip.export_error_message = None
                    clip.updated_at = utc_now_iso()
                    local_export_completed += 1
                    _persist_export_state({clip.id})

                if operation == "export_and_upload" and platform_record is not None and not is_local_record:
                    with runtime_lock:
                        upload_progress_fraction[clip.id] = 0.0
                        upload_items[clip.id] = {
                            "clip_id": clip.id,
                            "file_name": output_file.name,
                            "stage": "queued",
                            "bytes_sent": 0,
                            "total_bytes": output_file.stat().st_size,
                            "percent": 0.0,
                            "speed_bps": 0.0,
                            "error_message": None,
                        }
                    upload_work.append(
                        {
                            "clip": clip,
                            "video": video,
                            "platform_record": platform_record,
                            "source_file": output_file,
                        }
                    )
                    _emit_export_progress(
                        "progress",
                        f"已完成本地导出，等待上传: {output_file.name}",
                        clip_id=clip.id,
                        success=True,
                        output_file=str(output_file),
                    )
                    continue

                if is_local_record:
                    skipped_local_count += 1

                with runtime_lock:
                    results_by_clip_id[clip.id] = ExportedClipResult(
                        clip_id=clip.id,
                        video_id=video.id,
                        output_file=str(output_file),
                        success=True,
                    )
                _emit_export_progress(
                    "progress",
                    "已完成本地导出",
                    clip_id=clip.id,
                    success=True,
                    output_file=str(output_file),
                )
            except Exception as error:
                with runtime_lock:
                    result = self._mark_export_failed(clip=clip, error_message=str(error))
                    results_by_clip_id[clip.id] = result
                    _persist_export_state({clip.id})
                _emit_export_progress(
                    "progress",
                    result.error_message or "导出失败",
                    clip_id=clip.id,
                    success=False,
                    error_message=result.error_message,
                )

        def _process_upload(work_item: dict[str, Any]) -> ExportedClipResult:
            nonlocal platform_completed
            clip = work_item["clip"]
            video = work_item["video"]
            platform_record = work_item["platform_record"]
            source_file = Path(work_item["source_file"]).resolve()

            def _handle_upload_progress(consumed_bytes: int, total_bytes: int, speed_bps: float) -> None:
                with runtime_lock:
                    percent = (consumed_bytes / total_bytes * 100.0) if total_bytes > 0 else 0.0
                    upload_progress_fraction[clip.id] = min(1.0, max(0.0, percent / 100.0))
                    upload_items[clip.id] = {
                        **upload_items.get(clip.id, {}),
                        "clip_id": clip.id,
                        "file_name": source_file.name,
                        "stage": "oss_upload",
                        "bytes_sent": consumed_bytes,
                        "total_bytes": total_bytes,
                        "percent": percent,
                        "speed_bps": speed_bps,
                        "error_message": None,
                    }
                _emit_export_progress(
                    "oss_upload",
                    f"正在上传 OSS: {source_file.name}",
                    clip_id=clip.id,
                    output_file=str(source_file),
                )

            try:
                with runtime_lock:
                    clip.platform_sync_status = "uploading"
                    clip.platform_sync_error_message = None
                    clip.updated_at = utc_now_iso()
                    upload_items[clip.id] = {
                        **upload_items.get(clip.id, {}),
                        "clip_id": clip.id,
                        "file_name": source_file.name,
                        "stage": "queued",
                        "bytes_sent": 0,
                        "total_bytes": source_file.stat().st_size,
                        "percent": 0.0,
                        "speed_bps": 0.0,
                        "error_message": None,
                    }
                    _persist_export_state({clip.id})
                _emit_export_progress(
                    "oss_upload",
                    f"等待上传: {source_file.name}",
                    clip_id=clip.id,
                    output_file=str(source_file),
                )

                uploaded_object_key, uploaded_url = self._upload_clip_output(
                    source_file=source_file,
                    video=video,
                    clip=clip,
                    platform_record=platform_record,
                    access_key_id=oss_access_key_id,
                    access_key_secret=oss_access_key_secret,
                    num_threads=upload_part_threads,
                    progress_callback=_handle_upload_progress,
                )
                with runtime_lock:
                    upload_progress_fraction[clip.id] = 1.0
                    upload_items[clip.id] = {
                        **upload_items.get(clip.id, {}),
                        "stage": "platform_callback",
                        "bytes_sent": source_file.stat().st_size,
                        "total_bytes": source_file.stat().st_size,
                        "percent": 100.0,
                        "speed_bps": 0.0,
                        "error_message": None,
                    }
                    clip.platform_sync_status = "platform_callback"
                    clip.updated_at = utc_now_iso()
                    _persist_export_state({clip.id})
                _emit_export_progress(
                    "platform_callback",
                    f"正在回写平台 URL: {platform_record.user_name or platform_record.english_name or source_file.stem}",
                    clip_id=clip.id,
                    output_file=str(source_file),
                    uploaded_url=uploaded_url,
                )

                self._sync_platform_video_url(
                    clip=clip,
                    platform_record=platform_record,
                    source_file=source_file,
                    uploaded_url=uploaded_url,
                )
                result = ExportedClipResult(
                    clip_id=clip.id,
                    video_id=video.id,
                    output_file=str(source_file),
                    success=True,
                    uploaded_object_key=uploaded_object_key,
                    uploaded_url=uploaded_url,
                    platform_synced=True,
                )
                with runtime_lock:
                    platform_completed += 1
                    upload_items[clip.id] = {
                        **upload_items.get(clip.id, {}),
                        "stage": "completed",
                        "bytes_sent": source_file.stat().st_size,
                        "total_bytes": source_file.stat().st_size,
                        "percent": 100.0,
                        "speed_bps": 0.0,
                        "error_message": None,
                    }
                    results_by_clip_id[clip.id] = result
                    _persist_export_state({clip.id})
                _emit_export_progress(
                    "progress",
                    "已完成上传并回写",
                    clip_id=clip.id,
                    success=True,
                    output_file=str(source_file),
                    uploaded_url=uploaded_url,
                )
                return result
            except Exception as error:
                logger.exception(
                    "clip upload/platform-callback failed: clip_id=%s file=%s: %s",
                    clip.id, source_file, error,
                )
                with runtime_lock:
                    upload_items[clip.id] = {
                        **upload_items.get(clip.id, {}),
                        "stage": "failed",
                        "speed_bps": 0.0,
                        "error_message": str(error),
                    }
                    result = self._mark_export_failed(clip=clip, error_message=str(error))
                    results_by_clip_id[clip.id] = result
                    _persist_export_state({clip.id})
                _emit_export_progress(
                    "progress",
                    result.error_message or "上传失败",
                    clip_id=clip.id,
                    success=False,
                    error_message=result.error_message,
                    output_file=str(source_file),
                )
                return result

        if upload_work:
            with ThreadPoolExecutor(max_workers=upload_parallel_files, thread_name_prefix="gymclip-upload") as executor:
                futures = [executor.submit(_process_upload, work_item) for work_item in upload_work]
                for future in as_completed(futures):
                    future.result()

        with runtime_lock:
            self._update_video_statuses(state)
            state.touch()
        results = [results_by_clip_id[clip_id] for clip_id in ordered_clip_ids if clip_id in results_by_clip_id]
        summary = self._write_summary(
            output_dir=output_path,
            export_mode=export_mode,
            results=results,
        )
        _emit_export_progress(
            "completed",
            (
                "导出流程已完成"
                if operation == "export_only"
                else "上传流程已完成"
                if operation == "upload_only"
                else "导出上传流程已完成"
            ),
            summary_file=summary,
        )

        return ExportRunResult(
            output_directory=str(output_path),
            attempted=len(ordered_clips),
            exported=sum(1 for item in results if item.output_file),
            failed=sum(1 for item in results if not item.success),
            uploaded=sum(1 for item in results if item.uploaded_url),
            synced=sum(1 for item in results if item.platform_synced),
            clips=results,
        )

    def _reset_clip_export_state(
        self,
        clip: CandidateClip,
        *,
        keep_output_file: bool = False,
    ) -> None:
        if not keep_output_file:
            clip.exported_path = None
        clip.export_error_message = None
        clip.uploaded_object_key = None
        clip.uploaded_url = None
        clip.platform_sync_status = None
        clip.platform_sync_error_message = None
        clip.updated_at = utc_now_iso()

    def _is_direct_source_upload_eligible(self, video: VideoTask, clip: CandidateClip) -> bool:
        if video.source_kind != "direct_clip":
            return False
        if video.duration is None:
            return False
        segments = self._clip_segments(clip)
        if len(segments) != 1:
            return False
        segment_start, segment_end = segments[0]
        duration = float(video.duration)
        tolerance = 0.05
        return (
            abs(segment_start - 0.0) <= tolerance
            and abs(segment_end - duration) <= tolerance
            and abs(float(clip.review_start) - 0.0) <= tolerance
            and abs(float(clip.review_end) - duration) <= tolerance
            and abs(float(clip.candidate_start) - 0.0) <= tolerance
            and abs(float(clip.candidate_end) - duration) <= tolerance
        )

    def _build_direct_source_upload_path(
        self,
        *,
        video: VideoTask,
        clip: CandidateClip,
        source_file: Path,
        state: ProjectState,
    ) -> Path:
        record = state.get_platform_record(clip.linked_platform_record_id) if clip.linked_platform_record_id else None
        suffix = source_file.suffix or ".mp4"
        if record is not None:
            target_name = Path(self._build_bound_record_file_name(record)).with_suffix(suffix).name
        else:
            athlete_name = self._clean_name(clip.athlete_name) or "clip"
            if clip.country:
                athlete_name = f"{athlete_name}_{self._clean_name(clip.country)}"
            target_name = f"{Path(video.file_name).stem}_{athlete_name}{suffix}"
        target = source_file.with_name(target_name)
        if target == source_file:
            return target
        return self._ensure_unique_path(target)

    def _rename_direct_source_for_upload(
        self,
        *,
        video: VideoTask,
        clip: CandidateClip,
        state: ProjectState,
    ) -> Path:
        source_file = Path(video.file_path).resolve()
        if not source_file.exists():
            raise RuntimeError(f"原视频文件不存在: {source_file}")
        target = self._build_direct_source_upload_path(
            video=video,
            clip=clip,
            source_file=source_file,
            state=state,
        )
        if target != source_file:
            try:
                shutil.move(str(source_file), str(target))
            except OSError as error:
                raise RuntimeError(f"重命名原视频失败: {error}") from error
            video.file_path = str(target)
            video.file_name = target.name
            video.updated_at = utc_now_iso()
        clip.exported_path = str(target)
        clip.updated_at = utc_now_iso()
        return target

    def _upload_clip_output(
        self,
        *,
        source_file: Path,
        video: VideoTask,
        clip: CandidateClip,
        platform_record: PlatformRecord,
        access_key_id: str | None,
        access_key_secret: str | None,
        num_threads: int,
        progress_callback: Callable[[int, int, float], None] | None = None,
    ) -> tuple[str, str]:
        object_key = self._build_oss_object_key(video, platform_record, source_file.name)
        uploaded = self.oss_upload_service.upload_file(
            source_file,
            object_key,
            access_key_id=access_key_id,
            access_key_secret=access_key_secret,
            num_threads=num_threads,
            progress_callback=progress_callback,
        )
        clip.uploaded_object_key = uploaded.object_key
        clip.uploaded_url = uploaded.public_url
        clip.platform_sync_status = "uploading_done"
        clip.updated_at = utc_now_iso()
        return uploaded.object_key, uploaded.public_url

    def _sync_platform_video_url(
        self,
        *,
        clip: CandidateClip,
        platform_record: PlatformRecord,
        source_file: Path,
        uploaded_url: str,
    ) -> None:
        last_error: Exception | None = None
        for attempt in range(1, DEFAULT_PLATFORM_SYNC_RETRY_ATTEMPTS + 1):
            try:
                self.platform_client.update_video_urls(
                    [platform_record],
                    {
                        platform_record.id: {
                            "link": uploaded_url,
                            "originalName": source_file.name,
                        }
                    },
                )
                clip.platform_sync_status = "synced"
                clip.platform_sync_error_message = None
                clip.updated_at = utc_now_iso()
                if attempt > 1:
                    logger.info(
                        "platform writeback recovered on attempt %d for clip=%s",
                        attempt, clip.id,
                    )
                return
            except Exception as error:
                last_error = error
                logger.warning(
                    "platform writeback attempt %d/%d failed for clip=%s: %s",
                    attempt, DEFAULT_PLATFORM_SYNC_RETRY_ATTEMPTS, clip.id, error,
                )
                if attempt < DEFAULT_PLATFORM_SYNC_RETRY_ATTEMPTS:
                    time.sleep(DEFAULT_PLATFORM_SYNC_RETRY_BACKOFF_SECONDS[attempt - 1])
        assert last_error is not None
        raise last_error

    def _select_exportable_clips(
        self,
        state: ProjectState,
        video_id: str | None,
        clip_ids: list[str] | None,
    ) -> list[CandidateClip]:
        allowed_statuses = {"kept"}
        if clip_ids is not None:
            allowed_statuses.add("exported")
        clips = [clip for clip in state.candidate_clips if clip.status in allowed_statuses]
        if video_id is not None:
            clips = [clip for clip in clips if clip.video_id == video_id]
        if clip_ids is not None:
            clip_id_set = set(clip_ids)
            clips = [clip for clip in clips if clip.id in clip_id_set]
        return clips

    def _ensure_ffmpeg(self) -> None:
        try:
            subprocess.run([self.ffmpeg_path, "-version"], capture_output=True, check=True, text=True)
        except (subprocess.CalledProcessError, FileNotFoundError):
            raise RuntimeError("ffmpeg 未安装或不可用")

    def _build_output_file(
        self,
        output_dir: Path,
        video: VideoTask,
        clip: CandidateClip,
        index: int,
        state: ProjectState | None = None,
    ) -> Path:
        record = state.get_platform_record(clip.linked_platform_record_id) if state and clip.linked_platform_record_id else None
        target_dir = output_dir
        if record is not None:
            file_name = self._build_bound_record_file_name(record)
            if record.is_local:
                target_dir = output_dir / "本地补录"
                target_dir.mkdir(parents=True, exist_ok=True)
        else:
            video_name = Path(video.file_name).stem
            athlete_name = self._clean_name(clip.athlete_name) or "clip"
            if clip.country:
                athlete_name = f"{athlete_name}_{self._clean_name(clip.country)}"
            file_name = f"{video_name}_{index:02d}_{athlete_name}.mp4"
        target = target_dir / file_name
        return self._ensure_unique_path(target)

    def _build_bound_record_file_name(self, record: PlatformRecord) -> str:
        match_name = self._clean_name(record.match_name or "比赛")
        athlete_name = self._clean_name(record.user_name or record.english_name or "运动员")
        apparatus = self._clean_name(record.sport_item_label or SPORT_ITEM_LABELS.get(record.sport_item_id or -1, "项目"))
        score_value = self._clean_name(self._build_score_formula(record))
        return f"{match_name}-{athlete_name}-{apparatus}-{score_value}.mp4"

    def _build_score_formula(self, record: PlatformRecord) -> str:
        raw_record = record.raw_record or {}
        difficulty = _first_non_empty(record.difficulty_score, raw_record.get("difficultyScore"), raw_record.get("difficulty_score")) or "0"
        execution = _first_non_empty(record.execution_score, raw_record.get("executionScore"), raw_record.get("execution_score")) or "0"
        bonus = _first_non_empty(record.bonus_score, raw_record.get("bscore"), raw_record.get("bonusScore"), raw_record.get("bonus_score")) or "0"
        penalty = _first_non_empty(record.penalty_score, raw_record.get("penaltyScore"), raw_record.get("penalty_score")) or "0"
        total = _first_non_empty(record.total_score, raw_record.get("totalScore"), raw_record.get("total_score")) or "0"
        parts = [difficulty, execution]
        if not _is_zero_score(bonus):
            parts.append(bonus)
        if not _is_zero_score(penalty):
            parts.append(penalty)
        return f"{_format_score_expression(parts)}={total}"

    def _build_oss_object_key(self, video: VideoTask, record: PlatformRecord, file_name: str) -> str:
        match_name = _clean_path_component(record.match_name or video.match_name or "未命名比赛")
        category = _clean_path_component(record.category or video.category or "UNKNOWN")
        sex_folder = "M" if self._resolve_export_sex(video, record) == 1 else "W"
        apparatus = _clean_path_component(record.sport_item_label or "未命名项目")
        return f"uploads/{match_name}/{category}/{sex_folder}/{apparatus}/{file_name}"

    def _resolve_export_sex(self, video: VideoTask, record: PlatformRecord) -> int:
        explicit_sex = _coerce_sex(record.sex)
        if explicit_sex is None:
            explicit_sex = _coerce_sex((record.raw_record or {}).get("sex"))
        if explicit_sex is None:
            explicit_sex = _coerce_sex(video.sex)
        if explicit_sex is not None:
            return explicit_sex

        derived_from_text = _derive_sex_from_text(
            record.venue,
            (record.raw_record or {}).get("venue"),
            video.venue,
            *video.venues,
        )
        if derived_from_text is not None:
            return derived_from_text

        derived_from_selection = _derive_sex_from_selection_keys(
            video.sport_selection_keys,
            record.sport_item_id,
        )
        if derived_from_selection is not None:
            return derived_from_selection

        derived_from_sport_item = _derive_sex_from_sport_item(record.sport_item_id)
        if derived_from_sport_item is not None:
            return derived_from_sport_item

        return 2

    def _ensure_unique_path(self, target: Path) -> Path:
        if not target.exists():
            return target
        stem = target.stem
        suffix = target.suffix
        parent = target.parent
        for index in range(2, 1000):
            candidate = parent / f"{stem}_{index:02d}{suffix}"
            if not candidate.exists():
                return candidate
        raise RuntimeError(f"无法生成唯一文件名: {target.name}")

    def _export_clip_media(
        self,
        video_path: str,
        clip: CandidateClip,
        output_file: Path,
        export_mode: str,
    ) -> None:
        segments = self._clip_segments(clip)
        if len(segments) == 1:
            cmd = self._build_ffmpeg_command(
                video_path=video_path,
                start=segments[0][0],
                end=segments[0][1],
                output_file=output_file,
                export_mode=export_mode,
            )
            self._run_ffmpeg(cmd)
            return

        with tempfile.TemporaryDirectory(prefix="gymclip-export-") as temp_dir_name:
            temp_dir = Path(temp_dir_name)
            segment_files: list[Path] = []
            for index, (start, end) in enumerate(segments, start=1):
                segment_file = temp_dir / f"segment_{index:02d}.mp4"
                cmd = self._build_ffmpeg_command(
                    video_path=video_path,
                    start=start,
                    end=end,
                    output_file=segment_file,
                    export_mode=export_mode,
                )
                self._run_ffmpeg(cmd)
                segment_files.append(segment_file)

            list_file = temp_dir / "concat.txt"
            list_file.write_text(
                "\n".join(f"file '{path.as_posix()}'" for path in segment_files),
                encoding="utf-8",
            )
            concat_cmd = [
                self.ffmpeg_path,
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(list_file),
                "-c",
                "copy",
                "-loglevel",
                "warning",
                str(output_file),
            ]
            self._run_ffmpeg(concat_cmd)

    def _build_ffmpeg_command(
        self,
        video_path: str,
        start: float,
        end: float,
        output_file: Path,
        export_mode: str,
    ) -> list[str]:
        start = max(0.0, float(start))
        end = max(start, float(end))
        duration = end - start
        if duration <= 0:
            raise RuntimeError("无效的导出时间范围")

        start_ts = self._seconds_to_timestamp(start)
        common = [
            self.ffmpeg_path,
            "-y",
            "-ss",
            start_ts,
            "-i",
            video_path,
            "-t",
            str(duration),
        ]

        if export_mode == "fast":
            return common + [
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "23",
                "-c:a",
                "aac",
                "-avoid_negative_ts",
                "make_zero",
                "-loglevel",
                "warning",
                str(output_file),
            ]

        if export_mode != "standard":
            raise RuntimeError(f"不支持的导出模式: {export_mode}")

        return common + [
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-avoid_negative_ts",
            "make_zero",
            "-loglevel",
            "warning",
            str(output_file),
        ]

    def _clip_segments(self, clip: CandidateClip) -> list[tuple[float, float]]:
        if clip.segments:
            return [
                (max(0.0, float(segment.start)), max(float(segment.start), float(segment.end)))
                for segment in sorted(clip.segments, key=lambda item: (item.start, item.end, item.id))
            ]

        start = max(0.0, float(clip.review_start))
        end = max(start, float(clip.review_end))
        if clip.gap_start is None or clip.gap_end is None:
            return [(start, end)]
        gap_start = max(start, float(clip.gap_start))
        gap_end = min(end, float(clip.gap_end))
        if gap_end <= gap_start:
            return [(start, end)]
        return [
            (start, gap_start),
            (gap_end, end),
        ]

    def _run_ffmpeg(self, cmd: list[str]) -> None:
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            error_message = result.stderr.strip() or "ffmpeg 导出失败"
            raise RuntimeError(error_message)

    def _mark_export_failed(
        self,
        clip: CandidateClip,
        error_message: str,
    ) -> ExportedClipResult:
        clip.export_error_message = error_message
        clip.platform_sync_status = "failed"
        clip.platform_sync_error_message = error_message
        clip.updated_at = utc_now_iso()
        return ExportedClipResult(
            clip_id=clip.id,
            video_id=clip.video_id,
            output_file=clip.exported_path,
            success=False,
            uploaded_object_key=clip.uploaded_object_key,
            uploaded_url=clip.uploaded_url,
            platform_synced=False,
            error_message=error_message,
        )

    def _update_video_statuses(self, state: ProjectState) -> None:
        for video in state.videos:
            clips = state.get_video_clips(video.id)
            kept_remaining = any(clip.status == "kept" for clip in clips)
            exported_any = any(clip.status == "exported" for clip in clips)
            if exported_any and not kept_remaining:
                video.status = "done"
                video.updated_at = utc_now_iso()

    def _write_summary(
        self,
        output_dir: Path,
        export_mode: str,
        results: list[ExportedClipResult],
    ) -> str:
        summary = {
            "export_mode": export_mode,
            "attempted": len(results),
            "exported": sum(1 for item in results if item.output_file),
            "failed": sum(1 for item in results if not item.success),
            "uploaded": sum(1 for item in results if item.uploaded_url),
            "synced": sum(1 for item in results if item.platform_synced),
            "clips": [
                {
                    "clip_id": item.clip_id,
                    "video_id": item.video_id,
                    "output_file": item.output_file,
                    "success": item.success,
                    "uploaded_object_key": item.uploaded_object_key,
                    "uploaded_url": item.uploaded_url,
                    "platform_synced": item.platform_synced,
                    "error_message": item.error_message,
                }
                for item in results
            ],
        }
        summary_file = output_dir / "export_summary.json"
        summary_file.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return str(summary_file)

    def _clean_name(self, value: str) -> str:
        cleaned = re.sub(r"[^\w\u4e00-\u9fff\-+=.]+", "-", value.strip())
        cleaned = re.sub(r"-{2,}", "-", cleaned).strip("-")
        return cleaned or "未命名"

    def _seconds_to_timestamp(self, value: float) -> str:
        total = max(0.0, float(value))
        hours = int(total // 3600)
        minutes = int((total % 3600) // 60)
        seconds = total % 60
        return f"{hours:02d}:{minutes:02d}:{seconds:06.3f}"

    def retry_single_clip_stage(
        self,
        state: ProjectState,
        clip_id: str,
        stage: str,
        output_dir: str | None = None,
        oss_access_key_id: str | None = None,
        oss_access_key_secret: str | None = None,
    ) -> ExportedClipResult:
        clip = next((c for c in state.candidate_clips if c.id == clip_id), None)
        if clip is None:
            raise ValueError(f"片段不存在: {clip_id}")
        video = state.get_video(clip.video_id)
        if video is None:
            raise ValueError(f"视频不存在: {clip.video_id}")

        platform_record = (
            state.get_platform_record(clip.linked_platform_record_id)
            if clip.linked_platform_record_id
            else None
        )

        if stage == "export":
            if not output_dir:
                raise ValueError("重试导出需要提供输出目录")
            self._ensure_ffmpeg()
            output_path = Path(output_dir).resolve()
            output_path.mkdir(parents=True, exist_ok=True)
            out_file = self._build_output_file(output_path, video, clip, 1, state)
            self._export_clip_media(video.file_path, clip, out_file, "standard")
            clip.exported_path = str(out_file)
            clip.export_error_message = None
            clip.status = "exported"
            clip.updated_at = utc_now_iso()
            state.touch()
            return ExportedClipResult(
                clip_id=clip.id,
                video_id=clip.video_id,
                output_file=str(out_file),
                success=True,
            )

        if stage == "oss":
            if not clip.exported_path:
                raise ValueError("本地导出文件不存在，请先重试导出阶段")
            source_file = Path(clip.exported_path)
            if not source_file.is_file():
                raise ValueError(f"导出文件已丢失: {clip.exported_path}")
            if not platform_record:
                raise ValueError("片段未绑定平台记录，无法上传 OSS")
            if platform_record.is_local:
                raise ValueError("本地补录卡片绑定的片段不参与 OSS 上传")
            object_key, uploaded_url = self._upload_clip_output(
                source_file=source_file,
                video=video,
                clip=clip,
                platform_record=platform_record,
                access_key_id=oss_access_key_id,
                access_key_secret=oss_access_key_secret,
                num_threads=4,
            )
            state.touch()
            return ExportedClipResult(
                clip_id=clip.id,
                video_id=clip.video_id,
                output_file=clip.exported_path,
                success=True,
                uploaded_object_key=object_key,
                uploaded_url=uploaded_url,
            )

        if stage == "platform":
            if not clip.uploaded_url:
                raise ValueError("OSS 上传未完成，请先重试上传阶段")
            if not clip.exported_path:
                raise ValueError("本地导出文件不存在")
            if not platform_record:
                raise ValueError("片段未绑定平台记录，无法回写平台")
            if platform_record.is_local:
                raise ValueError("本地补录卡片绑定的片段不参与平台回写")
            self._sync_platform_video_url(
                clip=clip,
                platform_record=platform_record,
                source_file=Path(clip.exported_path),
                uploaded_url=clip.uploaded_url,
            )
            state.touch()
            return ExportedClipResult(
                clip_id=clip.id,
                video_id=clip.video_id,
                output_file=clip.exported_path,
                success=True,
                uploaded_object_key=clip.uploaded_object_key,
                uploaded_url=clip.uploaded_url,
                platform_synced=True,
            )

        raise ValueError(f"不支持的重试阶段: {stage}")

    def _emit(self, callback: ProgressCallback | None, **payload: Any) -> None:
        if callback is None:
            return
        callback(payload)
