"""Metadata-only LLM tracing for the Python fallback router.

Prompt text, completion text, tool arguments, and provider credentials are
never accepted by this module. It writes JSONL traces to the same file used by
the Node runtime and, when configured, exports to Langfuse's ingestion API.
"""

from __future__ import annotations

import base64
import json
import os
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TRACE_VERSION = 1
MAX_ATTEMPTS = 30
_WRITE_LOCK = threading.Lock()
_WARNING_SHOWN = False


def _disabled() -> bool:
    return os.getenv("LLM_TRACING_DISABLED", "").strip().lower() == "true"


def _trace_log_path() -> Path:
    configured = os.getenv("LLM_TRACE_LOG", "").strip() or "logs/llm_traces.jsonl"
    path = Path(configured).expanduser()
    return path if path.is_absolute() else Path.cwd() / path


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _label(value: Any, maximum: int = 200) -> str:
    if not isinstance(value, str):
        return ""
    return value.replace("\r", " ").replace("\n", " ").replace("\t", " ").strip()[:maximum]


def _non_negative(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return None
    return int(round(value))


def normalize_usage(raw_usage: dict[str, Any] | None) -> dict[str, int | None] | None:
    if not isinstance(raw_usage, dict):
        return None
    prompt = _non_negative(raw_usage.get("promptTokens"))
    completion = _non_negative(raw_usage.get("completionTokens"))
    total = _non_negative(raw_usage.get("totalTokens"))
    if total is None and prompt is not None and completion is not None:
        total = prompt + completion
    if prompt is None and completion is None and total is None:
        return None
    return {"promptTokens": prompt, "completionTokens": completion, "totalTokens": total}


def _error_metadata(error: BaseException) -> dict[str, Any]:
    status = getattr(error, "status_code", None)
    return {
        "type": _label(type(error).__name__, 80) or "Error",
        "httpStatus": int(status) if isinstance(status, int) else None,
    }


def build_langfuse_batch(trace: dict[str, Any]) -> dict[str, Any]:
    start_time = trace["timestamp"]
    latency = trace.get("latency") or {}
    end_time = (
        _iso(datetime.fromisoformat(start_time.replace("Z", "+00:00")).timestamp() + (latency.get("totalMs") or 0) / 1000)
        if start_time else _iso(time.time())
    )
    completion_start = None
    if latency.get("timeToFirstByteMs") is not None:
        completion_start = _iso(
            datetime.fromisoformat(start_time.replace("Z", "+00:00")).timestamp()
            + latency["timeToFirstByteMs"] / 1000
        )
    generation_body: dict[str, Any] = {
        "id": f"{trace['id']}-generation",
        "traceId": trace["id"],
        "name": "generation",
        "startTime": start_time,
        "endTime": end_time,
        **({"completionStartTime": completion_start} if completion_start else {}),
        "model": trace.get("model") or trace.get("requestedModel"),
        "modelParameters": {
            "provider": trace["provider"]["id"],
            "providerLabel": trace["provider"]["label"],
            "streaming": trace.get("streaming", False),
        },
        "level": "DEFAULT" if trace.get("status") == "success" else "ERROR",
        **({"statusMessage": trace["error"]["type"]} if trace.get("error") else {}),
        "metadata": {
            "operation": trace.get("operation"),
            "requestedModel": trace.get("requestedModel"),
            "fallbacks": trace.get("fallbacks", []),
            "attempts": trace.get("attempts", []),
            "latency": latency,
            "source": trace.get("source", "python"),
        },
    }
    usage = trace.get("usage")
    if usage:
        generation_body["usage"] = {
            **({"input": usage["promptTokens"]} if usage.get("promptTokens") is not None else {}),
            **({"output": usage["completionTokens"]} if usage.get("completionTokens") is not None else {}),
            **({"total": usage["totalTokens"]} if usage.get("totalTokens") is not None else {}),
            "unit": "TOKENS",
        }
    return {
        "batch": [
            {
                "id": str(uuid.uuid4()),
                "type": "trace-create",
                "timestamp": start_time,
                "body": {
                    "id": trace["id"],
                    "timestamp": start_time,
                    "name": trace["name"],
                    "metadata": {
                        "provider": trace["provider"],
                        "operation": trace.get("operation"),
                        "requestedModel": trace.get("requestedModel"),
                        "status": trace.get("status"),
                        "source": trace.get("source", "python"),
                    },
                    "tags": ["hannah", trace["provider"]["id"], trace.get("operation", "chat")],
                },
            },
            {"id": str(uuid.uuid4()), "type": "generation-create", "timestamp": start_time, "body": generation_body},
        ]
    }


def _append_local(trace: dict[str, Any]) -> None:
    global _WARNING_SHOWN
    if _disabled():
        return
    try:
        path = _trace_log_path()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        encoded = (json.dumps(trace, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        descriptor = os.open(path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        try:
            os.write(descriptor, encoded)
        finally:
            os.close(descriptor)
    except OSError as error:
        with _WRITE_LOCK:
            if not _WARNING_SHOWN:
                _WARNING_SHOWN = True
                print(f"[observability] Could not write LLM traces ({type(error).__name__}).")


def _post_langfuse(batch: dict[str, Any]) -> None:
    public_key = os.getenv("LANGFUSE_PUBLIC_KEY", "").strip()
    secret_key = os.getenv("LANGFUSE_SECRET_KEY", "").strip()
    if not public_key or not secret_key:
        return
    base_url = (os.getenv("LANGFUSE_BASEURL") or os.getenv("LANGFUSE_HOST") or "https://cloud.langfuse.com").strip().rstrip("/")
    auth = base64.b64encode(f"{public_key}:{secret_key}".encode("utf-8")).decode("ascii")
    request = urllib.request.Request(
        f"{base_url}/api/public/ingestion",
        data=json.dumps(batch, separators=(",", ":")).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Basic {auth}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            if response.status >= 400:
                print(f"[observability] Langfuse rejected an LLM trace (HTTP {response.status}).")
    except (urllib.error.URLError, TimeoutError, OSError):
        print("[observability] Langfuse trace export failed (network error).")


def _finish(trace: dict[str, Any]) -> None:
    if _disabled():
        return
    try:
        _append_local(trace)
        if os.getenv("LANGFUSE_PUBLIC_KEY", "").strip() and os.getenv("LANGFUSE_SECRET_KEY", "").strip():
            threading.Thread(target=_post_langfuse, args=(build_langfuse_batch(trace),), daemon=True).start()
    except Exception as error:
        # Observability is best-effort. A trace serialization/export failure
        # must never turn a successful model response into a fallback or error.
        global _WARNING_SHOWN
        with _WRITE_LOCK:
            if not _WARNING_SHOWN:
                _WARNING_SHOWN = True
                print(f"[observability] Could not record an LLM trace ({type(error).__name__}).")


class LLMTrace:
    """A metadata-only trace handle.

    The public methods accept provider/model identifiers, numeric latency,
    numeric token counts, and exception objects. There is intentionally no
    method that accepts prompt or response text.
    """

    def __init__(self, *, provider: str, requested_model: str, operation: str = "chat") -> None:
        started_at = time.time()
        self._finished = False
        self._lock = threading.Lock()
        self._trace: dict[str, Any] = {
            "type": "llm_trace",
            "version": TRACE_VERSION,
            "id": str(uuid.uuid4()),
            "timestamp": _iso(started_at),
            "source": "python",
            "name": f"hannah.llm.{_label(operation, 40) or 'chat'}",
            "operation": _label(operation, 40) or "chat",
            "provider": {"id": _label(provider, 64) or "unknown", "label": _label(provider, 80) or "Unknown provider"},
            "requestedModel": _label(requested_model, 200) or None,
            "model": None,
            "status": "running",
            "streaming": False,
            "latency": None,
            "usage": None,
            "attempts": [],
            "fallbacks": [],
            "error": None,
        }

    @property
    def id(self) -> str:
        return self._trace["id"]

    def record_failure(
        self,
        *,
        model: str,
        error: BaseException,
        duration_ms: float | None,
        next_model: str | None = None,
    ) -> None:
        metadata = _error_metadata(error)
        with self._lock:
            if self._finished:
                return
            self._trace["attempts"].append({
                "model": _label(model),
                "errorType": metadata["type"],
                "httpStatus": metadata["httpStatus"],
                "durationMs": _non_negative(duration_ms),
            })
            self._trace["attempts"] = self._trace["attempts"][-MAX_ATTEMPTS:]
            if next_model:
                self._trace["fallbacks"].append({
                    "fromModel": _label(model),
                    "toModel": _label(next_model),
                    "reason": "rate_limited" if metadata["httpStatus"] == 429 else "provider_error",
                    "errorType": metadata["type"],
                    "httpStatus": metadata["httpStatus"],
                    "durationMs": _non_negative(duration_ms),
                })
                self._trace["fallbacks"] = self._trace["fallbacks"][-MAX_ATTEMPTS:]

    def succeed(
        self,
        *,
        model: str,
        usage: dict[str, Any] | None,
        ttfb_ms: float | None,
        total_ms: float | None,
    ) -> None:
        with self._lock:
            if self._finished:
                return
            self._finished = True
            self._trace["status"] = "success"
            self._trace["model"] = _label(model) or self._trace["requestedModel"]
            self._trace["usage"] = normalize_usage(usage)
            self._trace["latency"] = {
                "timeToFirstByteMs": _non_negative(ttfb_ms),
                # Non-streaming calls cannot observe a token boundary.
                "timeToFirstTokenMs": None,
                "totalMs": _non_negative(total_ms),
                "streaming": False,
            }
        _finish(self._trace)

    def fail(self, error: BaseException) -> None:
        with self._lock:
            if self._finished:
                return
            self._finished = True
            self._trace["status"] = "error"
            self._trace["error"] = _error_metadata(error)
        _finish(self._trace)


def start_llm_trace(*, provider: str, requested_model: str | None, operation: str = "chat") -> LLMTrace:
    return LLMTrace(provider=provider, requested_model=requested_model or "", operation=operation)
