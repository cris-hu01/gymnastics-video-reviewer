from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .media_binaries import resolve_ffprobe_path


# ffprobe is a metadata read; it should return near-instantly. Cap it so a
# hung/corrupt file or a wedged binary can't block an import worker forever.
FFPROBE_TIMEOUT_SECONDS = 60


def probe_video_metadata(video_path: str) -> dict[str, object]:
    path = Path(video_path)
    cmd = [
        resolve_ffprobe_path(),
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        str(path),
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
            timeout=FFPROBE_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        # TimeoutExpired already kills/reaps the child; convert to a clear failure
        # so the import path reports it instead of hanging.
        raise RuntimeError(f"ffprobe 探测超时: {path.name}") from error
    payload = json.loads(result.stdout)

    duration = None
    resolution = None

    format_info = payload.get("format", {})
    if format_info.get("duration") is not None:
        duration = float(format_info["duration"])

    for stream in payload.get("streams", []):
        if stream.get("codec_type") == "video":
            width = stream.get("width")
            height = stream.get("height")
            if width and height:
                resolution = f"{width}x{height}"
            break

    return {
        "file_name": path.name,
        "file_path": str(path.resolve()),
        "duration": duration,
        "resolution": resolution,
    }
