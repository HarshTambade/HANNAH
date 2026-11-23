from __future__ import annotations

import json
import signal
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from ..common import AuditLog, ServiceState
from .health import ServiceHealthManager


@dataclass
class ServiceRuntime:
    name: str
    health: ServiceHealthManager
    audit: AuditLog
    status_path: Path
    tick: Callable[[], None]
    interval_s: float = 1.0

    def run_forever(self, max_ticks: int | None = None) -> None:
        running = True

        def _stop(_sig: int, _frame: object) -> None:
            nonlocal running
            running = False

        old_int = signal.getsignal(signal.SIGINT)
        old_term = signal.getsignal(signal.SIGTERM)
        signal.signal(signal.SIGINT, _stop)
        signal.signal(signal.SIGTERM, _stop)
        try:
            self.health.set_state(self.name, ServiceState.STARTING, "starting")
            self._write_status()
            self.health.set_state(self.name, ServiceState.READY, "running")
            ticks = 0
            while running:
                self.tick()
                self._write_status()
                ticks += 1
                if max_ticks is not None and ticks >= max_ticks:
                    break
                time.sleep(self.interval_s)
        finally:
            self.health.set_state(self.name, ServiceState.STOPPED, "stopped")
            self._write_status()
            signal.signal(signal.SIGINT, old_int)
            signal.signal(signal.SIGTERM, old_term)

    def _write_status(self) -> None:
        self.status_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "service": self.name,
            "health": self.health.snapshot(),
            "audit_tail": [e.to_dict() for e in self.audit.list()[-20:]],
        }
        self.status_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
