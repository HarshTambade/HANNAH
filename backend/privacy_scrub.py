"""Pure privacy scrubbers for the Python Sentry integration.

These helpers deliberately have no Sentry dependency so they can be tested in a
minimal environment. They remove credentials, request bodies, cookies, query
strings, identity fields, and filesystem paths while preserving stack traces.
"""

from __future__ import annotations

import re
from typing import Any

SENSITIVE_KEY = re.compile(
    r"(?:^|[._-])(?:api[_-]?key|apikey|authorization|auth|bearer|cookie|credentials?|"
    r"password|passwd|secret|token|session[_-]?id|prompt|messages?|completion|reply|"
    r"content|transcript|conversation|chat|file[_-]?path|filepath|filename|path|input|"
    r"body|query|statement|text|email|phone|address|ip[_-]?address)$",
    re.IGNORECASE,
)
URL_KEY = re.compile(r"(?:^|[._-])(?:url|uri|href|referrer|referer)$", re.IGNORECASE)
SAFE_HEADERS = {"accept", "accept-language", "content-type", "content-length"}

CREDENTIAL_PATTERNS = [
    re.compile(r"\b(?:gsk|sk|rk|pk)_[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b"),
    re.compile(r"\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b", re.IGNORECASE),
]
FILE_PATH_PATTERNS = [
    re.compile(r"(?:file://)?/(?:Users|home|private/var|var/folders|tmp|mnt/[a-zA-Z])/[^\s\"'<>)]{2,}"),
    re.compile(r"\b[A-Za-z]:\\[^\s\"'<>)]{2,}"),
    re.compile(r"\\\\[^\s\"'<>)]{2,}"),
]
URL_IN_TEXT = re.compile(r"\bhttps?://[^\s\"'<>]+", re.IGNORECASE)

MAX_STRING = 2000
MAX_DEPTH = 6
MAX_ARRAY = 50
MAX_KEYS = 100


def _normalize_key(key: str) -> str:
    """Fold camelCase and acronym boundaries so key policy catches `accessToken`."""
    key = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", key)
    key = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", key)
    return key.lower()


def is_sensitive_key(key: str) -> bool:
    return isinstance(key, str) and bool(SENSITIVE_KEY.search(_normalize_key(key)))


def _is_url_key(key: str) -> bool:
    return isinstance(key, str) and bool(URL_KEY.search(_normalize_key(key)))


def _scrub_embedded_urls(value: str) -> str:
    """Strip credentials, query strings, and fragments from URLs in free text."""
    from urllib.parse import urlsplit, urlunsplit

    def replace(match: re.Match[str]) -> str:
        raw = match.group(0)
        try:
            parsed = urlsplit(raw)
            if parsed.scheme not in {"http", "https"}:
                return raw
            netloc = parsed.hostname or ""
            if parsed.port:
                netloc = f"{netloc}:{parsed.port}"
            return urlunsplit((parsed.scheme, netloc, parsed.path, "", ""))
        except ValueError:
            return raw

    return URL_IN_TEXT.sub(replace, value)


def redact_sensitive_text(value: str, max_length: int = MAX_STRING, scrub_urls: bool = True) -> str:
    if not isinstance(value, str):
        return value
    redacted = _scrub_embedded_urls(value) if scrub_urls else value
    for pattern in CREDENTIAL_PATTERNS:
        redacted = pattern.sub(
            "Bearer <redacted>" if "Bearer" in pattern.pattern else "<redacted>",
            redacted,
        )
    for pattern in FILE_PATH_PATTERNS:
        redacted = pattern.sub("<file-path>", redacted)
    return redacted if len(redacted) <= max_length else redacted[:max_length] + "…"


def sanitize_url(value: str) -> str:
    if not isinstance(value, str):
        return redact_sensitive_text(value)
    try:
        from urllib.parse import urlsplit, urlunsplit

        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"}:
            return redact_sensitive_text(value)
        hostname = parsed.hostname or ""
        netloc = hostname
        if parsed.port:
            netloc = f"{hostname}:{parsed.port}"
        return urlunsplit((parsed.scheme, netloc, redact_sensitive_text(parsed.path), "", ""))
    except ValueError:
        return redact_sensitive_text(value, scrub_urls=False)


def sanitize_value(value: Any, key: str = "", depth: int = 0) -> Any:
    if depth > MAX_DEPTH:
        return "<depth-limited>"
    if is_sensitive_key(key):
        return "<redacted>"
    if isinstance(value, str):
        return sanitize_url(value) if _is_url_key(key) else redact_sensitive_text(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, (bytes, bytearray)):
        return f"<{len(value)} bytes>"
    if isinstance(value, (list, tuple)):
        return [sanitize_value(item, key, depth + 1) for item in value[:MAX_ARRAY]]
    if isinstance(value, dict):
        return {
            str(child_key): sanitize_value(child, str(child_key), depth + 1)
            for child_key, child in list(value.items())[:MAX_KEYS]
        }
    return redact_sensitive_text(str(value))


