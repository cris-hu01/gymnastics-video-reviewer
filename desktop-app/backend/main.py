import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

import uvicorn

from video_review_backend.sentry_init import init_sentry

# Initialize Sentry at import time so uvicorn workers and PyInstaller entry both pick it up.
# Empty DSN / import failure are handled internally and degrade gracefully.
init_sentry()


def _setup_logging() -> Path:
    backend_root = Path(
        os.environ.get("GYMCLIP_BACKEND_ROOT", Path(__file__).resolve().parent)
    ).resolve()
    workspace_root = Path(
        os.environ.get("GYMCLIP_WORKSPACE_ROOT", backend_root / "workspace")
    ).resolve()
    workspace_root.mkdir(parents=True, exist_ok=True)
    log_path = workspace_root / "backend.log"

    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    file_handler = RotatingFileHandler(
        log_path, maxBytes=10 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)

    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(formatter)

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers = [file_handler, stream_handler]

    logging.getLogger("oss2").setLevel(logging.INFO)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    return log_path


def create_app():
    from video_review_backend.api import app

    return app


if __name__ == "__main__":
    log_path = _setup_logging()
    logging.getLogger(__name__).info("backend log file: %s", log_path)
    reload_enabled = os.environ.get("GYMCLIP_BACKEND_RELOAD", "0") == "1"
    uvicorn.run(
        "video_review_backend.api:app" if reload_enabled else create_app(),
        host=os.environ.get("GYMCLIP_BACKEND_HOST", "127.0.0.1"),
        port=int(os.environ.get("GYMCLIP_BACKEND_PORT", "8000")),
        reload=reload_enabled,
    )
