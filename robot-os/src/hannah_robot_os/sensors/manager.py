from __future__ import annotations

from dataclasses import dataclass, field

from ..common import AuditLog, now_ms
from ..hardware.models import HardwareDevice
from ..hardware.registry import HardwareRegistry


@dataclass
class SensorReading:
    device_id: str
    ts_ms: int
    frame_id: str = ""
    data: dict = field(default_factory=dict)
    valid: bool = True


@dataclass
class SensorManager:
    audit: AuditLog
    registry: HardwareRegistry
    required_sensor_ids: list[str] = field(default_factory=list)
    stale_after_ms: int = 2000
    _last_readings: dict[str, SensorReading] = field(default_factory=dict)

    def register_sensor(self, device: HardwareDevice) -> HardwareDevice:
        if device.kind not in {"sensor", "camera", "lidar", "imu", "gps", "battery", "depth"}:
            raise ValueError(f"not a sensor kind: {device.kind}")
        return self.registry.register(device)

    def ingest(self, reading: SensorReading, now: int | None = None) -> SensorReading:
        now = now_ms() if now is None else now
        device = self.registry.get(reading.device_id)
        if not device:
            raise KeyError(f"unknown sensor: {reading.device_id}")
        age = now - reading.ts_ms
        reading.valid = reading.valid and age >= 0 and age <= self.stale_after_ms
        self._last_readings[reading.device_id] = reading
        self.registry.mark_seen(reading.device_id, "ok" if reading.valid else "stale")
        if not reading.valid:
            self.audit.emit("sensor-manager", "invalid_reading", severity="warning", device_id=reading.device_id, age_ms=age)
        return reading

    def required_sensors_ok(self, now: int | None = None) -> bool:
        now = now_ms() if now is None else now
        for sid in self.required_sensor_ids:
            r = self._last_readings.get(sid)
            if not r or not r.valid or now - r.ts_ms > self.stale_after_ms:
                return False
        return True

    def status(self, now: int | None = None) -> dict:
        now = now_ms() if now is None else now
        sensors = self.registry.list()
        sensors = [d for d in sensors if d.kind in {"sensor", "camera", "lidar", "imu", "gps", "battery", "depth"}]
        out = []
        for d in sensors:
            r = self._last_readings.get(d.device_id)
            out.append({
                "device_id": d.device_id,
                "kind": d.kind,
                "health": d.health,
                "last_seen_ms": d.last_seen_ms,
                "reading_ts_ms": r.ts_ms if r else None,
                "valid": bool(r.valid) if r else False,
                "stale": (r is None) or (now - r.ts_ms > self.stale_after_ms),
            })
        return {"required_ok": self.required_sensors_ok(now), "sensors": out}
