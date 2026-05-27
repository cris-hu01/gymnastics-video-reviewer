"""GymClip Reviewer FastAPI application.

Wires the app, middleware, global exception handler, startup hook, and the six
routers extracted in the B-router refactor. Endpoint implementations live under
`video_review_backend.routers.*`; shared singletons under `.deps.*`.
"""
from __future__ import annotations

import logging

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
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_api_logger = logging.getLogger("gymclip.api.exception_handler")


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
