from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

import PyInstaller.__main__


APP_NAME = "gymclip-backend"


def main() -> None:
    backend_root = Path(__file__).resolve().parents[1]
    dist_root = backend_root / "dist" / "standalone"
    build_root = backend_root / "build" / "pyinstaller"

    shutil.rmtree(dist_root, ignore_errors=True)
    shutil.rmtree(build_root, ignore_errors=True)
    dist_root.mkdir(parents=True, exist_ok=True)
    build_root.mkdir(parents=True, exist_ok=True)

    args = [
        str(backend_root / "main.py"),
        "--name",
        APP_NAME,
        "--onedir",
        "--clean",
        "--noconfirm",
        "--distpath",
        str(dist_root),
        "--workpath",
        str(build_root / "work"),
        "--specpath",
        str(build_root),
        "--paths",
        str(backend_root),
        "--collect-all",
        "fastapi",
        "--collect-all",
        "starlette",
        "--collect-all",
        "uvicorn",
        "--collect-all",
        "cv2",
        "--collect-all",
        "numpy",
        "--collect-all",
        "anthropic",
        "--collect-all",
        "zhipuai",
        "--hidden-import",
        "python_multipart",
    ]

    if os.name == "nt":
        args.extend(["--hidden-import", "win32timezone"])

    PyInstaller.__main__.run(args)

    print(f"Backend standalone build ready: {dist_root / APP_NAME}")


if __name__ == "__main__":
    main()
