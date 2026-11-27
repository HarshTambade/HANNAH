from __future__ import annotations

from dataclasses import dataclass, field

from ..common import AuditLog, now_ms
from ..config import SafetyLimits
from .base import ControllerStatus, MotorCommand, MotorControllerAdapter

# Longest interval credited to one acceleration step. A command that arrives
# after a long pause (or the first one from rest) may change speed by at most
# max_acceleration_mps2 * this interval.
MAX_RAMP_STEP_MS = 100


def ramp_linear(previous: float, requested: float, max_accel_mps2: float, dt_ms: int) -> float:
    """Limit a speed-up to the configured acceleration.

    Slowing down (towards zero) is never limited: a stop must take effect at
    once. A reversal first goes through zero, then ramps the other way.
    """
    if max_accel_mps2 <= 0:
        return requested
    step = max_accel_mps2 * max(0, min(dt_ms, MAX_RAMP_STEP_MS)) / 1000.0
    lo = min(previous - step, 0.0, previous)
    hi = max(previous + step, 0.0, previous)
    if previous > 0:
        lo = max(lo, 0.0)
    elif previous < 0:
        hi = min(hi, 0.0)
    return min(max(requested, lo), hi)


@dataclass
class MotorControllerManager:
    audit: AuditLog
    limits: SafetyLimits
    _controllers: dict[str, MotorControllerAdapter] = field(default_factory=dict)
    _last_command_ms: dict[str, int] = field(default_factory=dict)
    _last_linear: dict[str, float] = field(default_factory=dict)

    def register_controller(self, controller: MotorControllerAdapter) -> None:
        self._controllers[controller.controller_id] = controller
        self.audit.emit("motor-manager", "controller_registered", controller_id=controller.controller_id)

    def connect(self, controller_id: str) -> ControllerStatus:
        c = self._require(controller_id)
        c.connect()
        self.audit.emit("motor-manager", "controller_connected", controller_id=controller_id)
        return c.status()

    def status(self, controller_id: str) -> ControllerStatus:
        return self._require(controller_id).status()

    def enable(self, controller_id: str, enabled: bool) -> ControllerStatus:
        c = self._require(controller_id)
        st = c.status()
        if enabled:
            if st.estop_active:
                raise RuntimeError("estop active")
            if st.fault:
                raise RuntimeError(f"controller fault: {st.fault}")
            if not st.watchdog_ok:
                raise RuntimeError("watchdog not ok")
        c.enable(enabled)
        self.audit.emit("motor-manager", "controller_enabled", controller_id=controller_id, enabled=enabled)
        return c.status()

    def send_command(self, cmd: MotorCommand, now: int | None = None) -> ControllerStatus:
        now = now_ms() if now is None else now
        c = self._require(cmd.controller_id)
        st = c.status()
        self._validate_command(cmd, st, now)
        previous = self._last_linear.get(cmd.controller_id, 0.0)
        last = self._last_command_ms.get(cmd.controller_id)
        dt = MAX_RAMP_STEP_MS if last is None else now - last
        linear = ramp_linear(previous, cmd.linear_x_mps, self.limits.max_acceleration_mps2, dt)
        if linear != cmd.linear_x_mps:
            self.audit.emit(
                "motor-manager",
                "command_ramped",
                controller_id=cmd.controller_id,
                command_id=cmd.command_id,
                requested_linear_x_mps=cmd.linear_x_mps,
                applied_linear_x_mps=linear,
            )
        c.send_velocity(linear, cmd.angular_z_rps)
        self._last_command_ms[cmd.controller_id] = now
        self._last_linear[cmd.controller_id] = linear
        self.audit.emit(
            "motor-manager",
            "command_sent",
            controller_id=cmd.controller_id,
            command_id=cmd.command_id,
            linear_x_mps=linear,
            angular_z_rps=cmd.angular_z_rps,
            command_source=cmd.source,
        )
        return c.status()

    def stop(self, controller_id: str, reason: str = "stop") -> ControllerStatus:
        c = self._require(controller_id)
        c.stop()
        self._forget_motion(controller_id)
        self.audit.emit("motor-manager", "controller_stopped", controller_id=controller_id, reason=reason)
        return c.status()

    def watchdog_check(self, controller_id: str, now: int | None = None) -> ControllerStatus:
        now = now_ms() if now is None else now
        c = self._require(controller_id)
        st = c.status()
        last = self._last_command_ms.get(controller_id)
        if last is not None and now - last > self.limits.watchdog_timeout_ms:
            c.stop()
            # Forget the expired command so the stop is reported once, and the
            # next command ramps up from rest.
            self._forget_motion(controller_id)
            self.audit.emit(
                "motor-manager",
                "watchdog_timeout_stop",
                severity="warning",
                controller_id=controller_id,
                age_ms=now - last,
            )
        if not st.watchdog_ok or st.estop_active or st.fault:
            c.stop()
            self._forget_motion(controller_id)
        return c.status()

    def _forget_motion(self, controller_id: str) -> None:
        self._last_command_ms.pop(controller_id, None)
        self._last_linear.pop(controller_id, None)

    def _validate_command(self, cmd: MotorCommand, st: ControllerStatus, now: int) -> None:
        if cmd.controller_id != st.controller_id:
            raise ValueError("controller id mismatch")
        if not st.connected:
            raise RuntimeError("controller not connected")
        if st.estop_active:
            raise RuntimeError("estop active")
        if st.fault:
            raise RuntimeError(f"controller fault: {st.fault}")
        if not st.watchdog_ok:
            raise RuntimeError("controller watchdog not ok")
        if not st.enabled:
            raise RuntimeError("controller not enabled")
        age = now - cmd.issued_at_ms
        if age < 0:
            raise ValueError("command issued in future")
        if age > cmd.ttl_ms or age > self.limits.command_ttl_ms:
            raise ValueError(f"command expired: age_ms={age}")
        if abs(cmd.linear_x_mps) > self.limits.max_linear_speed_mps:
            raise ValueError("linear speed exceeds limit")
        if abs(cmd.angular_z_rps) > self.limits.max_angular_speed_rps:
            raise ValueError("angular speed exceeds limit")
        if cmd.source == "ai_raw":
            raise ValueError("raw AI commands are not allowed")

    def _require(self, controller_id: str) -> MotorControllerAdapter:
        c = self._controllers.get(controller_id)
        if not c:
            raise KeyError(f"unknown controller: {controller_id}")
        return c
