"""Build motor controllers from a hardware profile's `controllers` entries.

The profile picks the driver; with no profile the motor-controller service
keeps using the simulated controller. Real links are opened only when the
controller connects, and optional libraries (pyserial, python-can) are
imported only if a profile asks for them.
"""
from __future__ import annotations

from dataclasses import replace
from typing import Any, Callable

from ..common import now_ms
from ..config import SafetyLimits
from .base import ControllerStatus
from .framed import FramedTransport
from .serial_adapter import SerialControllerAdapter
from .sim import SimMotorController

SIM_DRIVERS = {"sim", "sim_serial_v1"}
CAN_DRIVERS = {"odrive_can", "vesc_can"}
SERIAL_DRIVERS = {"odrive_ascii", "dynamixel_p2", "vesc_uart", "hannah_framed_serial"}
REAL_DRIVERS = CAN_DRIVERS | SERIAL_DRIVERS
KNOWN_DRIVERS = SIM_DRIVERS | REAL_DRIVERS
MANUFACTURER = {
    "odrive_can": "ODrive Robotics", "odrive_ascii": "ODrive Robotics", "dynamixel_p2": "ROBOTIS",
    "vesc_can": "VESC", "vesc_uart": "VESC", "hannah_framed_serial": "HANNAH",
}


def effective_limits(limits: SafetyLimits, profile: dict[str, Any] | None) -> SafetyLimits:
    """The stricter of the Robot OS config and the hardware profile, per limit."""
    if not profile:
        return limits
    out = replace(limits)
    prof_limits = profile.get("limits") or {}
    for key in ("max_linear_speed_mps", "max_angular_speed_rps", "max_acceleration_mps2"):
        value = prof_limits.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            setattr(out, key, min(getattr(out, key), float(value)))
    safety = profile.get("safety") or {}
    for key in ("command_ttl_ms", "watchdog_timeout_ms"):
        value = safety.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            setattr(out, key, min(getattr(out, key), value))
    return out


class FramedSerialDriver:
    """HANNAH's own newline-framed JSON protocol (motors/protocol.py) to a
    microcontroller that drives the wheels (for example hobby ESCs or H-bridges
    over PWM). The firmware for that microcontroller is not part of this
    repository. Adds clamping, estop and transport-error handling around
    SerialControllerAdapter."""

    driver_name = "hannah_framed_serial"

    def __init__(self, controller_id: str, stream: Any, limits: SafetyLimits, timeout_ms: int = 500, retries: int = 1) -> None:
        self.controller_id = controller_id
        self.stream = stream
        self.limits = limits
        self.inner = SerialControllerAdapter(controller_id, FramedTransport(write=stream.write, read_line=stream.read_line, timeout_ms=timeout_ms, retries=retries))
        self._fault: str | None = None
        self._estop = False

    def connect(self) -> None:
        try:
            self.stream.close()
        except Exception:
            pass
        try:
            self.stream.open()
        except Exception as error:
            self._fault = f"connect failed: {error}"
            raise
        self.inner.connect()
        self.inner._enabled = False
        self._fault = None

    def disconnect(self) -> None:
        self.stop()
        self.inner.disconnect()
        try:
            self.stream.close()
        except Exception:
            pass

    def status(self) -> ControllerStatus:
        try:
            st = self.inner.status()
        except Exception as error:
            self._fail(f"transport: {error}")
            st = ControllerStatus(controller_id=self.controller_id, connected=self.inner._connected, enabled=False)
        if self._fault:
            st.fault, st.enabled = self._fault, False
        st.estop_active = st.estop_active or self._estop
        st.details = {**st.details, "driver": self.driver_name}
        return st

    def enable(self, enabled: bool) -> None:
        if enabled and self._estop:
            raise RuntimeError("cannot enable while estop active")
        if enabled and self._fault:
            raise RuntimeError(f"cannot enable while fault active: {self._fault}")
        try:
            self.inner.enable(enabled)
        except Exception as error:
            self._fail(f"transport: {error}")
            raise

    def send_velocity(self, linear_x_mps: float, angular_z_rps: float) -> None:
        if self._estop:
            raise RuntimeError("estop active")
        if self._fault:
            raise RuntimeError(f"controller fault: {self._fault}")
        lin = max(-self.limits.max_linear_speed_mps, min(self.limits.max_linear_speed_mps, linear_x_mps))
        ang = max(-self.limits.max_angular_speed_rps, min(self.limits.max_angular_speed_rps, angular_z_rps))
        try:
            self.inner.send_velocity(lin, ang)
        except Exception as error:
            self._fail(f"transport: {error}")
            raise RuntimeError(f"velocity command failed: {error}") from error

    def stop(self) -> None:
        try:
            self.inner.stop()
        except Exception as error:
            self._fail(f"transport: stop failed: {error}")

    def set_estop(self, active: bool) -> None:
        if active and not self._estop:
            self.stop()
            try:
                self.inner.enable(False)
            except Exception as error:
                self._fail(f"transport: estop failed: {error}")
        self._estop = bool(active)

    def _fail(self, reason: str) -> None:
        first = self._fault is None
        self._fault = self._fault or reason
        if first:
            try:
                self.inner.stop()
            except Exception:
                pass


