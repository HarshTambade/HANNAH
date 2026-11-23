from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class HardwareDevice:
    device_id: str
    kind: str  # motor_controller, sensor, camera, lidar, imu, battery, network, etc.
    manufacturer: str = ""
    model: str = ""
    revision: str = ""
    interface: str = ""  # usb, serial, can, ethernet, i2c, spi, uart
    driver: str = ""
    firmware: str = ""
    capabilities: list[str] = field(default_factory=list)
    config: dict[str, Any] = field(default_factory=dict)
    health: str = "unknown"
    permissions: list[str] = field(default_factory=list)
    last_seen_ms: int | None = None
    enabled: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
