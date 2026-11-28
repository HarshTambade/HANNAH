"""Shared behaviour for two-wheel (differential drive) motor controller drivers.

A driver subclass only speaks its protocol: open/close the link, configure the
controller, engage/disengage the motors, command two motor speeds, and read
feedback. Everything that keeps the robot safe lives here, once:

- the body command is clamped to the safety limits, and each wheel to the
  wheel speed limit, before anything is encoded, so a driver never sends more
  than the limits even when asked (the manager rejects such commands first;
  this is the second line);
- a command that fails on the transport marks the controller faulted, disables
  it and tries to send zero and disengage;
- stop() never raises, so the loop that calls it keeps running; a failed stop is
  a fault;
- set_estop(True) sends zero, disengages and holds the controller disabled
  until set_estop(False) and an explicit enable;
- connect() after a fault reconnects and reconfigures, and leaves the
  controller disabled. It never clears an error the controller itself
  reports: that stays a fault ("controller: ...") until a person clears it.

Faults are "transport: ..." / "connect failed: ..." (the link) or
"controller: ..." (the controller's own error). The motor-controller service
retries only the first kind.

Speeds handed to subclasses are motor shaft speeds in turns per second, after
gearing and wheel direction.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Callable

from ...common import now_ms
from ...config import SafetyLimits
from ..base import ControllerStatus


class TransportError(RuntimeError):
    """The link to the controller failed: timeout, bad checksum, closed port."""


class ControllerFault(RuntimeError):
    """The controller reported an error of its own."""


@dataclass
class DriveGeometry:
    wheel_separation_m: float
    wheel_radius_m: float
    gear_ratio: float = 1.0  # motor turns per wheel turn
    invert_left: bool = False
    invert_right: bool = False
    max_wheel_speed_mps: float | None = None  # defaults to the linear speed limit

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "DriveGeometry":
        return DriveGeometry(
            wheel_separation_m=float(data["wheel_separation_m"]),
            wheel_radius_m=float(data["wheel_radius_m"]),
            gear_ratio=float(data.get("gear_ratio", 1.0)),
            invert_left=bool(data.get("invert_left", False)),
            invert_right=bool(data.get("invert_right", False)),
            max_wheel_speed_mps=float(data["max_wheel_speed_mps"]) if data.get("max_wheel_speed_mps") is not None else None,
        )

    def wheel_mps_to_motor_tps(self, wheel_mps: float) -> float:
        return wheel_mps / (2 * math.pi * self.wheel_radius_m) * self.gear_ratio

    def motor_tps_to_wheel_mps(self, motor_tps: float) -> float:
        return motor_tps / self.gear_ratio * 2 * math.pi * self.wheel_radius_m

    def motor_turns_to_wheel_m(self, motor_turns: float) -> float:
        return motor_turns / self.gear_ratio * 2 * math.pi * self.wheel_radius_m


def _label(error: Exception, what: str = "") -> str:
    """Fault text: the controller's own error, or the link's."""
    kind = "controller" if isinstance(error, ControllerFault) else "transport"
    return f"{kind}: {what}{error}"


def is_link_fault(fault: str | None) -> bool:
    """True for faults a reconnect may fix (never for the controller's own errors)."""
    return bool(fault) and (fault.startswith("transport:") or fault.startswith("connect failed:"))


def _clamp(value: float, limit: float) -> float:
    return max(-limit, min(limit, value))


def clamp_to_limits(linear: float, angular: float, limits: SafetyLimits, geometry: DriveGeometry) -> tuple[float, float, bool]:
    """Return (left_mps, right_mps, clamped). Never exceeds the limits."""
    if not (math.isfinite(linear) and math.isfinite(angular)):
        raise ValueError("velocity must be a finite number")
    lin = _clamp(linear, limits.max_linear_speed_mps)
    ang = _clamp(angular, limits.max_angular_speed_rps)
    half = geometry.wheel_separation_m / 2
    left, right = lin - ang * half, lin + ang * half
    cap = geometry.max_wheel_speed_mps if geometry.max_wheel_speed_mps is not None else limits.max_linear_speed_mps
    cap = min(cap, limits.max_linear_speed_mps + limits.max_angular_speed_rps * half)
    biggest = max(abs(left), abs(right))
    clamped = lin != linear or ang != angular
    if biggest > cap > 0:
        scale = cap / biggest
        left, right = left * scale, right * scale
        clamped = True
    left, right = _clamp(left, cap), _clamp(right, cap)
    return left, right, clamped


@dataclass
class Feedback:
    left_tps: float | None = None
    right_tps: float | None = None
    left_turns: float | None = None
    right_turns: float | None = None
    details: dict[str, Any] | None = None


class WheelPairDriver:
    """Base class. Subclasses implement the _open.._read_feedback hooks."""

    driver_name = "wheel-pair"

    def __init__(self, controller_id: str, limits: SafetyLimits, geometry: DriveGeometry, clock: Callable[[], int] = now_ms) -> None:
        self.controller_id = controller_id
        self.limits = limits
        self.geometry = geometry
        self.clock = clock
        self._connected = False
        self._enabled = False
        self._estop = False
        self._fault: str | None = None
        self._left_cmd_tps = 0.0
        self._right_cmd_tps = 0.0
        self._feedback = Feedback()
        self._last_feedback_ms: int | None = None
        self._clamp_count = 0
        self._reconnects = 0

    # ---- hooks for subclasses -------------------------------------------
    def _open(self) -> None: ...
    def _close(self) -> None: ...
    def _configure(self) -> None: ...
    def _engage(self) -> None: ...
    def _disengage(self) -> None: ...
    def _command(self, left_tps: float, right_tps: float) -> None: ...
    def _emergency(self) -> None:
        """Protocol emergency stop. Defaults to zero speed and disengage."""
        self._command(0.0, 0.0)
        self._disengage()
    def _read_feedback(self) -> Feedback | None:
        return None
    def max_motor_tps(self) -> float:
        cap = self.geometry.max_wheel_speed_mps if self.geometry.max_wheel_speed_mps is not None else self.limits.max_linear_speed_mps
        return self.geometry.wheel_mps_to_motor_tps(cap)

    # ---- MotorControllerAdapter -----------------------------------------
    def connect(self) -> None:
        was_faulted = self._fault is not None or self._connected
        self._enabled = False
        try:
            self._close()
        except Exception:
            pass
        try:
            self._open()
            self._configure()
        except Exception as error:
            self._connected = False
            controller = isinstance(error, ControllerFault)
            self._fault = f"controller: {error}" if controller else f"connect failed: {error}"
            try:
                self._close()
            except Exception:
                pass
            raise (ControllerFault if controller else TransportError)(self._fault) from error
        if was_faulted:
            self._reconnects += 1
        self._connected = True
        self._fault = None
        self._left_cmd_tps = self._right_cmd_tps = 0.0
        self._last_feedback_ms = self.clock()

    def disconnect(self) -> None:
        if self._connected:
            try:
                self._emergency()
            except Exception:
                pass
        try:
            self._close()
        except Exception:
            pass
        self._connected = False
        self._enabled = False
        self._left_cmd_tps = self._right_cmd_tps = 0.0

    def status(self) -> ControllerStatus:
        if self._connected and self._fault is None:
            try:
                fb = self._read_feedback()
                if fb is not None:
                    self._feedback = fb
                    self._last_feedback_ms = self.clock()
            except ControllerFault as error:
                self._fail(f"controller: {error}")
            except Exception as error:
                self._fail(f"transport: {error}")
        fb = self._feedback
        g = self.geometry
        details: dict[str, Any] = {
            "driver": self.driver_name,
            "commanded_left_tps": self._left_cmd_tps,
            "commanded_right_tps": self._right_cmd_tps,
            "clamped_commands": self._clamp_count,
            "reconnects": self._reconnects,
        }
        if fb.details:
            details.update(fb.details)
        return ControllerStatus(
            controller_id=self.controller_id,
            connected=self._connected,
            enabled=self._enabled,
            fault=self._fault,
            estop_active=self._estop,
            watchdog_ok=True,
            encoder_left=self._wheel(g.motor_turns_to_wheel_m, fb.left_turns, g.invert_left),
            encoder_right=self._wheel(g.motor_turns_to_wheel_m, fb.right_turns, g.invert_right),
            velocity_left_mps=self._wheel(g.motor_tps_to_wheel_mps, fb.left_tps, g.invert_left, default=self._commanded_wheel(True)),
            velocity_right_mps=self._wheel(g.motor_tps_to_wheel_mps, fb.right_tps, g.invert_right, default=self._commanded_wheel(False)),
            last_feedback_ms=self._last_feedback_ms,
            details=details,
        )

    def enable(self, enabled: bool) -> None:
        if not enabled:
            self._enabled = False
            self._left_cmd_tps = self._right_cmd_tps = 0.0
            if self._connected:
                try:
                    self._command(0.0, 0.0)
                    self._disengage()
                except Exception as error:
                    self._fail(_label(error))
            return
        if not self._connected:
            raise RuntimeError("controller not connected")
        if self._estop:
            raise RuntimeError("cannot enable while estop active")
        if self._fault:
            raise RuntimeError(f"cannot enable while fault active: {self._fault}")
        try:
            self._command(0.0, 0.0)
            self._engage()
        except Exception as error:
            self._fail(_label(error))
            raise RuntimeError(f"enable failed: {error}") from error
        self._enabled = True

    def send_velocity(self, linear_x_mps: float, angular_z_rps: float) -> None:
        if not self._connected:
            raise RuntimeError("controller not connected")
        if self._estop:
            raise RuntimeError("estop active")
        if self._fault:
            raise RuntimeError(f"controller fault: {self._fault}")
        if not self._enabled:
            raise RuntimeError("controller not enabled")
        try:
            left_mps, right_mps, clamped = clamp_to_limits(linear_x_mps, angular_z_rps, self.limits, self.geometry)
        except ValueError:
            self.stop()
            raise
        if clamped:
            self._clamp_count += 1
        g = self.geometry
        left = g.wheel_mps_to_motor_tps(left_mps) * (-1 if g.invert_left else 1)
        right = g.wheel_mps_to_motor_tps(right_mps) * (-1 if g.invert_right else 1)
        cap = self.max_motor_tps()
        left, right = _clamp(left, cap), _clamp(right, cap)
        try:
            self._command(left, right)
        except Exception as error:
            self._fail(_label(error))
            raise RuntimeError(f"velocity command failed: {error}") from error
        self._left_cmd_tps, self._right_cmd_tps = left, right

    def stop(self) -> None:
        """Command zero speed. Never raises; a failure becomes a fault."""
        self._left_cmd_tps = self._right_cmd_tps = 0.0
        if not self._connected:
            return
        try:
            self._command(0.0, 0.0)
        except Exception as error:
            self._fail(_label(error, "stop failed: "))

    def set_estop(self, active: bool) -> None:
        """Follow the safety gateway. Engaging sends the protocol's stop and
        disengages; releasing does not re-enable."""
        if active and not self._estop:
            self._enabled = False
            self._left_cmd_tps = self._right_cmd_tps = 0.0
            if self._connected:
                try:
                    self._emergency()
                except Exception as error:
                    self._fail(_label(error, "estop failed: "))
        self._estop = bool(active)

    # ---- helpers ---------------------------------------------------------
    def _fail(self, reason: str) -> None:
        """Record a fault, disable, and try once to stop the motors."""
        first = self._fault is None
        self._fault = self._fault or reason
        self._enabled = False
        self._left_cmd_tps = self._right_cmd_tps = 0.0
        self._feedback = Feedback()  # stale readings would look like motion
        if first and self._connected:
            try:
                self._emergency()
            except Exception:
                pass

    def _commanded_wheel(self, left: bool) -> float:
        g = self.geometry
        tps = self._left_cmd_tps if left else self._right_cmd_tps
        invert = g.invert_left if left else g.invert_right
        return g.motor_tps_to_wheel_mps(tps) * (-1 if invert else 1)

    @staticmethod
    def _wheel(convert: Callable[[float], float], value: float | None, invert: bool, default: float | None = None) -> float | None:
        if value is None:
            return default
        return convert(value) * (-1 if invert else 1)
