"""Read the status files that running Robot OS services write.

A service counts as ready only when its own status file says so, the file is
recent, and the service recorded itself in the READY state. A file left behind
by a service that stopped, faulted or hung must never let the robot report
READY.
"""
from __future__ import annotations

import json
from pathlib import Path

from ..common import now_ms

DEFAULT_STALE_AFTER_MS = 5000


def service_ready(
    status_dir: Path,
    name: str,
    now: int | None = None,
    stale_after_ms: int = DEFAULT_STALE_AFTER_MS,
) -> tuple[bool, str]:
    now = now_ms() if now is None else now
    path = Path(status_dir) / f"{name}.json"
    if not path.exists():
        return False, "no status file"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        states = {
            s["name"]: s["state"]
            for s in data.get("health", {}).get("services", [])
            if isinstance(s, dict)
        }
        written = int(data.get("written_at_ms") or 0)
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return False, "unreadable status file"
    if data.get("service") != name:
        return False, "status file names another service"
    if states.get(name) != "ready":
        return False, f"service state is {states.get(name) or 'unknown'}"
    if written <= 0:
        return False, "status file has no write time"
    age = now - written
    if age < 0 or age > stale_after_ms:
        return False, f"status is stale ({age} ms old)"
    return True, "ready"


def required_services_ready(
    status_dir: Path,
    names: list[str],
    now: int | None = None,
    stale_after_ms: int = DEFAULT_STALE_AFTER_MS,
) -> dict:
    now = now_ms() if now is None else now
    required = []
    for name in names:
        ok, reason = service_ready(status_dir, name, now, stale_after_ms)
        required.append({"name": name, "ok": ok, "reason": reason})
    return {
        "robot_ready": bool(required) and all(r["ok"] for r in required),
        "required": required,
    }
