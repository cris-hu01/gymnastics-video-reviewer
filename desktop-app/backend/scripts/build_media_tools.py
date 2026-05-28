from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path


SYSTEM_PREFIXES = ("/System/Library/", "/usr/lib/")
HOMEBREW_PREFIXES = ("/opt/homebrew/", "/usr/local/")
TOOLS = ("ffmpeg", "ffprobe")


def main() -> None:
    backend_root = Path(__file__).resolve().parents[1]
    output_root = backend_root / "dist" / "media-tools"
    bin_dir = output_root / "bin"
    lib_dir = output_root / "lib"

    shutil.rmtree(output_root, ignore_errors=True)
    bin_dir.mkdir(parents=True, exist_ok=True)
    lib_dir.mkdir(parents=True, exist_ok=True)

    if os.name == "nt":
        _bundle_windows(bin_dir)
        print(f"Media tools bundle ready: {output_root}")
        return

    source_tools = {name: _resolve_tool(name) for name in TOOLS}
    copied_libs: dict[Path, Path] = {}

    for name, source_path in source_tools.items():
        target = bin_dir / name
        shutil.copy2(source_path, target)
        _ensure_executable(target)
        _collect_dependencies(source_path, lib_dir, copied_libs)

    for source_path, copied_path in copied_libs.items():
        _rewrite_library(copied_path, source_path)

    for name, source_path in source_tools.items():
        _rewrite_binary(bin_dir / name, source_path)

    _codesign_targets([*copied_libs.values(), *(bin_dir / name for name in TOOLS)])

    print(f"Media tools bundle ready: {output_root}")


def _bundle_windows(bin_dir: Path) -> None:
    source_tools = {name: _resolve_tool(name) for name in TOOLS}
    copied_names: set[str] = set()

    for name, source_path in source_tools.items():
        shutil.copy2(source_path, bin_dir / source_path.name)
        copied_names.add(source_path.name.lower())

        for dll_path in source_path.parent.glob("*.dll"):
            lower_name = dll_path.name.lower()
            if lower_name in copied_names:
                continue
            shutil.copy2(dll_path, bin_dir / dll_path.name)
            copied_names.add(lower_name)


def _resolve_tool(name: str) -> Path:
    discovered = shutil.which(name)
    if not discovered:
        raise RuntimeError(f"未找到 {name}，请先在构建机上安装")
    return Path(discovered).resolve()


def _collect_dependencies(source_path: Path, lib_dir: Path, copied_libs: dict[Path, Path]) -> None:
    for dependency in _list_dependencies(source_path):
        if dependency.resolved_path is None or not _should_bundle_dependency(dependency.resolved_path):
            continue

        real_dependency = dependency.resolved_path.resolve()
        if real_dependency in copied_libs:
            continue

        copied_path = lib_dir / real_dependency.name
        shutil.copy2(real_dependency, copied_path)
        _ensure_executable(copied_path)
        copied_libs[real_dependency] = copied_path
        _collect_dependencies(real_dependency, lib_dir, copied_libs)


def _rewrite_binary(binary_path: Path, original_path: Path) -> None:
    for dependency in _list_dependencies(original_path):
        if dependency.resolved_path is None or not _should_bundle_dependency(dependency.resolved_path):
            continue
        replacement = f"@executable_path/../lib/{dependency.resolved_path.resolve().name}"
        _change_install_name(binary_path, dependency.original_name, replacement)


def _rewrite_library(library_path: Path, original_path: Path) -> None:
    subprocess.run(
        ["install_name_tool", "-id", f"@loader_path/{library_path.name}", str(library_path)],
        check=True,
    )
    for dependency in _list_dependencies(original_path):
        if dependency.resolved_path is None or not _should_bundle_dependency(dependency.resolved_path):
            continue
        replacement = f"@loader_path/{dependency.resolved_path.resolve().name}"
        _change_install_name(library_path, dependency.original_name, replacement)


def _change_install_name(target: Path, old_path: str, new_path: str) -> None:
    subprocess.run(
        ["install_name_tool", "-change", old_path, new_path, str(target)],
        check=True,
    )


class DependencyRef:
    def __init__(self, original_name: str, resolved_path: Path | None) -> None:
        self.original_name = original_name
        self.resolved_path = resolved_path


def _list_dependencies(path: Path) -> list[DependencyRef]:
    result = subprocess.run(
        ["otool", "-L", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    dependencies: list[DependencyRef] = []
    for line in result.stdout.splitlines()[1:]:
        dependency = line.strip().split(" ", 1)[0]
        if not dependency:
            continue
        dependencies.append(DependencyRef(dependency, _resolve_dependency_path(path, dependency)))
    return dependencies


def _should_bundle_dependency(path: Path) -> bool:
    value = str(path)
    if value.startswith(SYSTEM_PREFIXES):
        return False
    return value.startswith(HOMEBREW_PREFIXES)


def _resolve_dependency_path(owner_path: Path, dependency: str) -> Path | None:
    if dependency.startswith("/"):
        return Path(dependency)

    if dependency.startswith("@rpath/") or dependency.startswith("@loader_path/"):
        candidate = owner_path.parent / dependency.split("/", 1)[1]
        if candidate.exists():
            return candidate.resolve()

    if dependency.startswith("@executable_path/"):
        candidate = owner_path.parent / dependency.split("/", 1)[1]
        if candidate.exists():
            return candidate.resolve()

    return None


def _ensure_executable(path: Path) -> None:
    # 0o755 = rwx for owner, rx for group / others.
    #
    # The owner-WRITE bit is REQUIRED for autoUpdater on macOS:
    # Squirrel.Mac's install helper opens each bundled file O_RDWR to
    # strip the com.apple.quarantine xattr that macOS auto-adds when the
    # update zip is unpacked. Without write permission, that syscall
    # fails with EACCES; Squirrel logs
    #   "Couldn't remove quarantine attribute from .../ffmpeg.
    #    This most likely means the file is read-only."
    # then aborts the install and the user is stuck on the old version.
    #
    # Brew ships ffmpeg/ffprobe with mode 555 (no owner-write). The old
    # version of this function used OR-with-X-bits which preserved 555,
    # causing rc.5 -> rc.6 auto-update to fail. Setting explicit 0o755
    # gives owner-write, fixing autoUpdater for both ffmpeg/ffprobe bins
    # and all collected dylibs.
    path.chmod(0o755)


def _codesign_targets(paths: list[Path]) -> None:
    if os.name != "posix":
        return
    for path in paths:
        subprocess.run(
            ["codesign", "--force", "--sign", "-", str(path)],
            capture_output=True,
            text=True,
            check=False,
        )


if __name__ == "__main__":
    main()
