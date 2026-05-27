from __future__ import annotations

import ssl
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from video_review_backend import oss_upload_service
from video_review_backend.oss_upload_service import OSSUploadService


class FakeBucket:
    def __init__(self) -> None:
        self.upload_part_calls = 0
        self.completed_parts = None
        self.abort_called = False

    def init_multipart_upload(self, _object_key: str) -> SimpleNamespace:
        return SimpleNamespace(upload_id="upload-id")

    def upload_part(self, _object_key: str, _upload_id: str, _part_number: int, progress_reader):
        self.upload_part_calls += 1
        progress_reader.read(4)
        if self.upload_part_calls < 3:
            raise ssl.SSLError("EOF occurred in violation of protocol")
        progress_reader.read()
        return SimpleNamespace(etag="etag-3", crc=12345)

    def complete_multipart_upload(self, _object_key: str, _upload_id: str, parts) -> None:
        self.completed_parts = parts

    def abort_multipart_upload(self, _object_key: str, _upload_id: str) -> None:
        self.abort_called = True


def test_multipart_upload_retries_ssl_failures_per_part(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_path = tmp_path / "sample.bin"
    source_path.write_bytes(b"abcdefghij")

    sleep_calls: list[int] = []
    progress_events: list[int] = []
    bucket = FakeBucket()
    service = OSSUploadService()

    monkeypatch.setattr(oss_upload_service.time, "sleep", lambda seconds: sleep_calls.append(seconds))

    service._multipart_upload_with_progress(
        bucket=bucket,
        object_key="test-object",
        source_path=source_path,
        num_threads=1,
        progress_callback=lambda consumed, _total: progress_events.append(consumed),
    )

    assert bucket.upload_part_calls == 3
    assert bucket.completed_parts is not None
    assert [part.part_number for part in bucket.completed_parts] == [1]
    assert not bucket.abort_called
    assert sleep_calls == [1, 2]
    assert progress_events.count(0) == 2
    assert progress_events[-1] == source_path.stat().st_size
