"""GymClip Reviewer FastAPI application.

Wires the app, middleware, global exception handler, startup hook, and the six
routers extracted in the B-router refactor. Endpoint implementations live under
`video_review_backend.routers.*`; shared singletons under `.deps.*`.
"""
from __future__ import annotations

import logging
import os
import secrets

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# Re-exported for backward compatibility with tests / external imports.
from .deps.constants import (ALLOWED_CATEGORIES, MAG_SPORT_ITEM_IDS,  # noqa: F401
                             WAG_SPORT_ITEM_IDS)
from .deps.errors import APIError
from .deps.paths import (BACKEND_ROOT, EXPORTS_DIR, PROJECT_FILE,  # noqa: F401
                         THUMBNAILS_DIR, UPLOADS_DIR, WORKSPACE_ROOT,
                         ensure_workspace_dirs)
from .deps.state import load_state, persist_state, project_state_lock
from .deps.state_helpers import reconcile_runtime_state
from .routers import (clips as clips_router, jobs as jobs_router,
                      local_cards as local_cards_router,
                      platform as platform_router, project as project_router,
                      videos as videos_router)


ensure_workspace_dirs()

app = FastAPI(title="GymClip Reviewer API", version="1.2.1")

_api_logger = logging.getLogger("gymclip.api.exception_handler")
_security_logger = logging.getLogger("gymclip.api.security")

# --- Local API token auth -------------------------------------------------
# The Electron main process generates a random token per app launch and
# injects it via the GYMCLIP_API_TOKEN env var when spawning this backend.
#
# Three configuration states, distinguished so a misconfiguration can never
# silently disable auth:
#   1. env var UNSET (None)        -> dev mode: auth disabled + startup warning
#                                     (pytest, bare `python3 main.py`).
#   2. env var SET but too short   -> MISCONFIGURATION: fail-closed. The token
#      (empty / len < 32)             middleware 503s every /api request, and
#                                     validate_api_token_config() raises so a
#                                     supervised startup can refuse to boot.
#                                     main.cjs injects 64-char hex, so the
#                                     normal path never trips this.
#   3. env var SET and valid       -> enforce: every /api request must present
#      (len >= 32)                    the token via the X-Gymclip-Token header
#                                     (XHR/fetch) or a `?token=` query param
#                                     (media elements cannot attach headers).
API_TOKEN_ENV_VAR = "GYMCLIP_API_TOKEN"
API_TOKEN_HEADER = "X-Gymclip-Token"
API_TOKEN_MIN_LENGTH = 32


def _token_config():
    """Return (state, expected) where state is 'disabled' | 'misconfigured' | 'enforce'.

    Read live from the environment on every call so tests can toggle it via
    monkeypatch without re-importing the module.
    """
    raw = os.environ.get(API_TOKEN_ENV_VAR)
    if raw is None:
        return "disabled", ""
    if len(raw) < API_TOKEN_MIN_LENGTH:
        return "misconfigured", raw
    return "enforce", raw


def validate_api_token_config() -> None:
    """Fail-closed guard for supervised startup.

    Raises RuntimeError when GYMCLIP_API_TOKEN is set but too short/empty, so
    a misconfigured launch refuses to boot rather than running wide open.
    No-op when the var is unset (dev) or valid.
    """
    state, raw = _token_config()
    if state == "misconfigured":
        raise RuntimeError(
            f"{API_TOKEN_ENV_VAR} is set but too short "
            f"(len={len(raw)}, need >= {API_TOKEN_MIN_LENGTH}). "
            "Refusing to start with a weak local API token."
        )


@app.middleware("http")
async def _enforce_local_api_token(request: Request, call_next):
    if not request.url.path.startswith("/api"):
        return await call_next(request)

    state, expected = _token_config()

    if state == "disabled":
        return await call_next(request)

    if state == "misconfigured":
        # Empty / too-short token is a config error, NOT dev mode. Fail closed:
        # never serve /api with a weak token even if startup validation was
        # bypassed (e.g. uvicorn reload worker).
        _security_logger.error(
            "GYMCLIP_API_TOKEN misconfigured (too short) — refusing %s %s",
            request.method,
            request.url.path,
        )
        return JSONResponse(
            status_code=503,
            content={"detail": "Server API token misconfigured"},
        )

    provided = (
        request.headers.get(API_TOKEN_HEADER)
        or request.query_params.get("token")
        or ""
    )
    if not secrets.compare_digest(
        provided.encode("utf-8"), expected.encode("utf-8")
    ):
        _security_logger.warning(
            "rejected unauthenticated request %s %s",
            request.method,
            request.url.path,
        )
        return JSONResponse(
            status_code=401,
            content={"detail": "Invalid or missing API token"},
        )
    return await call_next(request)


# CORSMiddleware MUST be added AFTER the token middleware above: in Starlette
# the last-added middleware is the outermost, and CORS has to answer OPTIONS
# preflights before the token check runs (preflights cannot carry the custom
# token header, so an inner CORS layer would see them 401 first).
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        # Vite dev server (npm run dev:web / electron:dev) — both spellings.
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        # Packaged Electron renderer is loaded from file://. Per the Fetch
        # spec an opaque origin serializes to "null"; in practice Electron's
        # file:// fetches omit the Origin header entirely, so the CORS layer
        # never engages for the packaged app. This entry is defensive for
        # engines that do send `Origin: null`.
        "null",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(APIError)
async def _api_error_handler(request: Request, exc: APIError):
    """Convert structured `APIError`s to a JSON body with their status_code."""
    _api_logger.info(
        "APIError status=%d on %s %s message=%s",
        exc.status_code, request.method, request.url.path, exc.message,
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.message, "error_type": type(exc).__name__},
    )


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    """Catch-all for un-handled non-HTTP exceptions.

    HTTPException is dispatched by FastAPI's built-in handler before reaching
    here, so 4xx responses are preserved. Sentry capture is automatic via
    the FastAPI integration if initialized.
    """
    if isinstance(exc, HTTPException):
        raise exc
    _api_logger.exception(
        "Unhandled %s on %s %s",
        type(exc).__name__, request.method, request.url.path,
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "error_type": type(exc).__name__},
    )


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.on_event("startup")
def warn_if_api_token_disabled():
    state, _ = _token_config()
    if state == "disabled":
        _security_logger.warning(
            "GYMCLIP_API_TOKEN is not set — local API token auth is DISABLED. "
            "This is expected for pytest / bare development runs only."
        )
    elif state == "misconfigured":
        # Loud log on the in-process startup path. The hard refuse-to-boot
        # lives in validate_api_token_config(), called from main.py before
        # uvicorn.run so it crashes the process rather than only logging.
        _security_logger.error(
            "GYMCLIP_API_TOKEN is set but too short — all /api requests will 503."
        )


@app.on_event("startup")
def recover_stale_runtime_state():
    with project_state_lock():
        state = load_state()
        if reconcile_runtime_state(state):
            persist_state(state)


app.include_router(project_router.router)
app.include_router(jobs_router.router)
app.include_router(platform_router.router)
app.include_router(local_cards_router.router)
app.include_router(clips_router.router)
app.include_router(videos_router.detect_router)
app.include_router(videos_router.router)
app.include_router(videos_router.thumbnail_router)
