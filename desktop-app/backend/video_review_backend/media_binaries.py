from __future__ import annotations

import os
import shutil
from pathlib import Path


def resolve_ffmpeg_path() -> str:
    return _resolve_binary(
        env_name="GYMCLIP_FFMPEG_PATH",
        default_name="ffmpeg",
        error_message="ffmpeg 未安装、未打包，或路径不可用",
    )


def resolve_ffprobe_path() -> str:
    return _resolve_binary(
        env_name="GYMCLIP_FFPROBE_PATH",
        default_name="ffprobe",
        error_message="ffprobe 未安装、未打包，或路径不可用",
    )


def resolve_ossutil_path() -> str:
    return _resolve_binary(
        env_name="GYMCLIP_OSSUTIL_PATH",
        default_name="ossutil",
        error_message="ossutil 未安装、未打包，或路径不可用",
    )


def _resolve_binary(*, env_name: str, default_name: str, error_message: str) -> str:
    configured = os.environ.get(env_name)
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if candidate.exists():
            return str(candidate)

    discovered = shutil.which(default_name)
    if discovered:
        return discovered

    raise RuntimeError(error_message)
