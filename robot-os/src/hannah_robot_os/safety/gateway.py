from __future__ import annotations

from dataclasses import dataclass, field

from ..common import AuditLog, SafetyState, now_ms
from ..config import SafetyLimits
from ..motors.base import MotorCommand


@dataclass
class SafetyDecision:
    allowed: bool
    reason: str
    state: SafetyState
    checked_at_ms: int


@dataclass
class SafetyGateway:
    audit: AuditLog
    limits: SafetyLimits
    estop_active: bool = False
    fault: str | None = None
    required_sensors_ok: bool = True
    _state: SafetyState = SafetyState.NORMAL
    _last_heartbeat_ms: int | None = field(default=None)

    @property
    def state(self) -> SafetyState:
        return self._state

    def heartbeat(self, now: int | None = None) -> None:
        self._last_heartbeat_ms = now_ms() if now is None else now

    def set_estop(self, active: bool) -> None:
        self.estop_active = active
        self._state = SafetyState.ESTOP if active else (SafetyState.FAULT if self.fault else SafetyState.NORMAL)
        self.audit.emit("safety-gateway", "estop_changed", severity="warning" if active else "info", active=active)

    def set_fault(self, fault: str | None) -> None:
        self.fault = fault
        if fault:
            self._state = SafetyState.FAULT
            self.audit.emit("safety-gateway", "fault_set", severity="error", fault=fault)
        elif not self.estop_active:
            self._state = SafetyState.NORMAL

    def set_required_sensors_ok(self, ok: bool) -> None:
        self.required_sensors_ok = ok
        if not ok and self._state == SafetyState.NORMAL:
            self._state = SafetyState.WARNING

    def evaluate_motion(self, cmd: MotorCommand, now: int | None = None) -> SafetyDecision:
        now = now_ms() if now is None else now
        if self.estop_active:
            return self._deny("estop active", SafetyState.ESTOP, now)
        if self.fault:
            return self._deny(f"fault active: {self.fault}", SafetyState.FAULT, now)
        if not self.required_sensors_ok:
            return self._deny("required sensors not healthy", SafetyState.SAFE_STOP, now)
        if cmd.source == "ai_raw":
            return self._deny("raw AI commands are not allowed", SafetyState.SAFE_STOP, now)
        age = now - cmd.issued_at_ms
        if age < 0:
            return self._deny("command issued in future", SafetyState.SAFE_STOP, now)
        if age > cmd.ttl_ms or age > self.limits.command_ttl_ms:
            return self._deny("command expired", SafetyState.SAFE_STOP, now)
        if abs(cmd.linear_x_mps) > self.limits.max_linear_speed_mps:
            return self._deny("linear speed exceeds limit", SafetyState.SAFE_STOP, now)
        if abs(cmd.angular_z_rps) > self.limits.max_angular_speed_rps:
            return self._deny("angular speed exceeds limit", SafetyState.SAFE_STOP, now)
        if self._last_heartbeat_ms is not None and now - self._last_heartbeat_ms > self.limits.watchdog_timeout_ms * 4:
            return self._deny("safety heartbeat stale", SafetyState.SAFE_STOP, now)
        return SafetyDecision(True, "allowed", self._state, now)

    def evaluate_admin_command(self, capability: str, now: int | None = None) -> SafetyDecision:
        """Administrative commands (updates/rollback) cannot run in an unsafe state."""
        now = now_ms() if now is None else now
        if self.estop_active:
            return self._deny(f"estop active; {capability} refused", SafetyState.ESTOP, now)
        if self.fault:
            return self._deny(f"fault active; {capability} refused", SafetyState.FAULT, now)
        return SafetyDecision(True, "allowed", self._state, now)

    def _deny(self, reason: str, state: SafetyState, now: int) -> SafetyDecision:
        self._state = state
        self.audit.emit("safety-gateway", "motion_denied", severity="warning", reason=reason, state=state.value)
        return SafetyDecision(False, reason, state, now)
