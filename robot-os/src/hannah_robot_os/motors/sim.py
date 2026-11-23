from __future__ import annotations

from dataclasses import dataclass

from ..common import now_ms
from .base import ControllerStatus


@dataclass
class SimMotorController:
    controller_id: str = "sim-motor-1"
    _connected: bool = False
    _enabled: bool = False
    _fault: str | None = None
    _estop_active: bool = False
    _watchdog_ok: bool = True
    _linear: float = 0.0
    _angular: float = 0.0
    _encoder_left: float = 0.0
    _encoder_right: float = 0.0
    _last_feedback_ms: int | None = None

    def connect(self) -> None:
        self._connected = True
        self._last_feedback_ms = now_ms()
        self._fault = None

    def disconnect(self) -> None:
        self._connected = False
        self._enabled = False
        self._linear = 0.0
        self._angular = 0.0

    def status(self) -> ControllerStatus:
        return ControllerStatus(
            controller_id=self.controller_id,
            connected=self._connected,
            enabled=self._enabled,
            fault=self._fault,
            estop_active=self._estop_active,
            watchdog_ok=self._watchdog_ok,
            encoder_left=self._encoder_left,
            encoder_right=self._encoder_right,
            velocity_left_mps=self._linear - self._angular * 0.1,
            velocity_right_mps=self._linear + self._angular * 0.1,
            last_feedback_ms=self._last_feedback_ms,
        )

    def enable(self, enabled: bool) -> None:
        if not self._connected:
            raise RuntimeError("controller not connected")
        if self._estop_active and enabled:
            raise RuntimeError("cannot enable while estop active")
        if self._fault and enabled:
            raise RuntimeError("cannot enable while fault active")
        self._enabled = enabled
        if not enabled:
            self._linear = 0.0
            self._angular = 0.0

    def send_velocity(self, linear_x_mps: float, angular_z_rps: float) -> None:
        if not self._connected:
            raise RuntimeError("controller not connected")
        if not self._enabled:
            raise RuntimeError("controller not enabled")
        if self._estop_active:
            raise RuntimeError("estop active")
        if self._fault:
            raise RuntimeError("controller fault")
        self._linear = linear_x_mps
        self._angular = angular_z_rps
        # simple simulated encoder integration
        self._encoder_left += linear_x_mps - angular_z_rps * 0.1
        self._encoder_right += linear_x_mps + angular_z_rps * 0.1
        self._last_feedback_ms = now_ms()

    def stop(self) -> None:
        self._linear = 0.0
        self._angular = 0.0
        self._last_feedback_ms = now_ms()

    # test/sim hooks
    def trigger_estop(self, active: bool) -> None:
        self._estop_active = active
        if active:
            self._enabled = False
            self.stop()

    def inject_fault(self, fault: str | None) -> None:
        self._fault = fault
        if fault:
            self._enabled = False
            self.stop()

    def set_watchdog(self, ok: bool) -> None:
        self._watchdog_ok = ok
        if not ok:
            self._enabled = False
            self.stop()
