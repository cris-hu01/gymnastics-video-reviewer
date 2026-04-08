from __future__ import annotations

import os
import shutil
import stat
from pathlib import Path


def main() -> None:
    backend_root = Path(__file__).resolve().parents[1]
    output_root = backend_root / "dist" / "oss-tools"
    bin_dir = output_root / "bin"

    shutil.rmtree(output_root, ignore_errors=True)
    bin_dir.mkdir(parents=True, exist_ok=True)

    source = resolve_ossutil_source()
    if source is None:
        print("ossutil not found; skipping bundled OSS tool. Runtime can still use PATH or GYMCLIP_OSSUTIL_PATH.")
        return

    target_name = source.name
    target = bin_dir / target_name
    shutil.copy2(source, target)
    ensure_executable(target)
    print(f"OSS tool bundle ready: {output_root}")


def resolve_ossutil_source() -> Path | None:
    configured = (os.environ.get("GYMCLIP_OSSUTIL_SOURCE") or os.environ.get("GYMCLIP_OSSUTIL_PATH") or "").strip()
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if candidate.exists():
            return candidate

    discovered = shutil.which("ossutil")
    if discovered:
        return Path(discovered).resolve()
    return None


def ensure_executable(path: Path) -> None:
    current_mode = path.stat().st_mode
    path.chmod(current_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


if __name__ == "__main__":
    main()
