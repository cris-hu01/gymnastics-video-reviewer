from __future__ import annotations

import logging
import os
import socket
import ssl
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import quote, urlparse

import requests

from .media_binaries import resolve_ossutil_path

try:
    import oss2
except ImportError:  # pragma: no cover - optional fallback
    oss2 = None


logger = logging.getLogger(__name__)


DEFAULT_BUCKET = "team-gymnastics"
DEFAULT_REGION = "cn-beijing"
DEFAULT_ENDPOINT = "https://oss-cn-beijing.aliyuncs.com"
DEFAULT_OSS_CONNECT_TIMEOUT_SECONDS = 30
DEFAULT_OSS_RETRY_ATTEMPTS = 3
DEFAULT_OSS_PART_RETRY_BACKOFF_SECONDS = (1, 2, 4)
DEFAULT_MULTIPART_THRESHOLD = 8 * 1024 * 1024
DEFAULT_PART_SIZE = 8 * 1024 * 1024
DEFAULT_UPLOAD_NUM_THREADS = 4


UploadProgressCallback = Callable[[int, int, float], None]


class OSSUploadError(RuntimeError):
    pass


@dataclass
class UploadedObject:
    object_key: str
    object_uri: str
    public_url: str


class OSSUploadService:
    def __init__(self) -> None:
        self.bucket = (os.environ.get("GYMCLIP_OSS_BUCKET") or DEFAULT_BUCKET).strip()
        self.region = (os.environ.get("GYMCLIP_OSS_REGION") or DEFAULT_REGION).strip()
        self.endpoint = (os.environ.get("GYMCLIP_OSS_ENDPOINT") or DEFAULT_ENDPOINT).strip()
        self.access_key_id = (os.environ.get("GYMCLIP_OSS_ACCESS_KEY_ID") or "").strip()
        self.access_key_secret = (os.environ.get("GYMCLIP_OSS_ACCESS_KEY_SECRET") or "").strip()

    def upload_file(
        self,
        local_file: str | Path,
        object_key: str,
        *,
        access_key_id: str | None = None,
        access_key_secret: str | None = None,
        num_threads: int | None = None,
        progress_callback: UploadProgressCallback | None = None,
    ) -> UploadedObject:
        source_path = Path(local_file).resolve()
        if not source_path.exists():
            logger.error("OSS upload aborted: source file missing: %s", source_path)
            raise OSSUploadError(f"待上传文件不存在: {source_path}")
        resolved_access_key_id = (access_key_id or self.access_key_id).strip()
        resolved_access_key_secret = (access_key_secret or self.access_key_secret).strip()
        if not resolved_access_key_id or not resolved_access_key_secret:
            logger.error("OSS upload aborted: credentials missing (bucket=%s region=%s)", self.bucket, self.region)
            raise OSSUploadError("缺少 OSS 凭证，请配置 GYMCLIP_OSS_ACCESS_KEY_ID 和 GYMCLIP_OSS_ACCESS_KEY_SECRET")

        normalized_key = object_key.strip().lstrip("/")
        if not normalized_key:
            logger.error("OSS upload aborted: empty object_key for %s", source_path)
            raise OSSUploadError("OSS 对象路径不能为空")

        object_uri = f"oss://{self.bucket}/{normalized_key}"
        resolved_threads = max(1, int(num_threads or DEFAULT_UPLOAD_NUM_THREADS))
        file_size = source_path.stat().st_size
        logger.info(
            "OSS upload start: path=%s size=%d bucket=%s region=%s endpoint=%s key=%s threads=%d backend=%s",
            source_path,
            file_size,
            self.bucket,
            self.region,
            self.endpoint,
            normalized_key,
            resolved_threads,
            "oss2" if oss2 is not None else "ossutil",
        )

        if oss2 is not None:
            return self._upload_with_oss2(
                source_path,
                normalized_key,
                resolved_access_key_id,
                resolved_access_key_secret,
                num_threads=resolved_threads,
                progress_callback=progress_callback,
            )

        endpoint_for_cli = self._endpoint_for_cli()
        env = {**os.environ}
        try:
            ossutil_path = resolve_ossutil_path()
        except RuntimeError:
            raise OSSUploadError("oss2 与 ossutil 均不可用，无法上传 OSS")
        command = [
            ossutil_path,
            "cp",
            str(source_path),
            object_uri,
            "--region",
            self.region,
            "-e",
            endpoint_for_cli,
            "-i",
            resolved_access_key_id,
            "-k",
            resolved_access_key_secret,
            "-f",
        ]
        try:
            result = subprocess.run(command, capture_output=True, text=True, env=env)
        except FileNotFoundError:
            logger.exception("ossutil binary not found at %s", ossutil_path)
            raise OSSUploadError("ossutil 不可用，且未安装 oss2，无法上传 OSS")
        if result.returncode != 0:
            logger.error(
                "ossutil upload failed: rc=%s stderr=%s stdout=%s",
                result.returncode,
                result.stderr.strip(),
                result.stdout.strip(),
            )
            raise OSSUploadError(result.stderr.strip() or result.stdout.strip() or "ossutil 上传失败")
        logger.info("ossutil upload ok: %s", object_uri)

        public_url = self._public_url(normalized_key)
        return UploadedObject(
            object_key=normalized_key,
            object_uri=object_uri,
            public_url=public_url,
        )

    def _endpoint_for_cli(self) -> str:
        parsed = urlparse(self.endpoint)
        return parsed.netloc or parsed.path or self.endpoint

    def _upload_with_oss2(
        self,
        source_path: Path,
        object_key: str,
        access_key_id: str,
        access_key_secret: str,
        *,
        num_threads: int,
        progress_callback: UploadProgressCallback | None,
    ) -> UploadedObject:
        if oss2 is None:
            raise OSSUploadError("ossutil 不可用，且未安装 oss2，无法上传 OSS")
        auth = oss2.Auth(access_key_id, access_key_secret)
        endpoint = self.endpoint if self.endpoint.startswith("http") else f"https://{self.endpoint}"
        bucket = oss2.Bucket(
            auth,
            endpoint,
            self.bucket,
            connect_timeout=DEFAULT_OSS_CONNECT_TIMEOUT_SECONDS,
            region=self.region,
        )
        tracker = self._build_progress_tracker(
            total_bytes=source_path.stat().st_size,
            callback=progress_callback,
        )
        file_size = source_path.stat().st_size
        outer_retry_attempts = DEFAULT_OSS_RETRY_ATTEMPTS
        for attempt in range(1, outer_retry_attempts + 1):
            try:
                if file_size < DEFAULT_MULTIPART_THRESHOLD:
                    logger.info(
                        "oss2 put_object attempt=%d key=%s size=%d",
                        attempt, object_key, file_size,
                    )
                    with source_path.open("rb") as file_handle:
                        bucket.put_object(
                            object_key,
                            file_handle,
                            progress_callback=tracker,
                        )
                else:
                    logger.info(
                        "oss2 multipart attempt=%d key=%s size=%d threads=%d part_size=%d",
                        attempt, object_key, file_size, num_threads, DEFAULT_PART_SIZE,
                    )
                    self._multipart_upload_with_progress(
                        bucket=bucket,
                        object_key=object_key,
                        source_path=source_path,
                        num_threads=max(1, int(num_threads)),
                        progress_callback=tracker,
                    )
                logger.info("oss2 upload ok: key=%s attempt=%d", object_key, attempt)
                break
            except Exception as error:  # pragma: no cover - network-dependent
                logger.exception(
                    "oss2 upload attempt=%d/%d failed for key=%s: %s",
                    attempt, outer_retry_attempts, object_key, error,
                )
                if attempt >= outer_retry_attempts:
                    raise OSSUploadError(str(error)) from error
                time.sleep(min(2 * attempt, 5))
        if tracker is not None:
            tracker(source_path.stat().st_size, source_path.stat().st_size)
        public_url = self._public_url(object_key)
        return UploadedObject(
            object_key=object_key,
            object_uri=f"oss://{self.bucket}/{object_key}",
            public_url=public_url,
        )

    def _multipart_upload_with_progress(
        self,
        *,
        bucket: "oss2.Bucket",
        object_key: str,
        source_path: Path,
        num_threads: int,
        progress_callback: Callable[[int, int], None] | None,
    ) -> None:
        total_bytes = source_path.stat().st_size
        init_result = bucket.init_multipart_upload(object_key)
        upload_id = init_result.upload_id
        part_size = DEFAULT_PART_SIZE
        part_ranges: list[tuple[int, int, int]] = []
        offset = 0
        part_number = 1
        while offset < total_bytes:
            current_size = min(part_size, total_bytes - offset)
            part_ranges.append((part_number, offset, current_size))
            offset += current_size
            part_number += 1

        part_progress: dict[int, int] = {number: 0 for number, _, _ in part_ranges}

        def emit_part_progress(target_part_number: int, consumed_bytes: int) -> None:
            if progress_callback is None:
                return
            part_progress[target_part_number] = max(0, consumed_bytes)
            progress_callback(sum(part_progress.values()), total_bytes)

        def upload_one_part(target_part_number: int, start: int, size: int):
            max_attempts = len(DEFAULT_OSS_PART_RETRY_BACKOFF_SECONDS) + 1
            for attempt in range(1, max_attempts + 1):
                try:
                    with source_path.open("rb") as file_handle:
                        file_handle.seek(start, os.SEEK_SET)
                        sized_reader = oss2.utils.SizedFileAdapter(file_handle, size)
                        progress_reader = oss2.utils.make_progress_adapter(
                            sized_reader,
                            lambda consumed_bytes, _total: emit_part_progress(target_part_number, int(consumed_bytes or 0)),
                            size=size,
                        )
                        result = bucket.upload_part(
                            object_key,
                            upload_id,
                            target_part_number,
                            progress_reader,
                        )
                    emit_part_progress(target_part_number, size)
                    return oss2.models.PartInfo(
                        target_part_number,
                        result.etag,
                        size=size,
                        part_crc=result.crc,
                    )
                except (
                    ssl.SSLError,
                    requests.exceptions.SSLError,
                    oss2.exceptions.RequestError,
                    socket.timeout,
                    OSError,
                ) as part_error:
                    logger.warning(
                        "oss2 part upload failed part=%d attempt=%d/%d key=%s size=%d: %s: %s",
                        target_part_number, attempt, max_attempts, object_key, size,
                        type(part_error).__name__, part_error,
                    )
                    if attempt >= max_attempts:
                        raise
                    emit_part_progress(target_part_number, 0)
                    time.sleep(DEFAULT_OSS_PART_RETRY_BACKOFF_SECONDS[attempt - 1])

        try:
            if num_threads <= 1 or len(part_ranges) <= 1:
                parts = [upload_one_part(number, start, size) for number, start, size in part_ranges]
            else:
                with ThreadPoolExecutor(max_workers=num_threads, thread_name_prefix="gymclip-oss-part") as executor:
                    futures = [
                        executor.submit(upload_one_part, number, start, size)
                        for number, start, size in part_ranges
                    ]
                    parts = [future.result() for future in as_completed(futures)]
            parts.sort(key=lambda item: item.part_number)
            bucket.complete_multipart_upload(object_key, upload_id, parts)
        except Exception:
            try:
                bucket.abort_multipart_upload(object_key, upload_id)
            except Exception:
                pass
            raise

    def _build_progress_tracker(
        self,
        *,
        total_bytes: int,
        callback: UploadProgressCallback | None,
    ) -> Callable[[int, int], None] | None:
        if callback is None:
            return None

        started_at = time.monotonic()
        last_emitted_at = started_at
        last_emitted_bytes = 0
        last_speed = 0.0

        def tracker(consumed_bytes: int, total: int) -> None:
            nonlocal last_emitted_at, last_emitted_bytes, last_speed
            now = time.monotonic()
            total_value = int(total or total_bytes or 0)
            consumed_value = int(consumed_bytes or 0)
            if consumed_value < last_emitted_bytes:
                last_emitted_bytes = consumed_value
                last_emitted_at = now
            delta_seconds = max(now - last_emitted_at, 1e-6)
            delta_bytes = max(0, consumed_value - last_emitted_bytes)
            should_emit = (
                consumed_value >= total_value
                or delta_seconds >= 0.05
                or delta_bytes >= 128 * 1024
            )
            if not should_emit:
                return
            if delta_bytes > 0:
                last_speed = delta_bytes / delta_seconds
            elif consumed_value >= total_value and total_value > 0:
                total_elapsed = max(now - started_at, 1e-6)
                last_speed = total_value / total_elapsed
            callback(consumed_value, total_value, last_speed)
            last_emitted_at = now
            last_emitted_bytes = consumed_value

        return tracker

    def _public_url(self, object_key: str) -> str:
        encoded_key = quote(object_key, safe="/")
        return f"https://{self.bucket}.oss-{self.region}.aliyuncs.com/{encoded_key}"
