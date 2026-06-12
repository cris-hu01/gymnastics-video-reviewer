"""Tests for the parent-process watchdog.

Focus on the safety contract (disabled when the env var is unset/invalid, so
pytest and bare runs never spawn the thread) and the liveness logic, without
ever calling os._exit (which would kill the test process).
"""
import os
import sys

import pytest

from video_review_backend import parent_watchdog


@pytest.fixture(autouse=True)
def _clear_parent_pid_env(monkeypatch):
    monkeypatch.delenv(parent_watchdog.PARENT_PID_ENV_VAR, raising=False)
    # Reset module state between tests so a started thread in one test doesn't
    # leak into the "already running" guard of another.
    parent_watchdog._watchdog_thread = None
    yield


def test_disabled_when_env_unset():
    # No GYMCLIP_PARENT_PID -> watchdog must not start (pytest / bare backend).
    assert parent_watchdog.start_parent_watchdog() is False
    assert parent_watchdog._watchdog_thread is None


@pytest.mark.parametrize("bad", ["", "not-a-pid", "0", "-1"])
def test_disabled_when_env_invalid(monkeypatch, bad):
    monkeypatch.setenv(parent_watchdog.PARENT_PID_ENV_VAR, bad)
    assert parent_watchdog.start_parent_watchdog() is False
    assert parent_watchdog._watchdog_thread is None


def test_parent_alive_for_current_process():
    # os.getpid() is alive and (for this in-process call) getppid won't match it,
    # so _parent_is_alive should report the *real* parent as alive.
    real_parent = os.getppid()
    assert parent_watchdog._parent_is_alive(real_parent) is True


def test_parent_dead_for_nonexistent_pid():
    # A pid that does not exist must read as gone. 2**31-1 is effectively never
    # a live pid on the platforms we target.
    assert parent_watchdog._parent_is_alive(2**31 - 1) is False


@pytest.mark.skipif(
    sys.platform == "win32",
    reason=(
        "Exercises the reparenting (getppid mismatch) branch, which is the "
        "Unix-only detection path. On Windows there is no reparenting: "
        "os.getppid() keeps returning the original parent pid after it dies, so "
        "this branch never fires in production and the test would only pass via "
        "the kill(0) fallback — i.e. it would NOT be testing the real Windows "
        "behavior. See parent_watchdog module docstring (Windows-gap section)."
    ),
)
def test_parent_dead_when_ppid_changed():
    # If the recorded parent pid differs from the live getppid(), the original
    # parent has exited (reparenting) -> treated as gone. os.getpid() (self) is
    # a live pid that is NOT our parent, so getppid() != getpid() and the
    # reparenting branch fires, returning False without reaching kill(0).
    assert parent_watchdog._parent_is_alive(os.getpid()) is False


def test_start_then_idempotent(monkeypatch):
    # With a valid parent pid the watchdog starts; a second call is a no-op
    # while the thread is alive.
    monkeypatch.setenv(parent_watchdog.PARENT_PID_ENV_VAR, str(os.getppid()))
    try:
        assert parent_watchdog.start_parent_watchdog() is True
        thread = parent_watchdog._watchdog_thread
        assert thread is not None and thread.is_alive()
        # Already running -> second call returns False and does not replace it.
        assert parent_watchdog.start_parent_watchdog() is False
        assert parent_watchdog._watchdog_thread is thread
    finally:
        # Daemon thread; nothing to join. Drop the reference for other tests.
        parent_watchdog._watchdog_thread = None
