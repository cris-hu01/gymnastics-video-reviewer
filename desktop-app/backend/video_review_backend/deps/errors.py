"""Application-level exception types.

`APIError` is the explicit, expected error contract for handlers and services
that need to signal a structured failure with a custom status code without
reaching for `fastapi.HTTPException` directly. The global exception handler
in `api.py` formats it as a JSON `{"detail": ..., "error_type": ...}` body.
"""
from __future__ import annotations


class APIError(Exception):
    """Base class for expected backend errors with a custom HTTP status code."""

    def __init__(self, message: str, status_code: int = 500) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message

    def __str__(self) -> str:  # pragma: no cover - trivial passthrough
        return self.message
