from __future__ import annotations

from typing import Any


REQUIRED_PROFILE_FIELDS = ["id", "name", "type", "status", "controllers", "sensors", "limits", "safety"]
ALLOWED_STATUS = {"experimental", "hil_tested", "physically_commissioned", "not_supported"}
ALLOWED_TRANSPORTS = {"sim", "serial", "can"}


def _positive_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


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
