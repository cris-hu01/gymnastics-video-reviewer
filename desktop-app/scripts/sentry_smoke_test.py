"""
C-7 smoke test for the v1.3.0 Sentry observability subproject.

Sends one synthetic error event to each of the three Sentry projects
(frontend / electron / backend) using the same anonymous `user.id` so we
can verify that:

  1. Every DSN routes to a reachable Sentry project (HTTP 200 from store endpoint).
  2. All three events show up under the same `user.id` in Sentry.
  3. The release tag, environment, and tags are wired correctly.

This script uses only the Python standard library (urllib, json, ssl) — it
does NOT import sentry-sdk — so it can run on any Python ≥ 3.10 without
provisioning a virtualenv. We talk to Sentry's Store API directly using
the wire protocol documented at:

  https://develop.sentry.dev/sdk/data-model/envelopes/  (newer protocol)
  https://develop.sentry.dev/sdk/store/                 (legacy "store" endpoint)

We deliberately use the legacy `store/` endpoint here because it accepts a
single JSON event in a single HTTP call — perfect for a smoke test and
much simpler than constructing a multi-part envelope.

Usage:
  # All four env vars below must be set (read from desktop-app/.env.local
  # by the wrapper or exported in your shell):
  #   VITE_SENTRY_DSN_FRONTEND
  #   SENTRY_DSN_ELECTRON
  #   SENTRY_DSN_BACKEND
  #   (optional) GYMCLIP_USER_ID — if missing, a fresh UUID is generated
  python3 desktop-app/scripts/sentry_smoke_test.py
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import traceback
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlparse


def _build_ssl_context() -> ssl.SSLContext:
    """
    macOS python.org builds don't trust the system keychain by default and
    plain `urllib.request.urlopen` then fails with CERTIFICATE_VERIFY_FAILED.
    Use `certifi` when available, otherwise fall back to /etc/ssl/cert.pem
    (present on macOS / most Linux distros). This is the same fallback chain
    `pip` uses internally.
    """
    cafile = None
    try:
        import certifi  # type: ignore
        cafile = certifi.where()
    except ImportError:
        if os.path.exists("/etc/ssl/cert.pem"):
            cafile = "/etc/ssl/cert.pem"
    return ssl.create_default_context(cafile=cafile)


_SSL_CTX = _build_ssl_context()


@dataclass
class ParsedDsn:
    public_key: str
    host: str
    project_id: str
    scheme: str

    @property
    def store_url(self) -> str:
        return f"{self.scheme}://{self.host}/api/{self.project_id}/store/"


def parse_dsn(dsn: str) -> ParsedDsn:
    """
    DSN format: <scheme>://<PUBLIC_KEY>@<HOST>/<PROJECT_ID>
    Example:   https://abc123@o123.ingest.us.sentry.io/4567890
    """
    parsed = urlparse(dsn)
    if not parsed.scheme or not parsed.username or not parsed.hostname or not parsed.path:
        raise ValueError(f"Invalid DSN (missing parts): {dsn}")
    return ParsedDsn(
        public_key=parsed.username,
        host=parsed.hostname + (f":{parsed.port}" if parsed.port else ""),
        project_id=parsed.path.lstrip("/"),
        scheme=parsed.scheme,
    )


def build_event(label: str, user_id: str, release: str) -> dict:
    """Build a Sentry-format event payload for the given simulated source."""
    event_id = uuid.uuid4().hex
    # Synthesize a fake stack frame so the event has something to render in the UI
    try:
        raise RuntimeError(f"C-7 smoke test: synthetic {label} error")
    except RuntimeError as exc:
        tb = traceback.TracebackException.from_exception(exc)
        frames = []
        for frame in tb.stack:
            frames.append(
                {
                    "filename": frame.filename,
                    "function": frame.name,
                    "lineno": frame.lineno,
                    "in_app": "sentry_smoke_test" in (frame.filename or ""),
                }
            )

    return {
        "event_id": event_id,
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "platform": "python",
        "level": "error",
        "logger": "gymclip.c7-smoke",
        "release": release,
        "environment": "smoke-test",
        "server_name": f"smoke-test-{label.lower()}",
        "tags": {
            "smoke_test": "c7",
            "simulated_source": label.lower(),
        },
        "user": {"id": user_id},
        "message": {"formatted": f"C-7 smoke test event from {label} simulator"},
        "exception": {
            "values": [
                {
                    "type": "RuntimeError",
                    "value": f"C-7 smoke test: synthetic {label} error",
                    "stacktrace": {"frames": frames},
                }
            ]
        },
        "extra": {
            "note": "Synthetic event from sentry_smoke_test.py — safe to resolve.",
            "subproject": "C (Sentry observability)",
        },
    }


def send_event(dsn: ParsedDsn, event: dict) -> tuple[int, str]:
    """POST a single event to Sentry's legacy store endpoint. Returns (status_code, body)."""
    auth_header = (
        f"Sentry sentry_version=7, sentry_client=gymclip-smoke/0.1, "
        f"sentry_key={dsn.public_key}"
    )
    body = json.dumps(event).encode("utf-8")
    req = urllib.request.Request(
        dsn.store_url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Sentry-Auth": auth_header,
            "User-Agent": "gymclip-smoke-test/0.1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")[:200]
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")[:200]
    except Exception as exc:  # noqa: BLE001
        return -1, f"{type(exc).__name__}: {exc}"


def main() -> int:
    sources = [
        ("FRONTEND", os.environ.get("VITE_SENTRY_DSN_FRONTEND", "")),
        ("ELECTRON", os.environ.get("SENTRY_DSN_ELECTRON", "")),
        ("BACKEND",  os.environ.get("SENTRY_DSN_BACKEND", "")),
    ]

    missing = [name for name, dsn in sources if not dsn]
    if missing:
        print(f"ERROR: missing env vars: {', '.join(missing)}", file=sys.stderr)
        print("Hint: source desktop-app/.env.local, or export them manually.", file=sys.stderr)
        return 1

    user_id = os.environ.get("GYMCLIP_USER_ID") or str(uuid.uuid4())
    release = os.environ.get("SENTRY_RELEASE") or "v1.3.0-c7-smoke"

    print(f"== C-7 Sentry smoke test ==")
    print(f"  user.id (shared across 3 events): {user_id}")
    print(f"  release tag:                      {release}")
    print()

    all_ok = True
    for label, dsn_str in sources:
        try:
            dsn = parse_dsn(dsn_str)
        except ValueError as e:
            print(f"  [{label}] DSN parse failed: {e}")
            all_ok = False
            continue
        event = build_event(label, user_id, release)
        status, body = send_event(dsn, event)
        ok = 200 <= status < 300
        all_ok = all_ok and ok
        marker = "OK " if ok else "FAIL"
        print(f"  [{marker}] {label:<8} → project {dsn.project_id} (status={status})")
        if not ok:
            print(f"           response: {body}")

    print()
    if all_ok:
        print("All 3 events posted successfully. Open Sentry and look for:")
        print(f"  - Issues filtered by tag `smoke_test:c7`")
        print(f"  - All three events share user.id = {user_id}")
        return 0
    else:
        print("One or more events failed — see lines marked FAIL above.")
        return 2


if __name__ == "__main__":
    sys.exit(main())
