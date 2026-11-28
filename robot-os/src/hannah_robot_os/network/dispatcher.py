from __future__ import annotations

import json
import os
from pathlib import Path

from dataclasses import dataclass, field
from typing import Any

from ..common import AuditLog, new_id, now_ms
from ..safety.gateway import SafetyGateway
from ..updates import backup as backups
from ..updates.package import PackageError, verify_package
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
    # Signed packages. With trusted_keys set (the keys pinned on this robot),
    # update.stage needs a signed "hannah-update/1" manifest that verifies here,
    # with these keys, and fits `facts` (this robot's hardware and versions).
    trusted_keys: Any = None
    facts: Any = None
    # Configuration backups before staging, restored (validated) on rollback.
    backup_root: Any = None
    backup_files: list = field(default_factory=list)
    validate_backup: Any = None
    # Health checks a package may ask for after activation, by id. "robot-ready" is always the READY gate.
    health_checks: dict = field(default_factory=dict)
    _applied: list[str] = field(default_factory=list)
    _results: dict[str, dict] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.results_path:
            try:
                saved = json.loads(Path(self.results_path).read_text(encoding="utf-8"))
                self._results = {str(key): value for key, value in saved.items() if isinstance(value, dict)}
            except (OSError, ValueError, AttributeError):
                self._results = {}

    def _facts(self) -> dict:
        return (self.facts() if callable(self.facts) else self.facts) or {}

    def _update_view(self) -> dict:
        state = self.update_state
        return {"status": state.status, "currentVersion": state.current_version, "pendingVersion": state.pending_version, "lastGoodVersion": state.last_good_version}

    def _run_health(self, ids: list) -> list[dict]:
        results = []
        for check_id in ids:
            check_id = str(check_id)
            if check_id == "robot-ready":
                ok = bool((self.health_snapshot() or {}).get("robot_ready"))
                results.append({"id": check_id, "ok": ok, "detail": "READY gate passed" if ok else "READY gate not passed"})
            elif check_id in self.health_checks:
                try:
                    ok = bool(self.health_checks[check_id]())
                    results.append({"id": check_id, "ok": ok, "detail": "passed" if ok else "failed"})
                except Exception as error:  # noqa: BLE001 - a crashing check is a failed check
                    results.append({"id": check_id, "ok": False, "detail": f"the check crashed ({type(error).__name__})"})
            else:
                results.append({"id": check_id, "ok": False, "detail": "this robot has no such health check"})
        return results

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
        if str(command.get("robotId", "")) != str(self.robot_id):
            # Addressed to another robot: refused before the guard, so it never uses up a nonce here.
            self.audit.emit("command-dispatcher", "command_denied", severity="warning", command_id=command_id, reason="command for another robot")
            return self._ack(command_id, False, "command for another robot")
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
        extra: dict = {}
        if capability == "update.stage":
            version = str(params.get("version", "")).strip()
            manifest = params.get("manifest")
            if self.trusted_keys is not None or manifest is not None:
                if not isinstance(manifest, dict):
                    return self._settle(command, command_id, False, "a signed update package is required")
                try:
                    verified = verify_package(manifest, self.trusted_keys or {}, self._facts())
                except PackageError as error:
                    self.audit.emit("command-dispatcher", "package_refused", severity="warning", command_id=command_id, reason=str(error))
                    return self._settle(command, command_id, False, f"package refused: {error}")
                if version and version != verified["version"]:
                    return self._settle(command, command_id, False, "version doesn't match the signed manifest")
                version = verified["version"]
                backup_id = str(params["backup"].get("id", "")) if isinstance(params.get("backup"), dict) else ""
                if backup_id and self.backup_root:
                    try:
                        taken = backups.take(self.backup_root, backup_id, self.backup_files, self._facts(), now=self.now)
                    except backups.BackupError as error:
                        return self._settle(command, command_id, False, f"backup failed: {error}")
                    extra["backup"] = {"id": taken["id"], "files": len(taken["files"])}
            if not version:
                return self._settle(command, command_id, False, "missing version")
            self.update_state.stage(version)
            extra["update"] = self._update_view()
        elif capability == "update.activate":
            # Promotion is allowed only when this robot's own READY gate passes.
            # The parent cannot claim the robot is healthy.
            health = self.health_snapshot() or {}
            if not health.get("robot_ready"):
                return self._settle(command, command_id, False, "robot not ready; activation refused")
            if params.get("version") and params["version"] != self.update_state.pending_version:
                return self._settle(command, command_id, False, "pending version mismatch")
            self.update_state.mark_verifying()
            requested = params.get("healthChecks") or []
            results = self._run_health(requested if isinstance(requested, list) else [])
            if results:
                extra["health"] = {"checks": results}
            if results and not all(item["ok"] for item in results):
                self.update_state.status = "failed"
                extra["update"] = self._update_view()
                return self._settle(command, command_id, False, "health checks failed: " + ", ".join(item["id"] for item in results if not item["ok"]), extra)
            self.update_state.mark_healthy()
            extra["update"] = self._update_view()
        elif capability == "update.rollback":
            self.update_state.rollback()
            if self.recovery is not None:
                self.recovery.enter(
                    "approved update rollback",
                    self.update_state.last_good_version,
                )
            extra["update"] = self._update_view()
            backup_id = str(params["backup"].get("id", "")) if isinstance(params.get("backup"), dict) else ""
            if backup_id and self.backup_root:
                try:
                    extra["restored"] = backups.restore(self.backup_root, backup_id, self._facts(), self.validate_backup)
                except backups.BackupError as error:
                    self.audit.emit("command-dispatcher", "restore_refused", severity="warning", command_id=command_id, reason=str(error))
                    return self._settle(command, command_id, False, f"slot rolled back; configuration not restored: {error}", extra)
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
        return self._settle(command, command_id, True, "applied", extra)

    def _settle(self, command: dict[str, Any], command_id: str, ok: bool, reason: str, extra: dict | None = None) -> BridgeEnvelope:
        """Every answer to a verified command is remembered, so a repeat gets the same one."""
        self._remember(command_id, ok, reason, command.get("expiresAt"))
        return self._ack(command_id, ok, reason, extra)

    def _ack(self, command_id: str, ok: bool, reason: str, extra: dict | None = None) -> BridgeEnvelope:
        return BridgeEnvelope(
            envelope_id=new_id("env"),
            robot_id=self.robot_id,
            ts_ms=self.now(),
            kind="command_ack",
            payload={"commandId": command_id, "ok": ok, "reason": reason, **(extra or {})},
        )
