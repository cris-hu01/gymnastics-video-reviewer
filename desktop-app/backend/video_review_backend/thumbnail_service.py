from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import cv2


logger = logging.getLogger(__name__)


@dataclass
class ThumbnailFrame:
    time_seconds: float
    file_name: str
    url: str


class ThumbnailService:
    def __init__(self, cache_root: str | Path, url_prefix: str = "/api/thumbnails") -> None:
        self.cache_root = Path(cache_root)
        self.url_prefix = url_prefix.rstrip("/")
        self.cache_root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _validate_component(component: str) -> None:
        """Reject a path component that is empty or could traverse the FS.

        Shared by the read path (resolve_file) and the write path
        (build_timeline) so both ends of the cache tree enforce the same
        rule — no `/`, `\\`, `..`, or empty segment.
        """
        if (
            not component
            or ".." in component
            or "/" in component
            or "\\" in component
        ):
            raise ValueError("invalid thumbnail path component")

    def build_timeline(
        self,
        *,
        video_id: str,
        video_path: str,
        start: float,
        end: float,
        count: int = 12,
        width: int = 160,
    ) -> list[ThumbnailFrame]:
        # video_id is internally generated, but validate the write-side join
        # too so the cache tree stays symmetric with resolve_file's checks.
        self._validate_component(video_id)
        safe_start = max(0.0, float(start))
        safe_end = max(safe_start + 0.1, float(end))
        safe_count = max(3, min(int(count), 24))
        target_dir = self.cache_root / video_id
        target_dir.mkdir(parents=True, exist_ok=True)

        times = self._sample_times(start=safe_start, end=safe_end, count=safe_count)
        missing = []
        frames: list[ThumbnailFrame] = []
        for timestamp in times:
            file_name = self._thumbnail_name(timestamp, width)
            file_path = target_dir / file_name
            if not file_path.exists():
                missing.append((timestamp, file_path))
            frames.append(
                ThumbnailFrame(
                    time_seconds=timestamp,
                    file_name=file_name,
                    url=f"{self.url_prefix}/{video_id}/{file_name}",
                )
            )

        if missing:
            self._generate_missing(video_path=video_path, width=width, targets=missing)

        return frames

    def resolve_file(self, video_id: str, file_name: str) -> Path:
        """Resolve a cached thumbnail path, rejecting path traversal.

        `video_id` / `file_name` arrive straight from URL path segments.
        uvicorn percent-decodes before routing, so multi-segment payloads
        (`..%2f..`) already 404 at the router — but encoded backslashes
        (`..%5c`) survive routing as a single segment and would traverse on
        Windows. Hence the explicit `/`, `\\` and `..` rejections, plus a
        post-resolve containment assertion as defense in depth.

        Raises ValueError for any component that is empty or attempts to
        escape the cache root.
        """
        for component in (video_id, file_name):
            self._validate_component(component)

        cache_root = self.cache_root.resolve()
        candidate = (cache_root / video_id / file_name).resolve()
        if not candidate.is_relative_to(cache_root):
            raise ValueError("thumbnail path escapes cache root")
        return candidate

    def _sample_times(self, *, start: float, end: float, count: int) -> list[float]:
        duration = max(0.1, end - start)
        if count <= 1:
            return [start + duration / 2]
        return [start + duration * (index / (count - 1)) for index in range(count)]

    def _thumbnail_name(self, timestamp: float, width: int) -> str:
        millis = int(round(timestamp * 1000))
        return f"thumb_{millis:010d}_{width}.jpg"

    def _generate_missing(
        self,
        *,
        video_path: str,
        width: int,
        targets: list[tuple[float, Path]],
    ) -> None:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise RuntimeError(f"无法打开视频生成缩略图: {video_path}")

        try:
            for timestamp, file_path in targets:
                cap.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
                ok, frame = cap.read()
                if not ok or frame is None:
                    continue

                height, original_width = frame.shape[:2]
                if original_width <= 0 or height <= 0:
                    continue

                scale = width / float(original_width)
                resized = cv2.resize(
                    frame,
                    (width, max(1, int(height * scale))),
                    interpolation=cv2.INTER_AREA,
                )
                success, encoded = cv2.imencode(
                    ".jpg",
                    resized,
                    [int(cv2.IMWRITE_JPEG_QUALITY), 82],
                )
                if not success:
                    continue
                file_path.write_bytes(encoded.tobytes())
        finally:
            cap.release()