def build_controller(
    entry: dict[str, Any],
    limits: SafetyLimits,
    clock: Callable[[], int] = now_ms,
    can_bus_factory: Callable[[dict], Any] | None = None,
    stream_factory: Callable[[dict], Any] | None = None,
):
    """One controller from one profile entry. Factories are injectable for tests."""
    from .drivers.base import DriveGeometry
    from .drivers.buses import make_byte_stream, make_can_bus

    can_bus_factory = can_bus_factory or make_can_bus
    stream_factory = stream_factory or make_byte_stream
    driver = entry.get("driver")
    cid = entry["controller_id"]
    transport = entry.get("transport") or {}
    options = entry.get("options") or {}
    if driver in SIM_DRIVERS:
        return SimMotorController(controller_id=cid)
    if driver not in REAL_DRIVERS:
        raise ValueError(f"unknown motor driver {driver!r}; known: {sorted(KNOWN_DRIVERS)}")
    if driver == "hannah_framed_serial":
        return FramedSerialDriver(cid, stream_factory(transport), limits, int(transport.get("timeout_ms", 500)), int(transport.get("retries", 1)))
    geometry = DriveGeometry.from_dict(entry["drive"])
    if driver == "odrive_can":
        from .drivers.odrive import ODriveCanDriver

        return ODriveCanDriver(
            cid, can_bus_factory(transport), limits, geometry,
            left_node_id=int(options.get("left_node_id", 0)), right_node_id=int(options.get("right_node_id", 1)),
            current_limit_a=float(options.get("current_limit_a", 10.0)),
            heartbeat_timeout_ms=int(options.get("heartbeat_timeout_ms", 500)), clock=clock,
        )
    if driver == "odrive_ascii":
        from .drivers.odrive import ODriveAsciiDriver

        return ODriveAsciiDriver(
            cid, stream_factory(transport), limits, geometry,
            left_axis=int(options.get("left_axis", 0)), right_axis=int(options.get("right_axis", 1)),
            checksum=bool(options.get("checksum", True)), error_property=str(options.get("error_property", "active_errors")), clock=clock,
        )
    if driver == "dynamixel_p2":
        from .drivers.dynamixel import DynamixelDriver

        return DynamixelDriver(
            cid, stream_factory(transport), limits, geometry,
            left_id=int(options.get("left_id", 1)), right_id=int(options.get("right_id", 2)),
            bus_watchdog_ms=int(options.get("bus_watchdog_ms", 0)), pulses_per_turn=int(options.get("pulses_per_turn", 4096)),
            model_velocity_limit_raw=int(options.get("model_velocity_limit_raw", 1023)), clock=clock,
        )
    if driver == "vesc_can":
        from .drivers.vesc import VescCanDriver

        return VescCanDriver(
            cid, can_bus_factory(transport), limits, geometry, pole_pairs=int(options.get("pole_pairs", 7)),
            left_can_id=int(options.get("left_can_id", 0)), right_can_id=int(options.get("right_can_id", 1)),
            status_timeout_ms=int(options.get("status_timeout_ms", 500)), clock=clock,
        )
    from .drivers.vesc import VescUartDriver

    left = options.get("left_can_id")
    right = options.get("right_can_id", 1)
    return VescUartDriver(
        cid, stream_factory(transport), limits, geometry, pole_pairs=int(options.get("pole_pairs", 7)),
        left_can_id=None if left is None else int(left), right_can_id=None if right is None else int(right), clock=clock,
    )


def build_from_profile(profile: dict[str, Any], limits: SafetyLimits, **kwargs) -> list:
    return [build_controller(entry, limits, **kwargs) for entry in profile.get("controllers", []) if entry.get("kind") == "motor_controller"]
