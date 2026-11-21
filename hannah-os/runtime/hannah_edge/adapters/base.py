"""What every protocol adapter gives the hub, and the checks they all share.

An adapter presents ONE device as its profile describes it: a set of named
points. Nothing above an adapter ever sees a topic, a register address or a
URL; it sees "temperature" and "power". A write goes only to a point the
profile lists as writable, with a value of the point's type inside its range.
There is no way to ask an adapter for an address the profile doesn't name.

Each adapter also declares what it is (ABOUT): protocol and version, how it
authenticates, what it can and cannot do, its limits, and how far it has been
tested. That declaration is shown to people; it is checked by a test.
"""
from __future__ import annotations

import json
import re
import time

POINT_TYPES = ("boolean", "number", "enum", "text")
SETTING = re.compile(r"\{([a-zA-Z][a-zA-Z0-9_]*)\}")
ABOUT_FIELDS = ("protocol", "version", "authentication", "encryption", "reads", "writes", "rateLimit", "errors", "permissions", "security", "diagnostics", "tested", "notSupported")


class AdapterError(Exception):
    def __init__(self, message: str, reason: str = "error"):
        super().__init__(message)
        self.reason = reason


def fill(template: str, settings: dict) -> str:
    """Put a device's settings into a template such as "tele/{topic}/SENSOR". An unknown name is an error, never an empty string."""
    def swap(match):
        name = match.group(1)
        if name not in settings or settings[name] in (None, ""):
            raise AdapterError(f"The setting “{name}” is needed and wasn't given.", "missing-setting")
        return str(settings[name])
    return SETTING.sub(swap, str(template))


def dig(value, path: str):
    """Follow a dotted path into parsed JSON. Returns (found, value)."""
    for part in [item for item in str(path or "").split(".") if item]:
        if isinstance(value, dict) and part in value:
            value = value[part]
        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        else:
            return False, None
    return True, value


def check_value(point: dict, value):
    """Is this value one the point accepts? Returns the value in the point's type, or raises with the reason."""
    kind = point.get("type")
    name = point.get("name") or point.get("id")
    if kind == "boolean":
        if not isinstance(value, bool):
            raise AdapterError(f"{name} is on or off.", "bad-value")
        return value
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or value in (float("inf"), float("-inf")):
            raise AdapterError(f"{name} needs a number.", "bad-value")
        low, high = (point.get("range") or [None, None])[:2]
        if low is None or high is None:
            raise AdapterError(f"{name} has no allowed range, so nothing can be written to it.", "no-range")
        if value < low or value > high:
            raise AdapterError(f"{name} accepts {low} to {high}{' ' + point['unit'] if point.get('unit') else ''}; {value} is outside that.", "out-of-range")
        step = point.get("step")
        if step:
            turns = (value - low) / step
            if abs(turns - round(turns)) > 1e-6:
                raise AdapterError(f"{name} moves in steps of {step}.", "bad-step")
        return value
    if kind == "enum":
        if value not in (point.get("choices") or []):
            raise AdapterError(f"{name} accepts: {', '.join(map(str, point.get('choices') or []))}.", "bad-value")
        return value
    raise AdapterError(f"{name} can't be written.", "not-writable")


def writable(point: dict) -> bool:
    return point.get("access") == "read-write" and point.get("type") in ("boolean", "number", "enum")


def decode(point: dict, raw, mapping: dict | None = None):
    """Turn what a device sent into the point's type. Returns (ok, value). A value that doesn't fit is rejected, not coerced."""
    mapping = mapping or {}
    kind = point.get("type")
    if kind == "boolean":
        if isinstance(raw, bool):
            return True, raw
        text = str(raw).strip()
        if "on" in mapping or "off" in mapping:
            if text == str(mapping.get("on")):
                return True, True
            if text == str(mapping.get("off")):
                return True, False
            return False, None
        if text.lower() in ("1", "true", "on"):
            return True, True
        if text.lower() in ("0", "false", "off"):
            return True, False
        return False, None
    if kind == "number":
        if isinstance(raw, bool):
            return False, None
        try:
            number = float(raw) if not isinstance(raw, (int, float)) else raw
        except (TypeError, ValueError):
            return False, None
        if number != number or number in (float("inf"), float("-inf")):
            return False, None
        number = number * mapping.get("scale", 1) + mapping.get("offset", 0)
        return True, round(number, 6)
    if kind == "enum":
        text = raw if isinstance(raw, str) else str(raw)
        text = {str(value): key for key, value in (mapping.get("values") or {}).items()}.get(text.strip(), text.strip())
        return (True, text) if text in (point.get("choices") or []) else (False, None)
    if kind == "text":
        return True, str(raw)[:200]
    return False, None


def parse_payload(payload: bytes, path: str | None):
    """A device's message as a value: raw text, or one field of a JSON message. Returns (ok, value)."""
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        return False, None
    if not path:
        return True, text
    try:
        return dig(json.loads(text), path)
    except ValueError:
        return False, None


class DeviceAdapter:
    """One device. Subclasses talk the protocol; this class keeps the readings."""

    NAME = ""
    ABOUT: dict = {}

    def __init__(self, device: dict, clock=time.time):
        self.device = device
        self.profile = device.get("profile") or {}
        self.settings = device.get("settings") or {}
        self.points = {point["id"]: point for point in self.profile.get("points", [])}
        self.clock = clock
        self._readings: dict = {}
        self._state = {"state": "starting", "reason": "", "message": "", "since": clock()}
        self.rejected = 0

    # --- what the hub reads ---
    def connection(self) -> dict:
        return dict(self._state)

    def readings(self) -> dict:
        return {key: dict(value) for key, value in self._readings.items()}

    def reading(self, point_id: str):
        value = self._readings.get(point_id)
        return dict(value) if value else None

    # --- for subclasses ---
    def _set_state(self, state: str, reason: str = "", message: str = "") -> None:
        if self._state["state"] != state or self._state["reason"] != reason:
            self._state = {"state": state, "reason": reason, "message": message, "since": self.clock()}
        else:
            self._state["message"] = message

    def _record(self, point_id: str, raw, mapping: dict | None = None) -> bool:
        point = self.points.get(point_id)
        if not point:
            return False
        ok, value = decode(point, raw, mapping)
        if ok and point.get("type") == "number" and point.get("range"):
            low, high = point["range"][:2]
            # A reading far outside what the device can measure is a fault or a wrong mapping, not a temperature.
            span = (high - low) or 1
            if value < low - span or value > high + span:
                ok = False
        if not ok:
            self.rejected += 1
            return False
        self._readings[point_id] = {"value": value, "at": int(self.clock() * 1000), "source": "device"}
        return True

    def point_for_write(self, point_id: str, value):
        point = self.points.get(point_id)
        if not point:
            raise AdapterError("This device has no such point.", "unknown-point")
        if not writable(point):
            raise AdapterError(f"{point.get('name') or point_id} can only be read.", "not-writable")
        return point, check_value(point, value)

    # --- what subclasses provide ---
    def start(self) -> None:
        raise NotImplementedError

    def stop(self) -> None:
        raise NotImplementedError

    def poll(self) -> None:
        """Called about once a second: reconnect when needed, poll what must be polled."""

    def write(self, point_id: str, value) -> None:
        raise NotImplementedError

    def has_feedback(self, point_id: str) -> bool:
        """Can a write to this point be confirmed by reading it back?"""
        return False

    def refresh(self, point_id: str) -> None:
        """Ask the device for this point now, where the protocol allows (used to confirm a write)."""
