from __future__ import annotations

import json
import os
from pathlib import Path

from dataclasses import dataclass, field
from typing import Any

from ..common import AuditLog, new_id, now_ms
from ..safety.gateway import SafetyGateway
from ..updates.state import UpdateState
from ..updates.recovery import RecoveryManager
from .bridge import BridgeEnvelope
from .command_guard import CommandGuard
from ..services.service_manager import ConfigReloader, ServiceManager, check_restart

ALLOWED_CAPABILITIES = {"update.stage", "update.activate", "update.rollback", "diagnostics.run", "service.restart", "config.reload"}


@dataclass
class RobotOSCommandDispatcher:
    robot_id: str
    guard: CommandGuard
    safety: SafetyGateway
    update_state: UpdateState
    audit: AuditLog
    recovery: RecoveryManager | None = None
    # Remote recovery (diagnostics). Without them, service.restart and config.reload are refused.
    services: ServiceManager | None = None
    config_reloader: ConfigReloader | None = None
    now: Any = now_ms
    health_snapshot: Any = field(default_factory=lambda: lambda: {"robot_ready": False})
    # With a path, results survive a restart: the server re-delivers a command
    # until it sees the ack, and a lost ack must not turn into "failed" (the
    # replay check refuses the copy) or into a second run after a restart.
    results_path: Any = None
    _applied: list[str] = field(default_factory=list)
    _results: dict[str, dict] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.results_path:
            try:
                saved = json.loads(Path(self.results_path).read_text(encoding="utf-8"))
                self._results = {str(key): value for key, value in saved.items() if isinstance(value, dict)}
            except (OSError, ValueError, AttributeError):
                self._results = {}

    def _remember(self, command_id: str, ok: bool, reason: str, expires_at: Any) -> None:
        now = self.now()
        try:
            until = int(expires_at)
        except (TypeError, ValueError):
            until = now
        self._results = {key: value for key, value in self._results.items() if int(value.get("until", 0)) > now}
        self._results[command_id] = {"ok": ok, "reason": reason, "until": until}
        if self.results_path:
            path = Path(self.results_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(f".{path.name}.tmp")
            temporary.write_text(json.dumps(self._results), encoding="utf-8")
            os.replace(temporary, path)

    def handle(self, command: dict[str, Any]) -> BridgeEnvelope:
        try:
            return self._handle(command)
        except Exception as error:  # noqa: BLE001 - a bad command is answered, never left without an ack
            self.audit.emit("command-dispatcher", "command_error", severity="error", error=type(error).__name__)
            return self._ack(str(command.get("id", "")) if isinstance(command, dict) else "", False, "malformed command")

    def _handle(self, command: dict[str, Any]) -> BridgeEnvelope:
        command_id = str(command.get("id", ""))
        ok, reason = self.guard.verify(command)
        if not ok and reason == "replayed command" and command_id in self._results:
            # The same signed command again: answer with what happened the first time.
            first = self._results[command_id]
            return self._ack(command_id, bool(first.get("ok")), str(first.get("reason", "")))
        if not ok:
            self.audit.emit("command-dispatcher", "command_denied", severity="warning", command_id=command_id, reason=reason)
            return self._ack(command_id, False, reason)

        capability = str(command.get("capability", ""))
        if capability not in ALLOWED_CAPABILITIES:
            return self._settle(command, command_id, False, "capability not allowed")

        decision = self.safety.evaluate_admin_command(capability, now=self.now())
        if not decision.allowed:
            return self._settle(command, command_id, False, decision.reason)

        params = command.get("params", {}) or {}
        if capability == "update.stage":
            version = str(params.get("version", "")).strip()
            if not version:
                return self._settle(command, command_id, False, "missing version")
            self.update_state.stage(version)
        elif capability == "update.activate":
            # Promotion is allowed only when this robot's own READY gate passes.
            # The parent cannot claim the robot is healthy.
            health = self.health_snapshot() or {}
            if not health.get("robot_ready"):
                return self._settle(command, command_id, False, "robot not ready; activation refused")
            if params.get("version") and params["version"] != self.update_state.pending_version:
                return self._settle(command, command_id, False, "pending version mismatch")
            self.update_state.mark_verifying()
            self.update_state.mark_healthy()
        elif capability == "update.rollback":
            self.update_state.rollback()
            if self.recovery is not None:
                self.recovery.enter(
                    "approved update rollback",
                    self.update_state.last_good_version,
                )
        elif capability == "service.restart":
            name = str(params.get("service", "")).strip()
            allowed, why = check_restart(name)
            if not allowed:
                return self._settle(command, command_id, False, why)
            if self.services is None:
                return self._settle(command, command_id, False, "no service manager on this robot")
            ok, why = self.services.restart(name)
            self.audit.emit("command-dispatcher", "service_restart", service=name, ok=ok, detail=why)
            if not ok:
                return self._settle(command, command_id, False, why)
        elif capability == "config.reload":
            if self.config_reloader is None:
                return self._settle(command, command_id, False, "no configuration reloader on this robot")
            ok, why = self.config_reloader.reload()
            if not ok:
                return self._settle(command, command_id, False, why)
        # diagnostics.run is a read/report capability; the report is the ack itself.

        self._applied.append(command_id)
        self.audit.emit("command-dispatcher", "command_applied", command_id=command_id, capability=capability)
        return self._settle(command, command_id, True, "applied")

    def _settle(self, command: dict[str, Any], command_id: str, ok: bool, reason: str) -> BridgeEnvelope:
        """Every answer to a verified command is remembered, so a repeat gets the same one."""
        self._remember(command_id, ok, reason, command.get("expiresAt"))
        return self._ack(command_id, ok, reason)

    def _ack(self, command_id: str, ok: bool, reason: str) -> BridgeEnvelope:
        return BridgeEnvelope(
            envelope_id=new_id("env"),
            robot_id=self.robot_id,
            ts_ms=self.now(),
            kind="command_ack",
            payload={"commandId": command_id, "ok": ok, "reason": reason},
        )
