from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from ..common import now_ms


@dataclass
class RecoveryState:
    active: bool = False
    reason: str = ""
    entered_at_ms: int = 0
    last_good_version: str = ""

    @staticmethod
    def load(path: str | Path) -> "RecoveryState":
        p = Path(path)
        if not p.exists():
            return RecoveryState()
        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("recovery state must be a JSON object")
        return RecoveryState(**{key: data[key] for key in (
            "active", "reason", "entered_at_ms", "last_good_version"
        ) if key in data})

    def save(self, path: str | Path) -> None:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")


class RecoveryManager:
    def __init__(
        self,
        state: RecoveryState | None = None,
        now: Any = now_ms,
    ) -> None:
        self.state = state or RecoveryState()
        self.now = now

    def enter(self, reason: str, last_good_version: str = "") -> RecoveryState:
        reason = reason.strip()
        if not reason:
            raise ValueError("recovery reason is required")
        self.state.active = True
        self.state.reason = reason
        self.state.entered_at_ms = int(self.now())
        if last_good_version:
            self.state.last_good_version = last_good_version
        return self.state

    def exit(self, *, robot_ready: bool) -> None:
        if not robot_ready:
            raise RuntimeError("recovery exit refused until the robot READY gate passes")
        self.state.active = False
        self.state.reason = ""

    def save(self, path: str | Path) -> None:
        self.state.save(path)

    def write_diagnostics(self, path: str | Path, report: dict[str, Any]) -> Path:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "ts_ms": int(self.now()),
            "recovery": asdict(self.state),
            "report": report,
        }
        p.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return p