def sanitize_map(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    return {
        str(key): sanitize_value(item, str(key), 0)
        for key, item in list(value.items())[:MAX_KEYS]
    }


def sanitize_headers(headers: Any) -> dict[str, str]:
    if not isinstance(headers, dict):
        return {}
    clean: dict[str, str] = {}
    for name, value in headers.items():
        lower = str(name).lower()
        if lower not in SAFE_HEADERS or is_sensitive_key(lower):
            continue
        clean[str(name)] = redact_sensitive_text(str(value), 300)
    return clean


def _scrub_file_path(value: str) -> str:
    """Keep a frame's basename while removing local directory structure."""
    redacted = redact_sensitive_text(value, 500)
    if redacted != "<file-path>":
        return redacted
    parts = [part for part in re.split(r"[\\/]", value) if part]
    return f"<file-path>/{parts[-1]}" if parts else "<file-path>"


def sanitize_breadcrumb(breadcrumb: Any) -> Any:
    if not isinstance(breadcrumb, dict):
        return breadcrumb
    result = dict(breadcrumb)
    category = str(result.get("category", "")).lower()
    if category in {"console", "ui.input"}:
        result.pop("data", None)
        result["message"] = "[redacted]"
        return result
    if result.get("message"):
        result["message"] = redact_sensitive_text(str(result["message"]), 500)
    if result.get("data"):
        result["data"] = sanitize_map(result["data"])
    return result


def sanitize_event(event: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(event, dict):
        return event

    event.pop("user", None)
    event.pop("server_name", None)

    if event.get("message"):
        event["message"] = redact_sensitive_text(str(event["message"]), 1000)
    if event.get("transaction"):
        event["transaction"] = redact_sensitive_text(str(event["transaction"]), 500)

    request = event.get("request")
    if isinstance(request, dict):
        for key in ("data", "cookies", "query_string", "env"):
            request.pop(key, None)
        if request.get("url"):
            request["url"] = sanitize_url(str(request["url"]))
        if request.get("headers"):
            request["headers"] = sanitize_headers(request["headers"])

    if event.get("extra"):
        event["extra"] = sanitize_map(event["extra"])
    if event.get("contexts"):
        event["contexts"] = sanitize_map(event["contexts"])
    if event.get("tags"):
        event["tags"] = sanitize_map(event["tags"])

    breadcrumbs = event.get("breadcrumbs")
    if isinstance(breadcrumbs, dict) and isinstance(breadcrumbs.get("values"), list):
        breadcrumbs["values"] = [sanitize_breadcrumb(item) for item in breadcrumbs["values"][-20:]]
    elif isinstance(breadcrumbs, list):
        event["breadcrumbs"] = [sanitize_breadcrumb(item) for item in breadcrumbs[-20:]]

    exception = event.get("exception")
    if isinstance(exception, dict) and isinstance(exception.get("values"), list):
        values = []
        for item in exception["values"]:
            if not isinstance(item, dict):
                values.append(item)
                continue
            clean = dict(item)
            if clean.get("value"):
                clean["value"] = redact_sensitive_text(str(clean["value"]), 1000)
            stacktrace = clean.get("stacktrace")
            if isinstance(stacktrace, dict) and isinstance(stacktrace.get("frames"), list):
                clean_frames = []
                for frame in stacktrace["frames"][:200]:
                    if not isinstance(frame, dict):
                        clean_frames.append(frame)
                        continue
                    clean_frame = dict(frame)
                    for key in ("filename", "abs_path"):
                        if isinstance(clean_frame.get(key), str):
                            clean_frame[key] = _scrub_file_path(clean_frame[key])
                    # Local variables and source context can contain prompts,
                    # tokens, or file contents. Keep only the frame location.
                    for key in ("vars", "context_line", "pre_context", "post_context"):
                        clean_frame.pop(key, None)
                    clean_frames.append(clean_frame)
                clean["stacktrace"] = {**stacktrace, "frames": clean_frames}
            values.append(clean)
        exception["values"] = values

    return event


def sanitize_transaction(event: dict[str, Any]) -> dict[str, Any]:
    event = sanitize_event(event)
    spans = event.get("spans")
    if isinstance(spans, list):
        clean_spans = []
        for span in spans[:200]:
            if not isinstance(span, dict):
                clean_spans.append(span)
                continue
            clean = dict(span)
            if clean.get("description"):
                clean["description"] = redact_sensitive_text(str(clean["description"]), 500)
            if clean.get("data"):
                clean["data"] = sanitize_map(clean["data"])
            clean_spans.append(clean)
        event["spans"] = clean_spans
    return event
