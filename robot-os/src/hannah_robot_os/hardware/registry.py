from __future__ import annotations

from dataclasses import dataclass, field

from ..common import AuditLog, now_ms
from .models import HardwareDevice


@dataclass
class HardwareRegistry:
    audit: AuditLog
    _devices: dict[str, HardwareDevice] = field(default_factory=dict)

    def register(self, device: HardwareDevice) -> HardwareDevice:
        device.last_seen_ms = now_ms()
        self._devices[device.device_id] = device
        self.audit.emit("hardware-registry", "device_registered", device_id=device.device_id, kind=device.kind)
        return device

    def get(self, device_id: str) -> HardwareDevice | None:
        return self._devices.get(device_id)

    def list(self, kind: str | None = None) -> list[HardwareDevice]:
        devices = list(self._devices.values())
        if kind:
            devices = [d for d in devices if d.kind == kind]
        return sorted(devices, key=lambda d: d.device_id)

    def mark_seen(self, device_id: str, health: str | None = None) -> HardwareDevice:
        device = self._require(device_id)
        device.last_seen_ms = now_ms()
        if health is not None:
            device.health = health
        return device

    def set_enabled(self, device_id: str, enabled: bool, reason: str = "") -> HardwareDevice:
        device = self._require(device_id)
        device.enabled = enabled
        self.audit.emit(
            "hardware-registry",
            "device_enabled_changed",
            device_id=device_id,
            enabled=enabled,
            reason=reason,
        )
        return device

    def _require(self, device_id: str) -> HardwareDevice:
        device = self._devices.get(device_id)
        if not device:
            raise KeyError(f"unknown device: {device_id}")
        return device
