from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


class ServiceState(str, Enum):
    STARTING = "starting"
    READY = "ready"
    DEGRADED = "degraded"
    FAULT = "fault"
    STOPPED = "stopped"


class SafetyState(str, Enum):
    NORMAL = "normal"
    WARNING = "warning"
    SAFE_STOP = "safe_stop"
    ESTOP = "estop"
    FAULT = "fault"


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def stable_hash(data: Any) -> str:
    raw = json.dumps(data, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


@dataclass
class AuditEvent:
    ts_ms: int
    source: str
    event: str
    severity: str = "info"
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class AuditLog:
    def __init__(self) -> None:
        self._events: list[AuditEvent] = []

    def emit(self, source: str, event: str, severity: str = "info", **data: Any) -> AuditEvent:
        evt = AuditEvent(ts_ms=now_ms(), source=source, event=event, severity=severity, data=data)
        self._events.append(evt)
        return evt

    def list(self) -> list[AuditEvent]:
        return list(self._events)
