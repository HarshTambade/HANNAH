"""What the operating system says about itself: load, memory, disk, temperatures, network links.

Read from Linux's /proc and /sys (the root can be moved for tests). Anything
this computer doesn't offer is None, never a guess: a value is only what was read.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return None


def memory(root: Path) -> dict | None:
    text = _read(root / "proc" / "meminfo")
    if not text:
        return None
    values = {}
    for line in text.splitlines():
        name, _, rest = line.partition(":")
        parts = rest.split()
        if parts and parts[0].isdigit():
            values[name.strip()] = int(parts[0]) * 1024
    total, available = values.get("MemTotal"), values.get("MemAvailable")
    if not total or available is None:
        return None
    return {"totalBytes": total, "availableBytes": available, "usedPercent": round(100.0 * (total - available) / total, 1)}


def load(root: Path) -> dict | None:
    text = _read(root / "proc" / "loadavg")
    if not text:
        return None
    parts = text.split()
    try:
        return {"load1": float(parts[0]), "load5": float(parts[1]), "load15": float(parts[2]), "cpus": os.cpu_count()}
    except (IndexError, ValueError):
        return None


def temperatures(root: Path) -> list[dict]:
    out = []
    base = root / "sys" / "class" / "thermal"
    if not base.is_dir():
        return out
    for zone in sorted(base.glob("thermal_zone*")):
        raw = _read(zone / "temp")
        if raw is None or not raw.lstrip("-").isdigit():
            continue
        out.append({"zone": zone.name, "type": _read(zone / "type") or zone.name, "celsius": round(int(raw) / 1000.0, 1)})
    return out


def network(root: Path) -> list[dict]:
    out = []
    base = root / "sys" / "class" / "net"
    if not base.is_dir():
        return out
    for link in sorted(base.iterdir()):
        if link.name == "lo":
            continue
        out.append({"interface": link.name, "state": _read(link / "operstate") or "unknown"})
    return out


def disk(path: str) -> dict | None:
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        return None
    return {"path": path, "totalBytes": usage.total, "freeBytes": usage.free, "usedPercent": round(100.0 * (usage.total - usage.free) / usage.total, 1) if usage.total else None}


def snapshot(root: str | Path = "/", data_dir: str = "/") -> dict:
    root = Path(root)
    return {"load": load(root), "memory": memory(root), "disk": disk(data_dir), "temperatures": temperatures(root), "network": network(root)}


__all__ = ["disk", "load", "memory", "network", "snapshot", "temperatures"]
