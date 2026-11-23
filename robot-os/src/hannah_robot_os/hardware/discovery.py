from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from ..common import AuditLog
from .models import HardwareDevice
from .registry import HardwareRegistry


class DiscoveryProvider(Protocol):
    name: str

    def discover(self) -> list[HardwareDevice]: ...


@dataclass
class SimulatedDiscoveryProvider:
    name: str = "simulated"
    devices: list[HardwareDevice] | None = None

    def discover(self) -> list[HardwareDevice]:
        return list(self.devices or [])


@dataclass
class HardwareDiscoveryService:
    audit: AuditLog
    registry: HardwareRegistry
    providers: list[DiscoveryProvider]

    def scan(self) -> list[HardwareDevice]:
        found: list[HardwareDevice] = []
        for p in self.providers:
            devices = p.discover()
            for d in devices:
                self.registry.register(d)
                found.append(d)
            self.audit.emit("hardware-discovery", "provider_scan", provider=p.name, count=len(devices))
        return found
