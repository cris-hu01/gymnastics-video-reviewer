from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from threading import BoundedSemaphore
from typing import Any, Callable

import cv2
import numpy as np
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

from .models import CandidateClip, ClipSegment, DetectionBlock, ProjectState, VideoTask, new_id, utc_now_iso

try:
    from zhipuai import ZhipuAI

    HAS_ZHIPU = True
    ZHIPU_IMPORT_ERROR = None
except ImportError as e:
    HAS_ZHIPU = False
    ZHIPU_IMPORT_ERROR = e

try:
    import anthropic

    HAS_ANTHROPIC = True
    ANTHROPIC_IMPORT_ERROR = None
except ImportError as e:
    HAS_ANTHROPIC = False
    ANTHROPIC_IMPORT_ERROR = e


ProgressCallback = Callable[[dict[str, Any]], None]
CancelRequestedCallback = Callable[[], bool]


class DetectionCancelledError(RuntimeError):
    pass


@dataclass
class DetectionRunResult:
    video: VideoTask
    detection_blocks: list[DetectionBlock]
    candidate_clips: list[CandidateClip]
    stats: dict[str, Any]


class DetectionService:
    AI_MAX_CONCURRENCY = 4
    AI_REQUEST_TIMEOUT_SECONDS = 30.0

    def __init__(self, config_file: str | None = None) -> None:
        self.config_file = config_file
        self._ai_request_semaphore = BoundedSemaphore(self.AI_MAX_CONCURRENCY)

    def detect_video(
        self,
        state: ProjectState,
        video_id: str,
        api_key: str | None = None,
        progress_callback: ProgressCallback | None = None,
        cancel_requested: CancelRequestedCallback | None = None,
    ) -> DetectionRunResult:
        video = state.get_video(video_id)
        if video is None:
            raise ValueError(f"Video not found: {video_id}")

        settings = state.settings
        self._set_video_status(video, "detecting")
        video.detection_progress = {
            "stage": "start",
            "message": "准备开始检测",
            "completed": 0,
            "total": 0,
        }
        self._emit(progress_callback, stage="start", video_id=video.id, file_name=video.file_name)

        try:
            self._ensure_not_cancelled(cancel_requested)
            client = self._build_ai_client(
                ai_backend=settings.ai_backend,
                api_key=api_key,
            )
            video_info = self._get_video_info(video.file_path)
            frames, frame_times = self._extract_all_frames(
                video.file_path,
                settings.sampling_interval,
                cancel_requested=cancel_requested,
            )
            if not frames:
                raise RuntimeError("无法读取视频帧")
            total_samples = len(frames)

            self._ensure_not_cancelled(cancel_requested)
            candidates = self._precheck_candidates(
                frames=frames,
                frame_times=frame_times,
                start_seconds=0,
                end_seconds=None,
                skip_check=False,
                cancel_requested=cancel_requested,
            )
            precheck_passed = len(candidates)
            self._emit(
                progress_callback,
                stage="precheck_complete",
                video_id=video.id,
                total_samples=total_samples,
                precheck_passed=precheck_passed,
            )
            frames.clear()
            frame_times.clear()

            detections = self._run_ai_detection(
                client=client,
                ai_backend=settings.ai_backend,
                candidates=candidates,
                threads=settings.detection_threads,
                progress_callback=progress_callback,
                video_id=video.id,
                cancel_requested=cancel_requested,
            )

            self._ensure_not_cancelled(cancel_requested)
            merged = self._merge_detections(
                detections=detections,
                merge_threshold=settings.merge_threshold_seconds,
                sample_interval=settings.sampling_interval,
            )
            filtered = [
                item for item in merged if item.get("count", 1) >= settings.min_detection_count
            ]

            detection_blocks = self._build_detection_blocks(video.id, filtered)
            candidate_clips = self._build_candidate_clips(
                video=video,
                detection_blocks=detection_blocks,
                pre_padding_seconds=settings.pre_padding_seconds,
                video_duration=video_info["duration"],
            )

            state.remove_video_outputs(video.id)
            state.detection_blocks.extend(detection_blocks)
            state.candidate_clips.extend(candidate_clips)

            video.status = "no_candidates" if len(candidate_clips) == 0 else "ready_for_review"
            video.error_message = None
            video.total_candidates = len(candidate_clips)
            video.reviewed_candidates = 0
            video.detection_stats = {
                "resolution": video_info["resolution"],
                "duration": video_info["duration"],
                "sample_interval": settings.sampling_interval,
                "total_samples": total_samples,
                "precheck_passed": precheck_passed,
                "raw_detections": len(detections),
                "after_merge": len(merged),
                "final_count": len(filtered),
            }
            video.detection_progress = {
                "stage": "completed",
                "message": "检测完成",
                "completed": precheck_passed,
                "total": precheck_passed,
                "raw_detections": len(detections),
                "after_merge": len(merged),
                "final_count": len(filtered),
            }
            video.updated_at = utc_now_iso()
            state.touch()

            result = DetectionRunResult(
                video=video,
                detection_blocks=detection_blocks,
                candidate_clips=candidate_clips,
                stats=video.detection_stats,
            )
            self._emit(
                progress_callback,
                stage="completed",
                video_id=video.id,
                total_candidates=len(candidate_clips),
            )
            return result
        except DetectionCancelledError as e:
            self._restore_video_after_cancel(state, video, str(e))
            self._emit(
                progress_callback,
                stage="cancelled",
                video_id=video.id,
                message=str(e),
            )
            raise
        except Exception as e:
            self._set_video_status(video, "error", str(e))
            video.detection_progress = {
                "stage": "error",
                "message": str(e),
            }
            state.touch()
            self._emit(
                progress_callback,
                stage="error",
                video_id=video.id,
                message=str(e),
            )
            raise

    def _set_video_status(
        self,
        video: VideoTask,
        status: str,
        error_message: str | None = None,
    ) -> None:
        video.status = status
        video.error_message = error_message
        video.updated_at = utc_now_iso()

    def _emit(self, callback: ProgressCallback | None, **payload: Any) -> None:
        if callback:
            callback(payload)

    def _load_config(self) -> dict[str, Any]:
        for path in self._candidate_config_paths():
            if path.exists():
                try:
                    with path.open("r", encoding="utf-8") as f:
                        return json.load(f)
                except (OSError, json.JSONDecodeError):
                    return {}
        return {}

    def _candidate_config_paths(self) -> list[Path]:
        if self.config_file:
            return [Path(self.config_file)]

        module_path = Path(__file__).resolve()
        repo_root = module_path.parents[3]
        cwd_path = Path.cwd()
        return [
            cwd_path / "config.json",
            repo_root / "config.json",
        ]

    def _build_ai_client(self, ai_backend: str, api_key: str | None) -> Any:
        config = self._load_config()

        if ai_backend == "zhipu":
            resolved_key = (
                api_key
                or os.environ.get("ZHIPUAI_API_KEY")
                or config.get("zhipu_api_key")
            )
            if not resolved_key:
                raise RuntimeError("请配置智谱 API 密钥")
            if not HAS_ZHIPU:
                raise RuntimeError(f"智谱 SDK 导入失败: {ZHIPU_IMPORT_ERROR}")
            return ZhipuAI(
                api_key=resolved_key,
                timeout=self.AI_REQUEST_TIMEOUT_SECONDS,
            )

        resolved_key = (
            api_key
            or os.environ.get("ANTHROPIC_API_KEY")
            or config.get("anthropic_api_key")
        )
        if not resolved_key:
            raise RuntimeError("请配置 Claude API 密钥")
        if not HAS_ANTHROPIC:
            raise RuntimeError(f"Claude SDK 导入失败: {ANTHROPIC_IMPORT_ERROR}")
        return anthropic.Anthropic(
            api_key=resolved_key,
            timeout=self.AI_REQUEST_TIMEOUT_SECONDS,
        )

    def _get_video_info(self, video_path: str) -> dict[str, Any]:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise RuntimeError(f"无法打开视频: {video_path}")

        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        cap.release()

        if fps <= 0:
            raise RuntimeError(f"无法读取视频 FPS: {video_path}")

        duration = total_frames / fps
        return {
            "fps": fps,
            "total_frames": total_frames,
            "resolution": f"{width}x{height}",
            "duration": duration,
        }

    def _extract_all_frames(
        self,
        video_path: str,
        sample_interval: float,
        cancel_requested: CancelRequestedCallback | None = None,
    ) -> tuple[list[np.ndarray], list[float]]:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return [], []

        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duration = total_frames / fps
        sample_times = np.arange(0, duration, sample_interval)

        frames: list[np.ndarray] = []
        frame_times: list[float] = []

        try:
            for time_sec in sample_times:
                self._ensure_not_cancelled(cancel_requested)
                frame_number = int(time_sec * fps)
                if frame_number >= total_frames:
                    break
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_number)
                ret, frame = cap.read()
                if ret:
                    frames.append(frame)
                    frame_times.append(float(time_sec))
        finally:
            cap.release()

        return frames, frame_times

    def _precheck_candidates(
        self,
        frames: list[np.ndarray],
        frame_times: list[float],
        start_seconds: float,
        end_seconds: float | None,
        skip_check: bool,
        cancel_requested: CancelRequestedCallback | None = None,
    ) -> list[tuple[float, np.ndarray]]:
        candidates: list[tuple[float, np.ndarray]] = []

        for frame, time_sec in zip(frames, frame_times):
            self._ensure_not_cancelled(cancel_requested)
            if time_sec < start_seconds:
                continue
            if end_seconds is not None and time_sec > end_seconds:
                continue

            if skip_check:
                h = frame.shape[0]
                candidates.append((time_sec, frame[int(h * 0.7) :, :].copy()))
                continue

            has_subtitle, bottom_region = self._quick_subtitle_check(frame)
            if has_subtitle and bottom_region is not None:
                candidates.append((time_sec, bottom_region))

        return candidates

    def _quick_subtitle_check(
        self,
        frame: np.ndarray,
        bottom_ratio: float = 0.3,
    ) -> tuple[bool, np.ndarray | None]:
        if frame is None:
            return False, None

        h, _ = frame.shape[:2]
        bottom_start = int(h * (1 - bottom_ratio))
        bottom_region = frame[bottom_start:, :]

        gray = cv2.cvtColor(bottom_region, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 50, 150)
        edge_ratio = np.sum(edges > 0) / (edges.shape[0] * edges.shape[1])
        if edge_ratio < 0.015:
            return False, None

        brightness_std = np.std(gray)
        if brightness_std < 15:
            return False, None

        hsv = cv2.cvtColor(bottom_region, cv2.COLOR_BGR2HSV)
        saturation_std = np.std(hsv[:, :, 1])
        if saturation_std < 10:
            return False, None

        sobel_y = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
        horizontal_edges = np.sum(np.abs(sobel_y) > 50) / (gray.shape[0] * gray.shape[1])
        if horizontal_edges < 0.01:
            return False, None

        return True, bottom_region.copy()

    def _run_ai_detection(
        self,
        client: Any,
        ai_backend: str,
        candidates: list[tuple[float, np.ndarray]],
        threads: int,
        progress_callback: ProgressCallback | None,
        video_id: str,
        cancel_requested: CancelRequestedCallback | None = None,
    ) -> list[dict[str, Any]]:
        detections: list[dict[str, Any]] = []
        completed = 0

        def process_frame(item: tuple[float, np.ndarray]) -> tuple[float, dict[str, Any]]:
            self._ensure_not_cancelled(cancel_requested)
            time_sec, bottom_region = item
            acquired = False
            try:
                while not acquired:
                    self._ensure_not_cancelled(cancel_requested)
                    acquired = self._ai_request_semaphore.acquire(timeout=0.2)

                result = self._ai_extract_info(client, bottom_region, ai_backend)
                self._ensure_not_cancelled(cancel_requested)
                return time_sec, result
            finally:
                if acquired:
                    self._ai_request_semaphore.release()

        executor = ThreadPoolExecutor(max_workers=threads)
        futures = {executor.submit(process_frame, item): item for item in candidates}
        total = len(futures)
        cancelled = False

        pending = set(futures)

        try:
            while pending:
                self._ensure_not_cancelled(cancel_requested)
                done, pending = wait(
                    pending,
                    timeout=0.2,
                    return_when=FIRST_COMPLETED,
                )
                if not done:
                    continue

                for future in done:
                    self._ensure_not_cancelled(cancel_requested)
                    completed += 1
                    time_sec, result = future.result()

                    if result.get("is_athlete_subtitle"):
                        name = result.get("athlete_name", "")
                        if self._is_valid_athlete_name(name):
                            detections.append(
                                {
                                    "time_seconds": float(time_sec),
                                    "timestamp": str(timedelta(seconds=int(time_sec))),
                                    "athlete_name": name,
                                    "country": result.get("country", ""),
                                    "confidence": result.get("confidence", 0.0),
                                }
                            )

                    self._emit(
                        progress_callback,
                        stage="detecting",
                        video_id=video_id,
                        completed=completed,
                        total=total,
                        message=f"AI 检测中: {result.get('athlete_name') or '处理中'}",
                        current_name=result.get("athlete_name"),
                        matched=bool(result.get("is_athlete_subtitle")),
                    )
        except DetectionCancelledError:
            cancelled = True
            for future in futures:
                future.cancel()
            executor.shutdown(wait=False, cancel_futures=True)
            raise
        finally:
            if not cancelled:
                executor.shutdown(wait=True, cancel_futures=False)

        return detections

    def _ai_extract_info(self, client: Any, image: np.ndarray, ai_backend: str) -> dict[str, Any]:
        encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), 80]
        _, buffer = cv2.imencode(".jpg", image, encode_param)
        image_base64 = base64.b64encode(buffer).decode("utf-8")

        prompt = """分析这张体育赛事视频截图的底部字幕条区域。

任务：
1. 确认是否是运动员信息字幕条（必须有运动员姓名）
2. 提取运动员姓名（通常是 大写姓氏 + 名字 的格式，如 "ZHANG Wei"、"MARQUES Marcelo"）
3. 提取国家代码（3字母，如 CHN、BRA、USA、KOR、JPN）

重要：如果不是运动员字幕条（如广告、比分、解说文字），将 is_athlete_subtitle 设为 false。

请严格按以下JSON格式返回：
{
    "is_athlete_subtitle": true/false,
    "athlete_name": "运动员姓名",
    "country": "国家代码",
    "confidence": 0.9
}

只返回JSON，不要其他文字。"""

        try:
            if ai_backend == "zhipu":
                response = client.chat.completions.create(
                    model="glm-4v-flash",
                    timeout=self.AI_REQUEST_TIMEOUT_SECONDS,
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "image_url",
                                    "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"},
                                },
                                {"type": "text", "text": prompt},
                            ],
                        }
                    ],
                )
                response_text = response.choices[0].message.content.strip()
            else:
                message = client.messages.create(
                    model="claude-sonnet-4-20250514",
                    max_tokens=200,
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": "image/jpeg",
                                        "data": image_base64,
                                    },
                                },
                                {"type": "text", "text": prompt},
                            ],
                        }
                    ],
                    timeout=self.AI_REQUEST_TIMEOUT_SECONDS,
                )
                response_text = message.content[0].text.strip()

            if "```" in response_text:
                parts = response_text.split("```")
                for part in parts:
                    if "{" in part and "}" in part:
                        response_text = part
                        break
                if response_text.startswith("json"):
                    response_text = response_text[4:]

            result = json.loads(response_text)
            if isinstance(result, list):
                if result and isinstance(result[0], dict):
                    result = result[0]
                else:
                    result = {"is_athlete_subtitle": False}

            for key in ["athlete_name", "country"]:
                if key in result and isinstance(result[key], list):
                    result[key] = str(result[key][0]) if result[key] else ""

            return result
        except json.JSONDecodeError:
            return {"is_athlete_subtitle": False, "error": "JSON解析失败"}
        except Exception as e:
            return {"is_athlete_subtitle": False, "error": str(e)}

    def _is_valid_athlete_name(self, name: str) -> bool:
        if not name or len(name) < 3:
            return False

        invalid_keywords = [
            "final",
            "semi",
            "round",
            "heat",
            "group",
            "stage",
            "score",
            "rank",
            "medal",
            "gold",
            "silver",
            "bronze",
            "china",
            "japan",
            "korea",
            "brazil",
            "usa",
            "team",
            "男子",
            "女子",
            "决赛",
            "半决赛",
            "预赛",
            "比赛",
            "分数",
            "得分",
            "总分",
            "成绩",
            "排名",
            "第",
            "名",
            "分",
            "秒",
            "米",
            "公斤",
        ]

        name_lower = name.lower()
        for keyword in invalid_keywords:
            if keyword in name_lower:
                return False

        words = name.replace("-", " ").split()
        if len(words) >= 2:
            return True
        if name[0].isupper() or name.isupper():
            return True
        return False

    def _merge_detections(
        self,
        detections: list[dict[str, Any]],
        merge_threshold: float,
        sample_interval: float,
    ) -> list[dict[str, Any]]:
        if not detections:
            return []

        ordered = sorted(detections, key=lambda x: x["time_seconds"])
        merged: list[dict[str, Any]] = []
        current = ordered[0].copy()
        current["start_seconds"] = current["time_seconds"]
        current["end_seconds"] = current["time_seconds"]
        current["count"] = 1

        for det in ordered[1:]:
            gap = det["time_seconds"] - current["end_seconds"]
            current_name = current.get("athlete_name", "").upper().strip()
            det_name = det.get("athlete_name", "").upper().strip()

            same_athlete = (
                current_name == det_name
                or current_name in det_name
                or det_name in current_name
                or (current_name.split()[0] if current_name.split() else "")
                == (det_name.split()[0] if det_name.split() else "")
            )

            if gap <= merge_threshold and same_athlete:
                current["end_seconds"] = det["time_seconds"]
                current["count"] += 1
                if len(det_name) > len(current_name):
                    current["athlete_name"] = det["athlete_name"]
                    current["country"] = det.get("country", current.get("country", ""))
                    current["confidence"] = det.get("confidence", current.get("confidence", 0.0))
            else:
                current["duration"] = (
                    current["end_seconds"] - current["start_seconds"] + sample_interval
                )
                merged.append(current)
                current = det.copy()
                current["start_seconds"] = det["time_seconds"]
                current["end_seconds"] = det["time_seconds"]
                current["count"] = 1

        current["duration"] = current["end_seconds"] - current["start_seconds"] + sample_interval
        merged.append(current)
        return merged

    def _build_detection_blocks(
        self,
        video_id: str,
        filtered: list[dict[str, Any]],
    ) -> list[DetectionBlock]:
        blocks: list[DetectionBlock] = []
        now = utc_now_iso()

        for item in filtered:
            blocks.append(
                DetectionBlock(
                    id=new_id("det"),
                    video_id=video_id,
                    athlete_name=item.get("athlete_name", ""),
                    country=item.get("country", ""),
                    subtitle_start=float(item.get("start_seconds", 0.0)),
                    subtitle_end=float(item.get("end_seconds", item.get("start_seconds", 0.0))),
                    confidence=float(item.get("confidence", 0.0)),
                    count=int(item.get("count", 1)),
                    timestamp=item.get("timestamp", ""),
                    created_at=now,
                    updated_at=now,
                )
            )
        return blocks

    def _build_candidate_clips(
        self,
        video: VideoTask,
        detection_blocks: list[DetectionBlock],
        pre_padding_seconds: float,
        video_duration: float | None,
    ) -> list[CandidateClip]:
        ordered = sorted(detection_blocks, key=lambda block: block.subtitle_start)
        clips: list[CandidateClip] = []

        for index, block in enumerate(ordered):
            if index + 1 < len(ordered):
                candidate_end = ordered[index + 1].subtitle_start
            elif video_duration is not None:
                candidate_end = video_duration
            else:
                candidate_end = block.subtitle_end

            candidate_start = max(0.0, block.subtitle_start - pre_padding_seconds)
            if candidate_end <= candidate_start:
                candidate_end = max(candidate_start + 1.0, block.subtitle_end)

            now = utc_now_iso()
            clips.append(
                CandidateClip(
                    id=new_id("clip"),
                    video_id=video.id,
                    detection_block_id=block.id,
                    athlete_name=block.athlete_name,
                    country=block.country,
                    subtitle_start=block.subtitle_start,
                    subtitle_end=block.subtitle_end,
                    candidate_start=candidate_start,
                    candidate_end=candidate_end,
                    review_start=candidate_start,
                    review_end=candidate_end,
                    segments=[
                        ClipSegment(
                            id=new_id("seg"),
                            start=candidate_start,
                            end=candidate_end,
                        )
                    ],
                    confidence=block.confidence,
                    status="pending",
                    created_at=now,
                    updated_at=now,
                )
            )

        return clips

    def _ensure_not_cancelled(
        self,
        cancel_requested: CancelRequestedCallback | None,
    ) -> None:
        if cancel_requested and cancel_requested():
            raise DetectionCancelledError("检测已取消")

    def _restore_video_after_cancel(
        self,
        state: ProjectState,
        video: VideoTask,
        message: str,
    ) -> None:
        clips = state.get_video_clips(video.id)
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
