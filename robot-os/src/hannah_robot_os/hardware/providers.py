from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .models import HardwareDevice


@dataclass
class SysfsUSBDiscoveryProvider:
    """Read-only USB discovery from a sysfs-like root. No device writes."""

    sysfs_root: str | Path = "/sys/bus/usb/devices"
    name: str = "usb-sysfs"

    def discover(self) -> list[HardwareDevice]:
        root = Path(self.sysfs_root)
        if not root.exists():
            return []
        devices: list[HardwareDevice] = []
        for entry in sorted(root.iterdir()):
            if not entry.is_dir():
                continue
            vid = _read(entry / "idVendor")
            pid = _read(entry / "idProduct")
            if not vid or not pid:
                continue
            dev = HardwareDevice(
                device_id=f"usb-{vid}:{pid}-{entry.name}",
                kind="usb_device",
                manufacturer=_read(entry / "manufacturer"),
                model=_read(entry / "product"),
                revision=_read(entry / "bcdDevice"),
                interface="usb",
                driver=_read(entry / "driver"),
                capabilities=["metadata_read"],
                config={"vendor_id": vid, "product_id": pid, "sysfs_path": str(entry)},
                health="detected",
            )
            devices.append(dev)
        return devices


@dataclass
class StaticSerialDiscoveryProvider:
    """Discovery from an injected port list. Safe for tests; real impl should query OS without opening devices."""

    ports: list[str]
    name: str = "serial-static"

    def discover(self) -> list[HardwareDevice]:
        out = []
        for p in sorted(set(self.ports)):
            out.append(HardwareDevice(
                device_id=f"serial-{Path(p).name}",
                kind="serial_port",
                interface="serial",
                capabilities=["metadata_read"],
                config={"path": p},
                health="detected",
            ))
        return out


@dataclass
class StaticCANDiscoveryProvider:
    interfaces: list[str]
    name: str = "can-static"

    def discover(self) -> list[HardwareDevice]:
        return [HardwareDevice(
            device_id=f"can-{iface}",
            kind="can_interface",
            interface="can",
            capabilities=["metadata_read"],
            config={"interface": iface},
            health="detected",
        ) for iface in sorted(set(self.interfaces))]


@dataclass
class LinuxSerialDiscoveryProvider:
    """Read-only discovery from Linux serial symlinks. Never opens a device."""

    serial_by_id: str | Path = "/dev/serial/by-id"
    sys_class_tty: str | Path = "/sys/class/tty"
    name: str = "linux-serial"

    def discover(self) -> list[HardwareDevice]:
        devices: list[HardwareDevice] = []
        by_id = Path(self.serial_by_id)
        if by_id.exists():
            for entry in sorted(by_id.iterdir()):
                if not entry.is_symlink():
                    continue
                target = ""
                try:
                    target = str(entry.resolve())
                except Exception:
                    pass
                devices.append(HardwareDevice(
                    device_id=f"serial-by-id-{entry.name}",
                    kind="serial_port",
                    manufacturer=_identity_hint(entry.name),
                    interface="serial",
                    capabilities=["metadata_read"],
                    config={"path": str(entry), "target": target, "by_id": True},
                    health="detected",
                ))
        tty = Path(self.sys_class_tty)
        if tty.exists():
            for entry in sorted(tty.iterdir()):
                if not entry.is_dir() or entry.name.startswith("ttyS") and not (entry / "device").exists():
                    continue
                if not (entry / "device").exists() and not entry.name.startswith("ttyUSB") and not entry.name.startswith("ttyACM"):
                    continue
                devices.append(HardwareDevice(
                    device_id=f"tty-{entry.name}",
                    kind="serial_port",
                    interface="serial",
                    capabilities=["metadata_read"],
                    config={"sys_path": str(entry), "name": entry.name},
                    health="detected",
                ))
        return devices


@dataclass
class SocketCANDiscoveryProvider:
    """Read-only SocketCAN interface discovery from sysfs. No network writes."""

    sysfs_net: str | Path = "/sys/class/net"
    name: str = "socketcan"

    def discover(self) -> list[HardwareDevice]:
        root = Path(self.sysfs_net)
        if not root.exists():
            return []
        devices = []
        for entry in sorted(root.iterdir()):
            if not entry.name.startswith("can") and not entry.name.startswith("vcan"):
                continue
            devices.append(HardwareDevice(
                device_id=f"can-{entry.name}",
                kind="can_interface",
                interface="can",
                capabilities=["metadata_read", "socketcan_frames"],
                config={
                    "name": entry.name,
                    "operstate": _read(entry / "operstate"),
                    "mtu": _read(entry / "mtu"),
                },
                health="detected",
            ))
        return devices


def _identity_hint(name: str) -> str:
    text = name.lower()
    if "ftdi" in text:
        return "FTDI"
    if "usb" in text:
        return "USB serial"
    return ""


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except Exception:
        return ""
