"""Filesystem layout (workspace dirs, project file path).

Centralizes path computation so routers do not need to know about
backend root resolution. Honors GYMCLIP_BACKEND_ROOT and
GYMCLIP_WORKSPACE_ROOT environment overrides.
"""
from __future__ import annotations

import os
from pathlib import Path

from ..storage import ensure_project_dir, resolve_project_file


BACKEND_ROOT: Path = Path(
    os.environ.get("GYMCLIP_BACKEND_ROOT", Path(__file__).resolve().parents[2])
).resolve()
WORKSPACE_ROOT: Path = Path(
    os.environ.get("GYMCLIP_WORKSPACE_ROOT", BACKEND_ROOT / "workspace")
).resolve()
UPLOADS_DIR: Path = WORKSPACE_ROOT / "uploads"
EXPORTS_DIR: Path = WORKSPACE_ROOT / "exports"
THUMBNAILS_DIR: Path = WORKSPACE_ROOT / "thumbnails"
PROJECT_FILE: Path = resolve_project_file(WORKSPACE_ROOT)


def ensure_workspace_dirs() -> None:
    """Make sure all workspace subdirectories exist."""
    ensure_project_dir(WORKSPACE_ROOT)
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)
