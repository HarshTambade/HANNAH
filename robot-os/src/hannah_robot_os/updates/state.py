from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass
class UpdateState:
    current_slot: str = "a"  # a/b
    current_version: str = "0.1.0"
    pending_slot: str | None = None
    pending_version: str | None = None
    last_good_slot: str = "a"
    last_good_version: str = "0.1.0"
    status: str = "idle"  # idle, staged, verifying, healthy, rolled_back, failed
    staged_boot_id: str | None = None  # the boot during which the pending update was staged

    @staticmethod
    def load(path: str | Path) -> "UpdateState":
        p = Path(path)
        if not p.exists():
            return UpdateState()
        data = json.loads(p.read_text(encoding="utf-8"))
        return UpdateState(**data)

    def save(self, path: str | Path) -> None:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")

    def stage(self, version: str) -> None:
        self.pending_slot = "b" if self.current_slot == "a" else "a"
        self.pending_version = version
        self.status = "staged"

    def mark_verifying(self) -> None:
        if not self.pending_version:
            raise RuntimeError("no pending update")
        self.status = "verifying"

    def mark_healthy(self) -> None:
        if not self.pending_slot or not self.pending_version:
            raise RuntimeError("no pending update")
        self.last_good_slot = self.current_slot
        self.last_good_version = self.current_version
        self.current_slot = self.pending_slot
        self.current_version = self.pending_version
        self.pending_slot = None
        self.pending_version = None
        self.staged_boot_id = None
        self.status = "healthy"

    def rollback(self) -> None:
        # If a pending update failed before promotion, keep current healthy slot.
        # If already promoted and unhealthy, revert to last known good.
        if self.status in {"staged", "verifying", "failed"} and self.pending_version:
            self.pending_slot = None
            self.pending_version = None
            self.staged_boot_id = None
            self.status = "rolled_back"
            return
        self.current_slot = self.last_good_slot
        self.current_version = self.last_good_version
        self.pending_slot = None
        self.pending_version = None
        self.staged_boot_id = None
        self.status = "rolled_back"
