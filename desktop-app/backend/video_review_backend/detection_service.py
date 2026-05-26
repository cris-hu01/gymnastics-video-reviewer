from __future__ import annotations

import base64
import json
import os
import random
import re
import subprocess
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from threading import BoundedSemaphore, Lock
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
ExtractProgressCallback = Callable[[int, int], None]
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
    # Default is the benchmarked-winning V11 config: short prompt, crop ROI,
    # pHash dedup, 429 retry, concurrency=6. Set DET_* env vars to override.
    AI_MAX_CONCURRENCY = 6
    AI_REQUEST_TIMEOUT_SECONDS = 30.0

    _SHORT_PROMPT = (
        "分析这张体育赛事视频截图的底部字幕条区域。"
        "任务：确认底部是否有当前运动员信息字幕条（必须有明确的运动员姓名），"
        "通常是一条下三分之一横条，含国旗/国家代码 + 人名。"
        "如果是运动员字幕条，仅输出字幕中读到的运动员姓名（通常是 大写姓氏 + 名字 的格式）。"
        "如果不是（如广告、比分、排名榜、起跳顺序表、解说文字、地板横幅），输出 NO。"
        "只返回姓名或 NO，不要返回 JSON 或其他文字。"
    )
    _NO_VARIANTS = ("NO", "N/A", "NONE")
    _NO_PREFIXES_CN = ("无", "没有", "不是", "非", "否")
    # Matches "LASTNAME Firstname" (surname in caps first) OR
    # "Firstname LASTNAME" (surname in caps second). Captures whole name.
    _NAME_REGEX = re.compile(
        r"([A-Za-z][A-Za-z\-']+(?:\s+[A-Za-z][A-Za-z\-']+)+)"
    )
    _HAS_UPPERCASE_TOKEN = re.compile(r"\b[A-Z]{2,}[A-Z\-']*\b")

    def __init__(self, config_file: str | None = None) -> None:
        self.config_file = config_file
        concurrency = int(os.environ.get("DET_AI_CONCURRENCY", self.AI_MAX_CONCURRENCY))
        self._ai_request_semaphore = BoundedSemaphore(max(1, concurrency))
        # pHash L1 cache (populated only when DET_PHASH_DEDUP=1)
        self._phash_cache: "OrderedDict[int, dict[str, Any]]" = OrderedDict()
        self._phash_cache_lock = Lock()
        self._phash_cache_max = 256

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
                progress_callback=lambda completed, total: self._emit(
                    progress_callback,
                    stage="extracting",
                    video_id=video.id,
                    completed=completed,
                    total=total,
                ),
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
                "phash_hits": getattr(self, "_last_phash_hits", 0),
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
        progress_callback: ExtractProgressCallback | None = None,
    ) -> tuple[list[np.ndarray], list[float]]:
        if os.environ.get("DET_FFMPEG_EXTRACT") == "1":
            try:
                return self._extract_all_frames_ffmpeg(
                    video_path,
                    sample_interval,
                    cancel_requested=cancel_requested,
                    progress_callback=progress_callback,
                )
            except Exception as exc:  # noqa: BLE001
                print(f"[detection] ffmpeg extraction failed, falling back to cv2: {exc}", flush=True)

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return [], []

        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duration = total_frames / fps
        sample_times = np.arange(0, duration, sample_interval)
        total_samples = int(len(sample_times))

        frames: list[np.ndarray] = []
        frame_times: list[float] = []

        if progress_callback is not None and total_samples > 0:
            progress_callback(0, total_samples)

        try:
            for index, time_sec in enumerate(sample_times, start=1):
                self._ensure_not_cancelled(cancel_requested)
                frame_number = int(time_sec * fps)
                if frame_number >= total_frames:
                    break
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_number)
                ret, frame = cap.read()
                if ret:
                    frames.append(frame)
                    frame_times.append(float(time_sec))
                if progress_callback is not None and (index % 30 == 0 or index == total_samples):
                    progress_callback(index, total_samples)
        finally:
            cap.release()

        return frames, frame_times

    def _extract_all_frames_ffmpeg(
        self,
        video_path: str,
        sample_interval: float,
        cancel_requested: CancelRequestedCallback | None = None,
        progress_callback: ExtractProgressCallback | None = None,
    ) -> tuple[list[np.ndarray], list[float]]:
        """Use ffmpeg (hardware-accelerated when available) to decode frames
        sequentially at ``1/sample_interval`` fps, scaled so the short edge is
        540 px. Much faster than OpenCV's seek-per-sample approach on long
        H.264/H.265 videos. Produces BGR24 raw frames on stdout.
        """
        info = self._get_video_info(video_path)
        src_w = int(info["resolution"].split("x")[0])
        src_h = int(info["resolution"].split("x")[1])
        target_h = 540 if src_h > 540 else src_h
        target_w = int(round(src_w * target_h / src_h))
        if target_w % 2:
            target_w -= 1
        frame_bytes = target_w * target_h * 3

        duration = info["duration"]
        total_samples = int(max(0, duration // sample_interval))
        if progress_callback is not None and total_samples > 0:
            progress_callback(0, total_samples)

        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-hwaccel",
            "videotoolbox",
            "-i",
            video_path,
            "-an",
            "-sn",
            "-vf",
            f"fps=1/{sample_interval},scale={target_w}:{target_h}",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "pipe:1",
        ]

        frames: list[np.ndarray] = []
        frame_times: list[float] = []
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert proc.stdout is not None
        try:
            index = 0
            while True:
                self._ensure_not_cancelled(cancel_requested)
                buf = proc.stdout.read(frame_bytes)
                if not buf or len(buf) < frame_bytes:
                    break
                frame = np.frombuffer(buf, dtype=np.uint8).reshape((target_h, target_w, 3)).copy()
                frames.append(frame)
                frame_times.append(float(index * sample_interval))
                index += 1
                if progress_callback is not None and total_samples > 0 and (index % 30 == 0 or index == total_samples):
                    progress_callback(min(index, total_samples), total_samples)
        finally:
            try:
                proc.stdout.close()
            except Exception:
                pass
            proc.wait(timeout=5)

        if proc.returncode not in (0, None):
            err = (proc.stderr.read().decode("utf-8", "ignore") if proc.stderr else "").strip()
            raise RuntimeError(f"ffmpeg exited with {proc.returncode}: {err[:400]}")

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

    @staticmethod
    def _compute_phash(region: np.ndarray) -> int:
        """Compute a 64-bit pHash over the right 60% of the strip (name area)."""
        if region is None or region.size == 0:
            return 0
        h, w = region.shape[:2]
        x0 = int(w * 0.4)
        roi = region[:, x0:]
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY) if roi.ndim == 3 else roi
        resized = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
        dct = cv2.dct(resized)[:8, :8]
        flat = dct.flatten()
        median = np.median(flat[1:])  # exclude DC
        bits = flat > median
        value = 0
        for bit in bits:
            value = (value << 1) | int(bit)
        return int(value)

    @staticmethod
    def _hamming(a: int, b: int) -> int:
        return bin(a ^ b).count("1")

    def _phash_lookup(self, phash: int, max_distance: int = 5) -> dict[str, Any] | None:
        with self._phash_cache_lock:
            exact = self._phash_cache.get(phash)
            if exact is not None:
                self._phash_cache.move_to_end(phash)
                return dict(exact)
            for key in reversed(self._phash_cache):
                if self._hamming(key, phash) <= max_distance:
                    value = self._phash_cache[key]
                    self._phash_cache.move_to_end(key)
                    return dict(value)
        return None

    def _phash_store(self, phash: int, value: dict[str, Any]) -> None:
        with self._phash_cache_lock:
            self._phash_cache[phash] = dict(value)
            self._phash_cache.move_to_end(phash)
            while len(self._phash_cache) > self._phash_cache_max:
                self._phash_cache.popitem(last=False)

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
        phash_enabled = os.environ.get("DET_PHASH_DEDUP", "1") != "0"
        phash_hits = 0

        def process_frame(item: tuple[float, np.ndarray]) -> tuple[float, dict[str, Any], bool]:
            self._ensure_not_cancelled(cancel_requested)
            time_sec, bottom_region = item

            if phash_enabled:
                try:
                    phash = self._compute_phash(bottom_region)
                except Exception:  # noqa: BLE001
                    phash = 0
                if phash:
                    hit = self._phash_lookup(phash)
                    if hit is not None:
                        return time_sec, hit, True
            else:
                phash = 0

            acquired = False
            try:
                while not acquired:
                    self._ensure_not_cancelled(cancel_requested)
                    acquired = self._ai_request_semaphore.acquire(timeout=0.2)

                result = self._ai_extract_info(client, bottom_region, ai_backend)
                self._ensure_not_cancelled(cancel_requested)
                if phash_enabled and phash:
                    self._phash_store(phash, result)
                return time_sec, result, False
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
                    time_sec, result, from_cache = future.result()
                    if from_cache:
                        phash_hits += 1

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

        self._last_phash_hits = phash_hits
        return detections

    def _prepare_payload_image(self, image: np.ndarray) -> np.ndarray:
        """Crop to the subtitle text region and shrink the short edge.

        ``image`` is already the bottom 30% band of the frame. We further
        crop to y∈[0.267, 0.833] × x∈[0.08, 0.92] of the band (the text
        area, excluding the Cairo floor paint at the edges) and downsize
        so the shortest side is at most 448 px. Set ``DET_PAYLOAD_CROP=0``
        to disable and send the raw bottom-30% strip.
        """
        if os.environ.get("DET_PAYLOAD_CROP", "1") == "0":
            return image
        h, w = image.shape[:2]
        y0 = int(h * 0.267)
        y1 = int(h * 0.833)
        x0 = int(w * 0.08)
        x1 = int(w * 0.92)
        cropped = image[y0:y1, x0:x1]
        ch, cw = cropped.shape[:2]
        if min(ch, cw) > 448:
            scale = 448.0 / min(ch, cw)
            new_w = max(1, int(round(cw * scale)))
            new_h = max(1, int(round(ch * scale)))
            cropped = cv2.resize(cropped, (new_w, new_h), interpolation=cv2.INTER_AREA)
        return cropped

    def _parse_short_response(self, text: str) -> dict[str, Any]:
        raw = text.strip()
        if not raw:
            return {"is_athlete_subtitle": False, "athlete_name": "", "country": "", "confidence": 0.0}
        first_line = raw.splitlines()[0].strip().strip('"').strip("'")
        upper = first_line.upper()
        for nv in self._NO_VARIANTS:
            if upper.startswith(nv):
                return {"is_athlete_subtitle": False, "athlete_name": "", "country": "", "confidence": 0.8}
        if any(first_line.startswith(p) for p in self._NO_PREFIXES_CN):
            return {"is_athlete_subtitle": False, "athlete_name": "", "country": "", "confidence": 0.8}
        match = self._NAME_REGEX.search(first_line)
        if match and self._HAS_UPPERCASE_TOKEN.search(match.group(1)):
            name = " ".join(match.group(1).split())  # normalise whitespace
            return {
                "is_athlete_subtitle": True,
                "athlete_name": name,
                "country": "",
                "confidence": 0.8,
            }
        return {"is_athlete_subtitle": False, "athlete_name": "", "country": "", "confidence": 0.0, "raw": first_line[:80]}

    def _build_prompt(self) -> str:
        # Short prompt is default; set DET_PROMPT_MODE=json for the old verbose one.
        if os.environ.get("DET_PROMPT_MODE", "short") != "json":
            return self._SHORT_PROMPT
        return """分析这张体育赛事视频截图的底部字幕条区域。

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

    @staticmethod
    def _is_rate_limit_error(exc: Exception) -> bool:
        status = getattr(exc, "status_code", None)
        if status is None:
            response = getattr(exc, "response", None)
            status = getattr(response, "status_code", None)
        if status == 429:
            return True
        msg = str(exc).lower()
        return "429" in msg or "rate limit" in msg or "too many" in msg

    def _ai_extract_info(self, client: Any, image: np.ndarray, ai_backend: str) -> dict[str, Any]:
        payload_image = self._prepare_payload_image(image)
        jpeg_q = int(os.environ.get("DET_JPEG_QUALITY", 65))
        encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), jpeg_q]
        _, buffer = cv2.imencode(".jpg", payload_image, encode_param)
        image_base64 = base64.b64encode(buffer).decode("utf-8")

        prompt = self._build_prompt()
        short_mode = os.environ.get("DET_PROMPT_MODE", "short") != "json"
        retry_enabled = os.environ.get("DET_RETRY_ON_429", "1") != "0"

        zhipu_extra: dict[str, Any] = {}
        max_tokens_env = os.environ.get("DET_MAX_TOKENS", "64")
        if max_tokens_env and max_tokens_env != "0":
            zhipu_extra["max_tokens"] = int(max_tokens_env)
        temp_env = os.environ.get("DET_TEMPERATURE", "0.01")
        if temp_env:
            zhipu_extra["temperature"] = float(temp_env)

        max_attempts = 4 if retry_enabled else 1
        last_exc: Exception | None = None
        for attempt in range(max_attempts):
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
                        **zhipu_extra,
                    )
                    response_text = response.choices[0].message.content.strip()
                else:
                    message = client.messages.create(
                        model="claude-sonnet-4-20250514",
                        max_tokens=int(max_tokens_env) if max_tokens_env else 200,
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
                break  # success
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if retry_enabled and self._is_rate_limit_error(exc) and attempt < max_attempts - 1:
                    sleep = (2 ** attempt) + random.random()
                    time.sleep(min(sleep, 8.0))
                    continue
                return {"is_athlete_subtitle": False, "error": str(exc)}
        else:
            return {"is_athlete_subtitle": False, "error": str(last_exc) if last_exc else "unknown"}

        if short_mode:
            return self._parse_short_response(response_text)

        try:
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
