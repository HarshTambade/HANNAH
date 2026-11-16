"""Tests for Phase 7 privacy scrubbers, LLM telemetry, and audit monitoring."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

from backend import sentry_setup
from backend.llm_telemetry import start_llm_trace
from backend.privacy_scrub import (
    redact_sensitive_text,
    sanitize_event,
    sanitize_headers,
    sanitize_transaction,
    sanitize_url,
)

ROOT = Path(__file__).resolve().parents[2]
_SPEC = importlib.util.spec_from_file_location("hannah_audit_monitor", ROOT / "scripts" / "audit_monitor.py")
assert _SPEC and _SPEC.loader
audit_monitor = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = audit_monitor
_SPEC.loader.exec_module(audit_monitor)


def _record_batch(entries: list[tuple[str, str | None, str | None]]) -> list[dict]:
    previous = audit_monitor.ZERO_HASH
    records = []
    for sequence, (action, tool, status) in enumerate(entries, 1):
        body = {
            "timestamp": f"2026-11-15T10:{sequence:02d}:00Z",
            "sequence": sequence,
            "previous_hash": previous,
            "action": action,
            "tool": tool,
            "status": status,
        }
        record = dict(body)
        record["hash"] = audit_monitor.record_hash(body)
        records.append(record)
        previous = record["hash"]
    return records


def _write_log(path: Path, records: list[dict]) -> None:
    path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")


def test_python_scrubbers_remove_credentials_identity_and_paths() -> None:
    event = {
        "user": {"id": "user-1", "email": "anya@example.com", "ip_address": "203.0.113.9"},
        "server_name": "local-mac",
        "message": "Failed with gsk_abcdefghijklmnopqrstuvwxyz123456",
        "request": {
            "url": "https://user:pass@api.example.com/chat?token=secret#fragment",
            "data": {"messages": [{"role": "user", "content": "My private journal"}]},
            "cookies": {"session": "abc"},
            "query_string": "token=secret",
            "headers": {
                "Authorization": "Bearer abcdefghijklmnopqrstuvwxyz",
                "Cookie": "session=abc",
                "Content-Type": "application/json",
                "X-Request-Id": "req-123",
            },
        },
        "extra": {
            "prompt": "Tell me a secret",
            "nested": {"reply": "private answer", "model": "gpt-oss-120b"},
            "path": "/Users/anya/private/notes.md",
            "accessToken": "opaque-access-token-value",
            "userMessage": "My private journal",
            "sourceURL": "https://user:pass@api.example.com/chat?token=secret",
        },
        "breadcrumbs": {
            "values": [
                {"category": "console", "message": "user typed a private message", "data": {"text": "hi"}},
                {"category": "navigation", "message": "Opened /chat"},
            ]
        },
        "exception": {
            "values": [{
                "type": "Error",
                "value": "Request failed with Bearer abcdefghijklmnopqrstuvwxyz",
                "stacktrace": {
                    "frames": [
                        {
                            "filename": "/Users/anya/project/backend/main.py",
                            "abs_path": "/Users/anya/project/backend/main.py",
                            "lineno": 12,
                            "vars": {"user_message": "My private journal"},
                            "context_line": "key = 'gsk_abcdefghijklmnopqrstuvwxyz123456'",
                            "pre_context": ["# private source"],
                            "post_context": ["# private source"],
                        },
                        {"filename": "https://hannah.example/assets/main.js?token=secret", "abs_path": "https://hannah.example/assets/main.js#x", "lineno": 3},
                    ]
                },
            }]
        },
    }

    clean = sanitize_event(event)
    assert "user" not in clean
    assert "server_name" not in clean
    assert "data" not in clean["request"]
    assert "cookies" not in clean["request"]
    assert "query_string" not in clean["request"]
    assert "Authorization" not in clean["request"]["headers"]
    assert "Cookie" not in clean["request"]["headers"]
    assert "X-Request-Id" not in clean["request"]["headers"]
    assert "token" not in clean["request"]["url"]
    assert "user" not in clean["request"]["url"]
    assert clean["extra"]["prompt"] == "<redacted>"
    assert clean["extra"]["nested"]["reply"] == "<redacted>"
    assert clean["extra"]["nested"]["model"] == "gpt-oss-120b"
    assert clean["extra"]["path"] == "<redacted>"
    assert clean["extra"]["accessToken"] == "<redacted>"
    assert clean["extra"]["userMessage"] == "<redacted>"
    assert clean["extra"]["sourceURL"] == "https://api.example.com/chat"
    assert clean["breadcrumbs"]["values"][0]["message"] == "[redacted]"
    assert "data" not in clean["breadcrumbs"]["values"][0]
    assert "abcdefghijklmnopqrstuvwxyz" not in clean["exception"]["values"][0]["value"]
    frames = clean["exception"]["values"][0]["stacktrace"]["frames"]
    assert frames[0]["filename"] == "<file-path>/main.py"
    assert frames[0]["abs_path"] == "<file-path>/main.py"
    for key in ("vars", "context_line", "pre_context", "post_context"):
        assert key not in frames[0], key
    assert frames[1]["filename"] == "https://hannah.example/assets/main.js"
    assert frames[1]["abs_path"] == "https://hannah.example/assets/main.js"


def test_python_transaction_and_header_scrubbing() -> None:
    clean = sanitize_transaction({
        "transaction": "POST /chat",
        "spans": [{
            "description": "fetch https://api.example.com/chat?key=secret",
            "data": {
                "prompt": "private ask",
                "provider": "groq",
                "http.request.body": "private request body",
                "http.request.header.authorization": "Bearer abcdefghijklmnopqrstuvwxyz",
                "db.statement": "INSERT INTO notes VALUES ('private journal')",
                "db.query.text": "SELECT * FROM notes WHERE body = 'private'",
                "gen_ai.usage.input_tokens": 42,
            },
        }],
    })
    assert "secret" not in clean["spans"][0]["description"]
    span_data = clean["spans"][0]["data"]
    assert span_data["prompt"] == "<redacted>"
    assert span_data["provider"] == "groq"
    assert span_data["http.request.body"] == "<redacted>"
    assert span_data["http.request.header.authorization"] == "<redacted>"
    assert span_data["db.statement"] == "<redacted>"
    assert span_data["db.query.text"] == "<redacted>"
    assert span_data["gen_ai.usage.input_tokens"] == 42

    headers = sanitize_headers({
        "authorization": "Bearer abcdefghijklmnopqrstuvwxyz",
        "content-type": "application/json",
    })
    assert headers == {"content-type": "application/json"}


def test_python_text_scrubber_handles_keys_and_paths() -> None:
    text = (
        "key gsk_abcdefghijklmnopqrstuvwxyz123456 "
        "path /Users/anya/private/notes.md windows C:\\Users\\anya\\secret.txt "
        "Bearer abcdefghijklmnopqrstuvwxyz"
    )
    cleaned = redact_sensitive_text(text)
    assert "gsk_" not in cleaned
    assert "/Users/anya" not in cleaned
    assert "C:\\Users\\anya" not in cleaned
    assert "Bearer abcdefghijklmnopqrstuvwxyz" not in cleaned
    assert "<redacted>" in cleaned
    assert "<file-path>" in cleaned

    embedded = redact_sensitive_text("see https://api.example.com/chat?key=secret#frag now")
    assert embedded == "see https://api.example.com/chat now"


def test_python_url_sanitizer_drops_query_and_credentials() -> None:
    cleaned = sanitize_url("https://user:pass@api.example.com/chat?token=secret#fragment")
    assert cleaned == "https://api.example.com/chat"


def test_sentry_stays_disabled_without_a_dsn(monkeypatch) -> None:
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    monkeypatch.setenv("SENTRY_ENABLED", "true")
    monkeypatch.setattr(sentry_setup, "_initialized", False)
    assert sentry_setup.init_sentry() is False


def test_python_llm_trace_is_metadata_only(tmp_path: Path, monkeypatch) -> None:
    trace_path = tmp_path / "llm_traces.jsonl"
    monkeypatch.setenv("LLM_TRACE_LOG", str(trace_path))
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)

    trace = start_llm_trace(provider="groq", requested_model="llama-3.3-70b-versatile")
    error = RuntimeError("slow down")
    error.status_code = 429
    trace.record_failure(
        model="llama-3.3-70b-versatile",
        error=error,
        duration_ms=12.4,
        next_model="openai/gpt-oss-120b",
    )
    trace.succeed(
        model="openai/gpt-oss-120b",
        usage={"promptTokens": 5, "completionTokens": 2},
        ttfb_ms=20,
        total_ms=50,
    )

    recorded = json.loads(trace_path.read_text(encoding="utf-8").strip())
    assert recorded["status"] == "success"
    assert recorded["source"] == "python"
    assert recorded["model"] == "openai/gpt-oss-120b"
    assert recorded["latency"]["timeToFirstTokenMs"] is None
    assert recorded["usage"]["totalTokens"] == 7
    assert recorded["fallbacks"][0]["reason"] == "rate_limited"
    for forbidden in ("messages", "prompt", "completion", "content"):
        assert forbidden not in recorded


def test_audit_monitor_counts_hitl_and_verifies_chain(tmp_path: Path) -> None:
    log_path = tmp_path / "audit.jsonl"
    _write_log(log_path, _record_batch([
        ("tool_proposed", "filesystem.read", None),
        ("tool_approved", "filesystem.read", None),
        ("tool_result", "filesystem.read", "success"),
        ("tool_proposed", "web.search", None),
        ("tool_rejected", "web.search", "user_rejected"),
        ("tool_rejected", "web.search", "invalid_arguments"),
        ("tool_proposed", "code.run", None),
        ("tool_expired", "code.run", "expired"),
        ("tool_result", "code.run", "error"),
    ]))

    result = audit_monitor.scan_audit_log(log_path)
    assert result.integrity_ok is True
    assert result.records_seen == 9
    assert result.records_verified == 9

    summary = result.summary_for("2026-11-15")
    assert summary.tool_calls == 3
    assert summary.approved == 1
    assert summary.rejected == 1
    assert summary.cancelled == 1
    assert summary.expired == 1
    assert summary.executions == 2
    assert summary.execution_errors == 1
    assert summary.tools["filesystem.read"] == 1
    assert summary.rejection_reasons["user_rejected"] == 1
    assert summary.rejection_reasons["invalid_arguments"] == 1

    payload = result.to_dict(["2026-11-15"])
    assert payload["integrity"]["ok"] is True
    assert payload["days"][0]["hitl"] == {
        "approved": 1,
        "rejected": 1,
        "expired": 1,
        "cancelled": 1,
    }


def test_audit_monitor_flags_tampering_and_malformed_lines(tmp_path: Path) -> None:
    log_path = tmp_path / "audit.jsonl"
    records = _record_batch([
        ("tool_proposed", "filesystem.read", None),
        ("tool_approved", "filesystem.read", None),
    ])
    records[0]["status"] = "tampered"
    with log_path.open("w", encoding="utf-8") as stream:
        for record in records:
            stream.write(json.dumps(record) + "\n")
        stream.write("{not json}\n")

    result = audit_monitor.scan_audit_log(log_path)
    assert result.integrity_ok is False
    codes = {issue.code for issue in result.integrity_failures}
    assert "hash_mismatch" in codes
    assert "malformed_json" in codes
    assert result.summary_for("2026-11-15").chain_failures >= 1


def test_audit_monitor_accepts_a_missing_log(tmp_path: Path) -> None:
    result = audit_monitor.scan_audit_log(tmp_path / "missing.jsonl")
    assert result.exists is False
    assert result.integrity_ok is True
    assert result.records_seen == 0
