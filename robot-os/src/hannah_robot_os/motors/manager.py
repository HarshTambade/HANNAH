from __future__ import annotations

from dataclasses import dataclass, field

from ..common import AuditLog, now_ms
from ..config import SafetyLimits
from .base import ControllerStatus, MotorCommand, MotorControllerAdapter


@dataclass
class MotorControllerManager:
    audit: AuditLog
    limits: SafetyLimits
    _controllers: dict[str, MotorControllerAdapter] = field(default_factory=dict)
    _last_command_ms: dict[str, int] = field(default_factory=dict)

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
        c.send_velocity(cmd.linear_x_mps, cmd.angular_z_rps)
        self._last_command_ms[cmd.controller_id] = now
        self.audit.emit(
            "motor-manager",
            "command_sent",
            controller_id=cmd.controller_id,
            command_id=cmd.command_id,
            linear_x_mps=cmd.linear_x_mps,
            angular_z_rps=cmd.angular_z_rps,
            command_source=cmd.source,
        )
        return c.status()

    def stop(self, controller_id: str, reason: str = "stop") -> ControllerStatus:
        c = self._require(controller_id)
        c.stop()
        self.audit.emit("motor-manager", "controller_stopped", controller_id=controller_id, reason=reason)
        return c.status()

    def watchdog_check(self, controller_id: str, now: int | None = None) -> ControllerStatus:
        now = now_ms() if now is None else now
        c = self._require(controller_id)
        st = c.status()
        last = self._last_command_ms.get(controller_id)
        if last is not None and now - last > self.limits.watchdog_timeout_ms:
            c.stop()
            self.audit.emit(
                "motor-manager",
                "watchdog_timeout_stop",
                severity="warning",
                controller_id=controller_id,
                age_ms=now - last,
            )
        if not st.watchdog_ok or st.estop_active or st.fault:
            c.stop()
        return c.status()

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
