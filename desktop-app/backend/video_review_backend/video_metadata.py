from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .media_binaries import resolve_ffprobe_path


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
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
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
