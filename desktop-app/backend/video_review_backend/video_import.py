from __future__ import annotations

from pathlib import Path

from .models import ProjectState, VideoTask, new_id, utc_now_iso
from .video_metadata import probe_video_metadata


SUPPORTED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".flv", ".wmv"}


def is_supported_video(path: str | Path) -> bool:
    return Path(path).suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS


def import_videos_into_project(
    state: ProjectState,
    video_paths: list[str],
) -> list[VideoTask]:
    imported: list[VideoTask] = []
    existing_paths = {video.file_path for video in state.videos}

    for raw_path in video_paths:
        path = Path(raw_path).resolve()
        if not path.exists() or not path.is_file():
            continue
        if not is_supported_video(path):
            continue
        if str(path) in existing_paths:
            continue

        metadata = probe_video_metadata(str(path))
        now = utc_now_iso()
        video = VideoTask(
            id=new_id("video"),
            file_path=metadata["file_path"],
            file_name=metadata["file_name"],
            duration=metadata["duration"],
            resolution=metadata["resolution"],
            status="queued",
            created_at=now,
            updated_at=now,
        )
        state.videos.append(video)
        existing_paths.add(str(path))
        imported.append(video)

    state.touch()
    return imported
