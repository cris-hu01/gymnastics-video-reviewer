from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from threading import RLock

from .models import ProjectState


DEFAULT_PROJECT_FILE = "project_state.json"
_PROJECT_STATE_LOCK = RLock()


def resolve_project_file(project_dir: str | os.PathLike[str], file_name: str = DEFAULT_PROJECT_FILE) -> Path:
    return Path(project_dir) / file_name


def ensure_project_dir(project_dir: str | os.PathLike[str]) -> Path:
    path = Path(project_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def project_state_lock() -> RLock:
    return _PROJECT_STATE_LOCK


def load_project_state(project_file: str | os.PathLike[str]) -> ProjectState:
    path = Path(project_file)
    if not path.exists():
        return ProjectState()

    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return ProjectState.from_dict(data)


def save_project_state(project_file: str | os.PathLike[str], state: ProjectState) -> None:
    path = Path(project_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    state.touch()

    with tempfile.NamedTemporaryFile("w", delete=False, dir=path.parent, encoding="utf-8") as tmp:
        tmp_path = Path(tmp.name)
        try:
            json.dump(state.to_dict(), tmp, ensure_ascii=False, indent=2)
            # Flush + fsync before the atomic replace so a power loss can't leave
            # a truncated/zero-byte project file behind the rename.
            tmp.flush()
            os.fsync(tmp.fileno())
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise

    try:
        tmp_path.replace(path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
