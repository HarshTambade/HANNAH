from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..common import AuditLog, new_id, now_ms
from ..safety.gateway import SafetyGateway
from ..updates.state import UpdateState
from ..updates.recovery import RecoveryManager
from .bridge import BridgeEnvelope
from .command_guard import CommandGuard

ALLOWED_CAPABILITIES = {"update.stage", "update.activate", "update.rollback", "diagnostics.run"}


@dataclass
class RobotOSCommandDispatcher:
    robot_id: str
    guard: CommandGuard
    safety: SafetyGateway
    update_state: UpdateState
    audit: AuditLog
    recovery: RecoveryManager | None = None
    now: Any = now_ms
    health_snapshot: Any = field(default_factory=lambda: lambda: {"robot_ready": False})
    _applied: list[str] = field(default_factory=list)

    def handle(self, command: dict[str, Any]) -> BridgeEnvelope:
        command_id = str(command.get("id", ""))
        ok, reason = self.guard.verify(command)
        if not ok:
            self.audit.emit("command-dispatcher", "command_denied", severity="warning", command_id=command_id, reason=reason)
            return self._ack(command_id, False, reason)

        capability = str(command.get("capability", ""))
        if capability not in ALLOWED_CAPABILITIES:
            return self._ack(command_id, False, "capability not allowed")

        decision = self.safety.evaluate_admin_command(capability, now=self.now())
        if not decision.allowed:
            return self._ack(command_id, False, decision.reason)

        params = command.get("params", {}) or {}
        if capability == "update.stage":
            version = str(params.get("version", "")).strip()
            if not version:
                return self._ack(command_id, False, "missing version")
            self.update_state.stage(version)
        elif capability == "update.activate":
            # Promotion is allowed only when this robot's own READY gate passes.
            # The parent cannot claim the robot is healthy.
            health = self.health_snapshot() or {}
            if not health.get("robot_ready"):
                return self._ack(command_id, False, "robot not ready; activation refused")
            if params.get("version") and params["version"] != self.update_state.pending_version:
                return self._ack(command_id, False, "pending version mismatch")
            self.update_state.mark_verifying()
            self.update_state.mark_healthy()
        elif capability == "update.rollback":
            self.update_state.rollback()
            if self.recovery is not None:
                self.recovery.enter(
                    "approved update rollback",
                    self.update_state.last_good_version,
                )
        # diagnostics.run is a read/report capability; the report is the ack itself.

        self._applied.append(command_id)
        self.audit.emit("command-dispatcher", "command_applied", command_id=command_id, capability=capability)
        return self._ack(command_id, True, "applied")

    def _ack(self, command_id: str, ok: bool, reason: str) -> BridgeEnvelope:
        return BridgeEnvelope(
            envelope_id=new_id("env"),
            robot_id=self.robot_id,
            ts_ms=self.now(),
            kind="command_ack",
            payload={"commandId": command_id, "ok": ok, "reason": reason},
        )
