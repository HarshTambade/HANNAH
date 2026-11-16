"""Optional Sentry initialization for the Python FastAPI service.

The integration is metadata-only by construction: `send_default_pii` is off,
request bodies and query strings are removed, identity is discarded, and
Authorization headers plus chat payloads are redacted before transmission.
"""

from __future__ import annotations

import os

from backend.privacy_scrub import sanitize_breadcrumb, sanitize_event, sanitize_transaction

_initialized = False


def _sample_rate(value: str | None, fallback: float) -> float:
    try:
        parsed = float(value) if value is not None else fallback
    except (TypeError, ValueError):
        return fallback
    return max(0.0, min(1.0, parsed))


def init_sentry() -> bool:
    """Initialize Sentry once; returns True when error tracking is active."""
    global _initialized
    if _initialized:
        return True
    if os.getenv("SENTRY_ENABLED", "").strip().lower() == "false":
        return False
    dsn = os.getenv("SENTRY_DSN", "").strip()
    if not dsn:
        return False

    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
    except ImportError:
        print("[observability] SENTRY_DSN is set but sentry-sdk is not installed; error tracking is disabled.")
        return False

    try:
        sentry_sdk.init(
            dsn=dsn,
            environment=os.getenv("SENTRY_ENVIRONMENT") or os.getenv("NODE_ENV") or "development",
            release=os.getenv("SENTRY_RELEASE") or None,
            send_default_pii=False,
            attach_stacktrace=True,
            max_breadcrumbs=20,
            traces_sample_rate=_sample_rate(os.getenv("SENTRY_TRACES_SAMPLE_RATE"), 0.1),
            profiles_sample_rate=0.0,
            integrations=[
                StarletteIntegration(transaction_style="endpoint"),
                FastApiIntegration(transaction_style="endpoint"),
            ],
            before_send=lambda event, _hint: sanitize_event(event),
            before_send_transaction=lambda event, _hint: sanitize_transaction(event),
            before_breadcrumb=sanitize_breadcrumb,
        )
    except Exception as error:  # Telemetry must never prevent the agent from starting.
        print(f"[observability] Sentry could not initialize ({type(error).__name__}); error tracking is disabled.")
        return False
    sentry_sdk.set_tag("service", "hannah-python")
    _initialized = True
    print("[observability] Sentry error tracking enabled for the Python service.")
    return True


def is_sentry_enabled() -> bool:
    return _initialized
