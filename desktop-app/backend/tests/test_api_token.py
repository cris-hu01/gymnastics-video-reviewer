"""Local API token auth + CORS middleware ordering tests.

The Electron main process injects GYMCLIP_API_TOKEN into the backend's env.
When set, every /api request must carry the token via the X-Gymclip-Token
header or the `?token=` query param. When unset (pytest / bare dev backend),
auth is disabled.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from video_review_backend import api
from video_review_backend.deps import paths as deps_paths


TOKEN = "a" * 64  # shape of crypto.randomBytes(32).toString('hex')


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(deps_paths, "PROJECT_FILE", tmp_path / "project_state.json")
    with TestClient(api.app) as test_client:
        yield test_client


@pytest.fixture
def token_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(api.API_TOKEN_ENV_VAR, TOKEN)


@pytest.fixture
def no_token_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv(api.API_TOKEN_ENV_VAR, raising=False)


@pytest.fixture
def empty_token_env(monkeypatch: pytest.MonkeyPatch):
    # Distinct from unset: must NOT be treated as dev mode (fail-closed).
    monkeypatch.setenv(api.API_TOKEN_ENV_VAR, "")


@pytest.fixture
def short_token_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(api.API_TOKEN_ENV_VAR, "tooshort")  # len 8 < 32


# ---------------------------------------------------------------------------
# Token enforced when env var is set
# ---------------------------------------------------------------------------

def test_missing_token_is_401(token_env, client: TestClient):
    response = client.get("/api/health")
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid or missing API token"


def test_valid_header_token_is_200(token_env, client: TestClient):
    response = client.get("/api/health", headers={api.API_TOKEN_HEADER: TOKEN})
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_valid_query_token_is_200(token_env, client: TestClient):
    # Media elements (<video>/<img>) cannot attach headers — query fallback.
    response = client.get("/api/health", params={"token": TOKEN})
    assert response.status_code == 200


def test_wrong_header_token_is_401(token_env, client: TestClient):
    response = client.get("/api/health", headers={api.API_TOKEN_HEADER: "b" * 64})
    assert response.status_code == 401


def test_wrong_query_token_is_401(token_env, client: TestClient):
    response = client.get("/api/health", params={"token": "nope"})
    assert response.status_code == 401


def test_non_api_paths_are_exempt(token_env, client: TestClient):
    # /openapi.json lives outside the /api prefix; the Electron main process
    # probes it (ensureBackendCompatibility) and must not be locked out.
    response = client.get("/openapi.json")
    assert response.status_code == 200


def test_cors_preflight_bypasses_token_check(token_env, client: TestClient):
    # CORSMiddleware is the OUTER layer: an OPTIONS preflight (which cannot
    # carry the custom token header) must be answered by CORS, not 401'd.
    response = client.options(
        "/api/health",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": api.API_TOKEN_HEADER,
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


# ---------------------------------------------------------------------------
# Auth disabled when env var is not set (pytest / bare dev backend)
# ---------------------------------------------------------------------------

def test_no_env_token_allows_unauthenticated(no_token_env, client: TestClient):
    response = client.get("/api/health")
    assert response.status_code == 200


# ---------------------------------------------------------------------------
# Misconfiguration: env set but empty / too short -> fail-closed (NOT dev mode)
# ---------------------------------------------------------------------------

def test_empty_token_env_fails_closed_503(empty_token_env, client: TestClient):
    # Empty string is a config error, not "auth disabled". Must NOT 200.
    response = client.get("/api/health")
    assert response.status_code == 503
    assert response.json()["detail"] == "Server API token misconfigured"


def test_short_token_env_fails_closed_503(short_token_env, client: TestClient):
    response = client.get("/api/health")
    assert response.status_code == 503


def test_short_token_even_with_matching_token_still_503(short_token_env, client: TestClient):
    # A weak token is rejected outright; presenting it does not unlock /api.
    response = client.get("/api/health", headers={api.API_TOKEN_HEADER: "tooshort"})
    assert response.status_code == 503


def test_validate_api_token_config_raises_on_empty(empty_token_env):
    with pytest.raises(RuntimeError):
        api.validate_api_token_config()


def test_validate_api_token_config_raises_on_short(short_token_env):
    with pytest.raises(RuntimeError):
        api.validate_api_token_config()


def test_validate_api_token_config_noop_when_unset(no_token_env):
    api.validate_api_token_config()  # must not raise


def test_validate_api_token_config_noop_when_valid(token_env):
    api.validate_api_token_config()  # 64-char token must not raise


# ---------------------------------------------------------------------------
# CORS allowlist tightened (no more wildcard)
# ---------------------------------------------------------------------------

def test_cors_disallows_unlisted_origin(no_token_env, client: TestClient):
    response = client.get("/api/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in response.headers


@pytest.mark.parametrize(
    "origin",
    ["http://localhost:3000", "http://127.0.0.1:3000", "null"],
)
def test_cors_allows_whitelisted_origins(no_token_env, client: TestClient, origin: str):
    response = client.get("/api/health", headers={"Origin": origin})
    assert response.headers.get("access-control-allow-origin") == origin
