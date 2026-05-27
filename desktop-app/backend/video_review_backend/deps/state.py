"""Project state load/persist helpers.

Re-exports `project_state_lock` from `..storage` so routers have a single
import path for state coordination primitives.
"""
from __future__ import annotations

from ..models import ProjectState
from ..storage import (
    load_project_state,
    project_state_lock,
    save_project_state,
)
from .paths import PROJECT_FILE


__all__ = ["load_state", "persist_state", "project_state_lock"]


def load_state() -> ProjectState:
    """Load the current project state from the workspace project file."""
    return load_project_state(PROJECT_FILE)


def persist_state(state: ProjectState) -> None:
    """Atomically save project state back to disk."""
    save_project_state(PROJECT_FILE, state)
