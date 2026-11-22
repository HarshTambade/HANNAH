"""The protocol adapters this hub has. A profile names one; an unknown name is refused, never substituted."""
from __future__ import annotations

from .base import ABOUT_FIELDS, AdapterError, DeviceAdapter
from .http_device import HttpDevice
from .modbus_device import ModbusDevice
from .mqtt_device import MqttDevice
from .process import AdapterProcess

ADAPTERS = {adapter.NAME: adapter for adapter in (MqttDevice, ModbusDevice, HttpDevice)}


def create(device: dict, client_id: str = "hannah-hub", clock=None, isolated: bool = False) -> DeviceAdapter:
    name = ((device.get("profile") or {}).get("protocol") or {}).get("adapter")
    if name not in ADAPTERS:
        raise AdapterError(f"This hub has no adapter for “{name}”. It has: {', '.join(sorted(ADAPTERS))}.", "no-adapter")
    if isolated:
        if clock is not None:
            raise ValueError("An adapter process uses its own system clock.")
        return AdapterProcess(name, device, client_id)
    return ADAPTERS[name](device, clock=clock, client_id=client_id)


def about() -> list:
    return [{"name": name, **adapter.ABOUT} for name, adapter in sorted(ADAPTERS.items())]


__all__ = ["ABOUT_FIELDS", "ADAPTERS", "AdapterError", "DeviceAdapter", "about", "create"]
