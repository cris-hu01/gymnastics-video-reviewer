"""Parent-process watchdog for the spawned backend.

The Electron main process spawns this backend and is responsible for killing it
on quit (see main.cjs `before-quit`). But if the *main* process dies abnormally
(SIGKILL, crash, force-quit), its `before-quit` handler never runs and the
backend is orphaned: it keeps holding the port + workspace lock until the user
hunts it down in Activity Monitor / Task Manager.

To close that gap, main.cjs passes its own pid via the ``GYMCLIP_PARENT_PID``
env var. This module starts a background daemon thread that periodically checks
whether that parent is still alive; when it disappears, the backend shuts itself
down.

Two independent liveness signals are used so the watchdog is robust across
platforms and reparenting quirks:

1. ``os.getppid()`` — when the original parent dies, the OS reparents this
   process (to init/pid 1 on Unix, or the ppid simply stops matching). If the
   live ppid no longer equals the recorded parent pid, the parent is gone.
2. ``os.kill(pid, 0)`` — signal 0 performs error-checking without sending a
   signal; ``ProcessLookupError`` means the pid no longer exists. (On Windows
   ``os.kill(pid, 0)`` raises ``OSError`` for a dead pid as well.)

Both are best-effort; either one firing is treated as "parent gone".

Safety contract:
* No-op (returns ``False``) when ``GYMCLIP_PARENT_PID`` is unset or unparsable —
  so bare ``python3 main.py`` and pytest never spawn the watchdog thread.
* The thread is a daemon and never blocks uvicorn startup: it is started from a
  FastAPI startup hook but does its work entirely on its own thread with a poll
  loop, so the event loop is free immediately.
"""
from __future__ import annotations

import logging
import os
import threading
import time

_logger = logging.getLogger("gymclip.watchdog")

PARENT_PID_ENV_VAR = "GYMCLIP_PARENT_PID"

# Poll interval. 3s keeps orphan lifetime short without burning CPU. The check
# itself is a couple of cheap syscalls.
_POLL_INTERVAL_SECONDS = 3.0

_watchdog_thread: threading.Thread | None = None


def _parent_is_alive(parent_pid: int) -> bool:
    """Return True while the recorded parent process is still our parent and alive.

    Returns False as soon as either liveness signal indicates the parent is gone.
    """
    # Signal 1: reparenting. On Unix the orphaned child is reparented (ppid -> 1
    # or another subreaper); on any platform a changed ppid means the original
    # parent exited. getppid() is unavailable on some exotic platforms but is
    # present on macOS/Linux/Windows (where Python emulates it).
    try:
        if os.getppid() != parent_pid:
            return False
    except (OSError, AttributeError):
        # If getppid is unusable, fall through to the kill(0) probe rather than
        # declaring the parent dead on a transient error.
        pass

    # Signal 2: explicit existence probe. signal 0 does no-op delivery and only
    # validates that the pid exists and we may signal it.
    try:
        os.kill(parent_pid, 0)
    except ProcessLookupError:
        return False  # pid no longer exists -> parent gone
    except PermissionError:
        # The pid exists but is owned by another user (pid recycled into an
        # unrelated process). Treat as alive to avoid a false-positive suicide;
        # the getppid() check above already guards the reparenting case.
        return True
    except OSError:
        # Windows raises a generic OSError for a dead pid. Be conservative: only
        # treat it as gone if getppid() also disagrees (handled above). Here a
        # generic OSError most plausibly means the pid is gone.
        return False

    return True


def _watch_loop(parent_pid: int) -> None:
    _logger.info(
        "parent watchdog active (parent_pid=%s, poll=%.1fs)",
        parent_pid,
        _POLL_INTERVAL_SECONDS,
    )
    while True:
        time.sleep(_POLL_INTERVAL_SECONDS)
        if not _parent_is_alive(parent_pid):
            _logger.warning(
                "parent process %s is gone — backend shutting down to avoid "
                "orphaning.",
                parent_pid,
            )
            # Hard exit. We are an orphaned single-purpose subprocess; a clean
            # uvicorn shutdown would require reaching into the server instance,
            # and there is nothing left to flush (state is persisted per-request
            # under a lock). os._exit skips atexit/handlers and terminates the
            # whole process immediately, releasing the port and workspace.
            os._exit(0)


def start_parent_watchdog() -> bool:
    """Start the parent-liveness watchdog thread if configured.

    Returns True when a watchdog thread was started, False when disabled
    (env var unset/invalid) or already running. Safe to call multiple times.
    """
    global _watchdog_thread

    raw = os.environ.get(PARENT_PID_ENV_VAR)
    if not raw:
        return False  # bare backend / pytest: no parent to watch

    try:
        parent_pid = int(raw)
    except (TypeError, ValueError):
        _logger.warning("%s=%r is not a valid pid — watchdog disabled", PARENT_PID_ENV_VAR, raw)
        return False

    if parent_pid <= 0:
        _logger.warning("%s=%s is not a usable pid — watchdog disabled", PARENT_PID_ENV_VAR, parent_pid)
        return False

    if _watchdog_thread is not None and _watchdog_thread.is_alive():
        return False  # already running

    thread = threading.Thread(
        target=_watch_loop,
        args=(parent_pid,),
        name="gymclip-parent-watchdog",
        daemon=True,
    )
    thread.start()
    _watchdog_thread = thread
    return True
