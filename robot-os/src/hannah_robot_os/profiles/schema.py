from __future__ import annotations

from typing import Any


REQUIRED_PROFILE_FIELDS = ["id", "name", "type", "status", "controllers", "sensors", "limits", "safety"]
ALLOWED_STATUS = {"experimental", "hil_tested", "physically_commissioned", "not_supported"}
ALLOWED_TRANSPORTS = {"sim", "serial", "can"}


def _positive_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


SERIAL_BACKENDS = {"posix", "pyserial"}
CAN_BACKENDS = {"socketcan", "python-can"}
# Real motor drivers (motors/factory.py) and the transport each needs.
DRIVER_TRANSPORT = {
    "odrive_can": "can",
    "vesc_can": "can",
    "odrive_ascii": "serial",
    "dynamixel_p2": "serial",
    "vesc_uart": "serial",
    "hannah_framed_serial": "serial",
}
GEOMETRY_DRIVERS = set(DRIVER_TRANSPORT) - {"hannah_framed_serial"}


def _int_in(value: Any, lo: int, hi: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and lo <= value <= hi


def _validate_ids(options: dict, keys: tuple[str, str], lo: int, hi: int, prefix: str, errors: list[str], nullable: bool = False) -> None:
    seen = []
    for key in keys:
        if key not in options:
            continue
        value = options[key]
        if value is None and nullable:
            seen.append(None)
            continue
        if not _int_in(value, lo, hi):
            errors.append(f"invalid {prefix}.options.{key} (must be {lo}..{hi})")
        seen.append(value)
    if len(seen) == 2 and seen[0] == seen[1]:
        errors.append(f"{prefix}.options: left and right must differ")


def _validate_driver(c: dict, index: int, errors: list[str]) -> None:
    driver = c.get("driver")
    if driver not in DRIVER_TRANSPORT:
        return
    prefix = f"controllers[{index}]"
    transport = c.get("transport")
    want = DRIVER_TRANSPORT[driver]
    if not isinstance(transport, dict) or transport.get("kind") != want:
        errors.append(f"{prefix}: driver {driver} needs a {want} transport")
    if isinstance(transport, dict):
        backend = transport.get("backend")
        allowed = CAN_BACKENDS if want == "can" else SERIAL_BACKENDS
        if backend is not None and backend not in allowed:
            errors.append(f"invalid {prefix}.transport.backend: {backend}")
    if driver in GEOMETRY_DRIVERS:
        drive = c.get("drive")
        if not isinstance(drive, dict):
            errors.append(f"{prefix}.drive is required for {driver} (wheel_separation_m, wheel_radius_m)")
        else:
            for key in ("wheel_separation_m", "wheel_radius_m"):
                if not _positive_number(drive.get(key)):
                    errors.append(f"invalid {prefix}.drive.{key}")
            for key in ("gear_ratio", "max_wheel_speed_mps"):
                if key in drive and not _positive_number(drive[key]):
                    errors.append(f"invalid {prefix}.drive.{key}")
            for key in ("invert_left", "invert_right"):
                if key in drive and not isinstance(drive[key], bool):
                    errors.append(f"invalid {prefix}.drive.{key}")
    options = c.get("options", {})
    if not isinstance(options, dict):
        errors.append(f"{prefix}.options must be an object")
        return
    if driver == "odrive_can":
        _validate_ids(options, ("left_node_id", "right_node_id"), 0, 0x3E, prefix, errors)
        for key in ("current_limit_a",):
            if key in options and not _positive_number(options[key]):
                errors.append(f"invalid {prefix}.options.{key}")
        if "heartbeat_timeout_ms" in options and not _int_in(options["heartbeat_timeout_ms"], 1, 10_000):
            errors.append(f"invalid {prefix}.options.heartbeat_timeout_ms")
    elif driver == "odrive_ascii":
        _validate_ids(options, ("left_axis", "right_axis"), 0, 1, prefix, errors)
        if "checksum" in options and not isinstance(options["checksum"], bool):
            errors.append(f"invalid {prefix}.options.checksum")
    elif driver == "dynamixel_p2":
        _validate_ids(options, ("left_id", "right_id"), 0, 252, prefix, errors)
        if "bus_watchdog_ms" in options and not _int_in(options["bus_watchdog_ms"], 0, 127 * 20):
            errors.append(f"invalid {prefix}.options.bus_watchdog_ms (0..2540)")
        for key in ("pulses_per_turn", "model_velocity_limit_raw"):
            if key in options and not _int_in(options[key], 1, 1 << 30):
                errors.append(f"invalid {prefix}.options.{key}")
    elif driver in ("vesc_can", "vesc_uart"):
        _validate_ids(options, ("left_can_id", "right_can_id"), 0, 254, prefix, errors, nullable=driver == "vesc_uart")
        if "pole_pairs" in options and not _int_in(options["pole_pairs"], 1, 100):
            errors.append(f"invalid {prefix}.options.pole_pairs")
        if "status_timeout_ms" in options and not _int_in(options["status_timeout_ms"], 1, 10_000):
            errors.append(f"invalid {prefix}.options.status_timeout_ms")


def _validate_transport(transport: Any, index: int, errors: list[str]) -> None:
    prefix = f"controllers[{index}].transport"
    if not isinstance(transport, dict):
        errors.append(f"{prefix} must be an object")
        return
    kind = transport.get("kind")
    if kind not in ALLOWED_TRANSPORTS:
        errors.append(f"invalid {prefix}.kind: {kind}")
        return
    for key in ["timeout_ms", "retries"]:
        if key in transport and (not isinstance(transport[key], int) or transport[key] < 0):
            errors.append(f"invalid {prefix}.{key}")
    if kind == "serial":
        if not transport.get("path"):
            errors.append(f"{prefix}.path is required for serial")
        if "baudrate" in transport and (not isinstance(transport["baudrate"], int) or transport["baudrate"] <= 0):
            errors.append(f"invalid {prefix}.baudrate")
    if kind == "can":
        if not transport.get("interface"):
            errors.append(f"{prefix}.interface is required for CAN")
        if "channel" in transport and (not isinstance(transport["channel"], int) or not 0 <= transport["channel"] <= 255):
            errors.append(f"invalid {prefix}.channel")
        if "mtu" in transport and (not isinstance(transport["mtu"], int) or transport["mtu"] < 8):
            errors.append(f"invalid {prefix}.mtu")


def validate_hardware_profile(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for f in REQUIRED_PROFILE_FIELDS:
        if f not in data:
            errors.append(f"missing field: {f}")
    status = data.get("status")
    if status and status not in ALLOWED_STATUS:
        errors.append(f"invalid status: {status}")
    for i, c in enumerate(data.get("controllers", []) or []):
        for f in ["controller_id", "kind", "driver", "interface"]:
            if f not in c:
                errors.append(f"controllers[{i}] missing {f}")
        if "transport" in c:
            _validate_transport(c["transport"], i, errors)
        _validate_driver(c, i, errors)
    limits = data.get("limits", {})
    if isinstance(limits, dict):
        for k in ["max_linear_speed_mps", "max_angular_speed_rps", "max_acceleration_mps2"]:
            if k in limits and not _positive_number(limits[k]):
                errors.append(f"invalid limit: {k}")
    safety = data.get("safety", {})
    if isinstance(safety, dict):
        for k in ["command_ttl_ms", "watchdog_timeout_ms"]:
            if k in safety and (not isinstance(safety[k], int) or safety[k] <= 0):
                errors.append(f"invalid safety.{k}")
        ttl = safety.get("command_ttl_ms")
        watchdog = safety.get("watchdog_timeout_ms")
        if isinstance(ttl, int) and isinstance(watchdog, int) and watchdog > ttl:
            errors.append("watchdog_timeout_ms must not exceed command_ttl_ms")
        if status == "physically_commissioned" and "requires_physical_estop" not in safety:
            errors.append("physically commissioned profiles must declare requires_physical_estop")
    return errors
