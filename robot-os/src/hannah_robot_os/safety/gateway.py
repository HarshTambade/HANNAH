from __future__ import annotations

from dataclasses import dataclass, field

from ..common import AuditLog, SafetyState, now_ms
from ..config import SafetyLimits
from ..motors.base import MotorCommand
from . import modes


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
    # Set when an emergency stop has been seen. With limits.estop_latched,
    # releasing the stop does not clear it: an operator must reset it.
    _estop_latch: bool = False
    # The operating mode (modes.py). Only set_mode() and mirror() change it.
    operating_mode: str = modes.DEFAULT_MODE

    @property
    def state(self) -> SafetyState:
        return self._state

    def set_mode(self, target: str, operator: str = "") -> SafetyDecision:
        """Change the operating mode by the transition table.

        Safety Stop engages the latched software stop (the same path as an
        "engage" request). Leaving it needs an operator's name, a released stop
        input and a successful latch reset; the reset never re-enables motors
        by itself. Every other change but into Safety Stop needs an operator.
        """
        now = now_ms()
        problem = modes.transition_refusal(self.operating_mode, target)
        if not problem and target != "safety_stop" and not operator:
            problem = "operator required"
        if not problem and self.operating_mode == "safety_stop":
            if self.estop_active:
                problem = "stop input still active"
            else:
                reset = self.reset_estop(operator)
                if not reset.allowed:
                    problem = reset.reason
        if problem:
            self.audit.emit("safety-gateway", "mode_refused", severity="warning", current=self.operating_mode, target=target, operator=operator, reason=problem)
            return SafetyDecision(False, problem, self._state, now)
        before = self.operating_mode
        self.operating_mode = target
        if target == "safety_stop":
            self.set_estop(True)
        self.audit.emit("safety-gateway", "mode_changed", severity="warning" if target == "safety_stop" else "info", before=before, after=target, operator=operator)
        return SafetyDecision(True, "mode changed", self._state, now)

    @property
    def estop_latched(self) -> bool:
        return self._estop_latch

    def heartbeat(self, now: int | None = None) -> None:
        self._last_heartbeat_ms = now_ms() if now is None else now

    def set_estop(self, active: bool) -> None:
        self.estop_active = active
        if active:
            self._estop_latch = bool(self.limits.estop_latched)
        self._recompute_state()
        self.audit.emit(
            "safety-gateway",
            "estop_changed",
            severity="warning" if active else "info",
            active=active,
            latched=self._estop_latch,
        )

    def reset_estop(self, operator: str) -> SafetyDecision:
        """Clear a latched emergency stop after it has been released.

        Refused while the stop input is still active. The reset is audited with
        the operator who asked for it; it never re-enables motors by itself.
        """
        now = now_ms()
        if self.estop_active:
            self.audit.emit("safety-gateway", "estop_reset_refused", severity="warning", operator=operator, reason="estop still active")
            return SafetyDecision(False, "estop still active", self._state, now)
        if not operator:
            return SafetyDecision(False, "operator required", self._state, now)
        self._estop_latch = False
        self._recompute_state()
        self.audit.emit("safety-gateway", "estop_reset", operator=operator)
        return SafetyDecision(True, "reset", self._state, now)

    def mirror(self, estop_active: bool, estop_latched: bool, fault: str | None, operating_mode: str | None = None) -> None:
        """Take the state the safety-gateway service published (another process's gateway)."""
        # A mode this process doesn't know is taken as Safety Stop, never as permission.
        mode = self.operating_mode if operating_mode is None else (operating_mode if operating_mode in modes.MODES else "safety_stop")
        changed = (self.estop_active, self._estop_latch, self.fault, self.operating_mode) != (estop_active, estop_latched, fault, mode)
        self.estop_active, self._estop_latch, self.fault, self.operating_mode = estop_active, estop_latched, fault, mode
        self._recompute_state()
        if changed:
            self.audit.emit("safety-gateway", "mirrored", severity="warning" if (estop_active or estop_latched or fault or mode == "safety_stop") else "info",
                            estop_active=estop_active, latched=estop_latched, fault=fault, operating_mode=mode)

    def _recompute_state(self) -> None:
        if self.estop_active or self._estop_latch:
            self._state = SafetyState.ESTOP
        elif self.fault:
            self._state = SafetyState.FAULT
        else:
            self._state = SafetyState.NORMAL

    def set_fault(self, fault: str | None) -> None:
        self.fault = fault
        if fault:
            self._state = SafetyState.FAULT
            self.audit.emit("safety-gateway", "fault_set", severity="error", fault=fault)
        else:
            self._recompute_state()

    def set_required_sensors_ok(self, ok: bool) -> None:
        self.required_sensors_ok = ok
        if not ok and self._state == SafetyState.NORMAL:
            self._state = SafetyState.WARNING

    def evaluate_motion(self, cmd: MotorCommand, now: int | None = None) -> SafetyDecision:
        now = now_ms() if now is None else now
        if self.estop_active:
            return self._deny("estop active", SafetyState.ESTOP, now)
        if self._estop_latch:
            return self._deny("estop latched; operator reset required", SafetyState.ESTOP, now)
        if self.fault:
            return self._deny(f"fault active: {self.fault}", SafetyState.FAULT, now)
        if not self.required_sensors_ok:
            return self._deny("required sensors not healthy", SafetyState.SAFE_STOP, now)
        if cmd.source == "ai_raw":
            return self._deny("raw AI commands are not allowed", SafetyState.SAFE_STOP, now)
        mode_problem = modes.motion_refusal(self.operating_mode, cmd.source, cmd.linear_x_mps, cmd.angular_z_rps)
        if mode_problem:
            return self._deny(mode_problem, SafetyState.SAFE_STOP, now)
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
        if self.estop_active or self._estop_latch:
            return self._deny(f"estop active; {capability} refused", SafetyState.ESTOP, now)
        if self.fault:
            return self._deny(f"fault active; {capability} refused", SafetyState.FAULT, now)
        return SafetyDecision(True, "allowed", self._state, now)

    def _deny(self, reason: str, state: SafetyState, now: int) -> SafetyDecision:
        self._state = state
        self.audit.emit("safety-gateway", "motion_denied", severity="warning", reason=reason, state=state.value)
        return SafetyDecision(False, reason, state, now)
