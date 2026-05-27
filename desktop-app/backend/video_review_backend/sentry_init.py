"""
Sentry initialization for the FastAPI backend.

Read DSN from SENTRY_DSN_BACKEND env var.
Empty DSN -> log info and skip init.
Init failure -> log warning, degrade gracefully (do not crash).
Integrations: FastAPI + asyncio + logging (sentry-sdk standard).

Called from backend/main.py before FastAPI app construction.
TODO(C-5): refine before_send PII filtering (workspace paths, OSS keys, etc.)
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any

logger = logging.getLogger(__name__)

_SECRET_KEY_PATTERN = re.compile(r"(access[_-]?key|secret|password|token)", re.IGNORECASE)


def _filter_sensitive(event: dict[str, Any], _hint: dict[str, Any]) -> dict[str, Any]:
    """before_send hook: replace values of keys matching SECRET pattern with '[Filtered]'."""

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for k in list(node.keys()):
                if isinstance(k, str) and _SECRET_KEY_PATTERN.search(k):
                    node[k] = "[Filtered]"
                else:
                    walk(node[k])
        elif isinstance(node, list):
            for item in node:
                walk(item)

    try:
        walk(event)
    except Exception:  # noqa: BLE001
        pass  # 不让脱敏失败影响上报
    return event


def init_sentry() -> None:
    dsn = os.environ.get("SENTRY_DSN_BACKEND", "").strip()
    if not dsn:
        logger.info("[sentry] SENTRY_DSN_BACKEND empty, skipping init")
        return
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.logging import LoggingIntegration

        sentry_sdk.init(
            dsn=dsn,
            release=os.environ.get("SENTRY_RELEASE") or "gymclip-backend@unknown",
            environment=os.environ.get("SENTRY_ENVIRONMENT") or "development",
            integrations=[
                FastApiIntegration(),
                LoggingIntegration(level=logging.INFO, event_level=logging.ERROR),
            ],
            before_send=_filter_sensitive,
            # 不开 traces / profiling，先只做错误捕获
            traces_sample_rate=0.0,
        )
        logger.info(
            "[sentry] backend initialized (release=%s, env=%s)",
            os.environ.get("SENTRY_RELEASE") or "unknown",
            os.environ.get("SENTRY_ENVIRONMENT") or "development",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[sentry] init failed (degraded gracefully): %s", exc)
