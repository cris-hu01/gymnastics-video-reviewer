"""Path traversal hardening tests for the thumbnail file endpoint.

Covers ThumbnailService.resolve_file directly (component validation +
containment assertion) and the HTTP surface `/api/thumbnails/{video_id}/{file_name}`.

Encoding notes (verified against uvicorn/Starlette routing behavior):
- `%2f` is percent-decoded *before* route matching, so `..%2f..` payloads
  become multi-segment paths and 404 at the router — they never reach the
  handler. Still asserted here as a regression guard.
- `%5c` (backslash) survives routing as a single path segment, so `..%5c`
  payloads DO reach the handler and would traverse on Windows without the
  explicit rejection in resolve_file.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from video_review_backend import api
from video_review_backend.deps import paths as deps_paths
from video_review_backend.deps import services as deps_services
from video_review_backend.thumbnail_service import ThumbnailService


SECRET_CONTENT = b"top-secret-outside-cache-root"
THUMB_CONTENT = b"fake-jpeg-bytes"


@pytest.fixture
def service(tmp_path: Path) -> ThumbnailService:
    cache_root = tmp_path / "thumbnails"
    svc = ThumbnailService(cache_root)
    video_dir = cache_root / "vid123"
    video_dir.mkdir(parents=True)
    (video_dir / "thumb_0000001000_160.jpg").write_bytes(THUMB_CONTENT)
    # Sensitive file *outside* the cache root that traversal would reach.
    (tmp_path / "secret.txt").write_bytes(SECRET_CONTENT)
    return svc


@pytest.fixture
def client(tmp_path: Path, service: ThumbnailService, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(deps_paths, "PROJECT_FILE", tmp_path / "project_state.json")
    monkeypatch.setattr(deps_services, "_thumbnail_service", service)
    with TestClient(api.app) as test_client:
        yield test_client


# ---------------------------------------------------------------------------
# Unit level: ThumbnailService.resolve_file
# ---------------------------------------------------------------------------

def test_resolve_file_returns_path_inside_cache_root(service: ThumbnailService):
    resolved = service.resolve_file("vid123", "thumb_0000001000_160.jpg")
    assert resolved.is_relative_to(service.cache_root.resolve())
    assert resolved.read_bytes() == THUMB_CONTENT


@pytest.mark.parametrize(
    ("video_id", "file_name"),
    [
        ("vid123", "..\\..\\secret.txt"),  # Windows separator traversal (..%5c)
        ("vid123", ".."),  # bare dot-dot
        ("vid123", "../secret.txt"),  # POSIX separator traversal
        ("vid123", "a/b.jpg"),  # embedded forward slash
        ("vid123", "a\\b.jpg"),  # embedded backslash
        ("..", "thumb.jpg"),  # traversal via video_id
        ("..\\..", "secret.txt"),  # backslash traversal via video_id
        ("", "thumb.jpg"),  # empty video_id
        ("vid123", ""),  # empty file_name
    ],
)
def test_resolve_file_rejects_traversal(service: ThumbnailService, video_id: str, file_name: str):
    with pytest.raises(ValueError):
        service.resolve_file(video_id, file_name)


# ---------------------------------------------------------------------------
# HTTP level: GET /api/thumbnails/{video_id}/{file_name}
# ---------------------------------------------------------------------------

def test_get_thumbnail_normal_file_ok(client: TestClient):
    response = client.get("/api/thumbnails/vid123/thumb_0000001000_160.jpg")
    assert response.status_code == 200
    assert response.content == THUMB_CONTENT


def test_get_thumbnail_rejects_encoded_backslash_traversal(client: TestClient):
    # `..%5c` stays a single segment through routing → must be blocked in-handler.
    response = client.get("/api/thumbnails/vid123/..%5c..%5csecret.txt")
    assert response.status_code == 404
    assert SECRET_CONTENT not in response.content


def test_get_thumbnail_rejects_backslash_traversal_in_video_id(client: TestClient):
    response = client.get("/api/thumbnails/..%5c..%5c/secret.txt")
    assert response.status_code == 404
    assert SECRET_CONTENT not in response.content


def test_get_thumbnail_rejects_bare_dotdot_segment(client: TestClient):
    # httpx normalizes literal `..` segments client-side; send the encoded
    # form `%2e%2e`, which uvicorn decodes back to `..` before the handler.
    response = client.get("/api/thumbnails/vid123/%2e%2e")
    assert response.status_code == 404


def test_get_thumbnail_encoded_forward_slash_is_rejected_at_router(client: TestClient):
    # uvicorn decodes %2f before route matching → extra path segments → 404
    # at the router. Regression guard for the routing-layer behavior the
    # in-handler checks complement.
    response = client.get("/api/thumbnails/vid123/..%2f..%2fsecret.txt")
    assert response.status_code == 404
    assert SECRET_CONTENT not in response.content
