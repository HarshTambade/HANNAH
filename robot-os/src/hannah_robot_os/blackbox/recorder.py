"""Robot OS's black box: service, safety, motor, sensor and driver events, and system telemetry.

    box = OSBlackBox("/var/lib/hannah-robot-os/blackbox", cfg.robot_id, simulated=True)
    audit.sinks.append(box.sink)          # every AuditLog event is recorded
    box.sample_system()                    # CPU load, memory, disk, temperatures, network (rate-limited)
    box.motor_status("left", status)       # a motor controller's status, targets vs feedback

Segments use the HBX format (format.py), one stream per kind of record, each
deleted whole when its retention runs out; the oldest telemetry goes first
when the recording passes its size cap. Events are queued for HANNAH as
bridge envelopes (kind "event"); telemetry stays on the robot.

Robot OS records no camera or microphone data at all; a payload key that
holds raw bytes (data, image, audio, ...) is replaced by a marker.
"""
from __future__ import annotations

import os
import threading
import time
import uuid

from ..common import AuditEvent
from . import system
from .format import SUFFIX, SegmentWriter, is_segment, read_segment

SOURCES = {"safety-gateway": "safety", "motor-controller": "motor", "motor-manager": "motor", "sensor-manager": "sensor", "hardware-registry": "os",
           "hardware-discovery": "os", "service-health": "os", "command-dispatcher": "ai", "update-manager": "os", "recovery": "os"}
SEVERITIES = ("debug", "info", "warning", "error", "critical")
RAW_KEYS = {"data", "pixels", "image", "audio", "samples", "pcm", "bytes", "raw", "frame_data"}


def _clean(value, depth: int = 0):
    if depth > 3:
        return None
    if isinstance(value, dict):
        return {str(key) if str(key).lower() not in RAW_KEYS else f"{key}Omitted": (True if str(key).lower() in RAW_KEYS else _clean(item, depth + 1)) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(item, depth + 1) for item in list(value)[:32]]
    if isinstance(value, str):
        return value[:300]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return str(value)[:120]


class OSBlackBox:
    def __init__(self, directory: str, robot_id: str, *, simulated: bool, clock=time.time, enabled: bool = True, events_retention_hours: float = 720.0,
                 telemetry_retention_hours: float = 72.0, max_segment_bytes: int = 2 * 1024 * 1024, max_total_bytes: int = 256 * 1024 * 1024,
                 sample_every_s: float = 5.0, system_root: str = "/", data_dir: str | None = None, disk_warn_percent: float = 90.0, temperature_warn_c: float = 80.0):
        self.directory = os.path.abspath(directory)
        self.robot_id = robot_id
        self.simulated = bool(simulated)
        self.clock = clock
        self.enabled = enabled
        self.retention = {"events": float(events_retention_hours), "os": float(telemetry_retention_hours), "motor": float(telemetry_retention_hours)}
        self.max_segment_bytes = int(max_segment_bytes)
        self.max_total_bytes = int(max_total_bytes)
        self.sample_every_s = float(sample_every_s)
        self.system_root = system_root
        self.data_dir = data_dir or self.directory
        self.disk_warn_percent = disk_warn_percent
        self.temperature_warn_c = temperature_warn_c
        self._lock = threading.RLock()
        self._open: dict[str, SegmentWriter] = {}
        self._ids: dict[str, str] = {}
        self._index: dict[str, dict] = {}
        self._outbox: list[dict] = []
        self._seq = 0
        self._last_sample = -1e18
        self._links: dict[str, str] = {}
        self._warned: set[str] = set()
        os.makedirs(os.path.join(self.directory, "segments"), mode=0o700, exist_ok=True)
        self._rebuild_index()

    def _now(self) -> int:
        return int(self.clock() * 1000)

    def _rebuild_index(self) -> None:
        for folder, _dirs, files in os.walk(os.path.join(self.directory, "segments")):
            for name in files:
                if not is_segment(name):
                    continue
                path = os.path.join(folder, name)
                try:
                    header, records, info = read_segment(path)
                except (OSError, ValueError):
                    continue
                times = [int(item.get("t") or 0) for item in records] or [int(header.get("openedAt") or 0)]
                self._index[header["segment"]] = {"id": header["segment"], "path": path, "stream": header.get("stream"), "kind": str(header.get("stream", "")).split("-")[0],
                                                  "toMs": max(times), "bytes": os.path.getsize(path), "closed": info["closed"]}

    def _append(self, kind: str, record: dict) -> None:
        if not self.enabled:
            return
        stream = f"{kind}-{int(self.retention[kind])}h"
        writer = self._open.get(stream)
        at = int(record["t"])
        if writer is not None and writer.bytes >= self.max_segment_bytes:
            self._close(stream, at)
            writer = None
        if writer is None:
            segment = f"seg_{uuid.uuid4().hex[:16]}"
            writer = SegmentWriter(os.path.join(self.directory, "segments", stream, f"{at}-{segment}{SUFFIX}"),
                                   {"segment": segment, "robotId": self.robot_id, "stream": stream, "openedAt": at, "simulated": self.simulated, "sensitivity": "normal",
                                    "retentionHours": self.retention[kind], "source": "hannah-robot-os", "clock": {"source": "system", "synced": False}})
            self._open[stream], self._ids[stream] = writer, segment
        self._seq += 1
        writer.append({**record, "seq": self._seq})
        self._enforce_size()

    def _close(self, stream: str, at: int) -> None:
        writer = self._open.pop(stream, None)
        if writer is None:
            return
        path = writer.close(at)
        segment = self._ids.pop(stream)
        self._index[segment] = {"id": segment, "path": path, "stream": stream, "kind": stream.split("-")[0], "toMs": writer.last_t or at, "bytes": os.path.getsize(path), "closed": True}

    def _enforce_size(self) -> None:
        total = sum(item["bytes"] for item in self._index.values()) + sum(writer.bytes for writer in self._open.values())
        for item in sorted(self._index.values(), key=lambda value: (value["kind"] == "events", value["toMs"])):
            if total <= self.max_total_bytes:
                return
            total -= item["bytes"]
            self._remove(item["id"])

    def _remove(self, segment: str) -> None:
        item = self._index.pop(segment, None)
        if item:
            try:
                os.remove(item["path"])
            except OSError:
                pass

    # ---------------- what feeds it ----------------
    def event(self, source: str, type_: str, severity: str, summary: str, *, at: int | None = None, device: str | None = None, details: dict | None = None) -> dict | None:
        with self._lock:
            if not self.enabled:
                return None
            at = self._now() if at is None else int(at)
            severity = severity if severity in SEVERITIES else "info"
            event_id = f"bbe_{uuid.uuid4().hex[:20]}"
            details = _clean(details or {})
            self._append("events", {"t": at, "topic": f"events/{source}", "kind": "event", "id": event_id, "sev": severity, **({"device": device} if device else {}),
                                    "data": {"type": type_[:60], "summary": summary[:400], "details": details, "refs": []}, "clk": {"synced": False, "offMs": None, "uncMs": None}})
            item = {"id": event_id, "at": at, "source": source, "type": type_[:60], "severity": severity, "summary": summary[:400], "device": device, "details": details, "sensitivity": "normal",
                    "clock": {"synced": False, "offMs": None, "uncMs": None}}
            self._outbox.append(item)
            self._outbox = self._outbox[-2000:]
            return item

    def sink(self, evt: AuditEvent) -> None:
        """For AuditLog.sinks: every audit event becomes a black box event."""
        source = SOURCES.get(evt.source, "os")
        device = evt.data.get("controller_id") or evt.data.get("device_id") or evt.data.get("sensor_id") or evt.data.get("service")
        summary = f"{evt.source}: {evt.event.replace('_', ' ')}" + (f" ({evt.data['reason']})" if isinstance(evt.data.get("reason"), str) else "")
        self.event(source, evt.event.replace("_", "-"), evt.severity, summary, at=evt.ts_ms, device=str(device) if device else None, details={"service": evt.source, **evt.data})

    def motor_status(self, controller_id: str, status) -> None:
        """Targets against feedback, encoders and faults for one controller (a MotorStatus or a dict)."""
        with self._lock:
            data = status if isinstance(status, dict) else dict(getattr(status, "__dict__", {}))
            self._append("motor", {"t": self._now(), "topic": "motor/state", "kind": "telemetry", "device": controller_id, "data": _clean(data)})

    def sample_system(self, force: bool = False) -> dict | None:
        with self._lock:
            now = self._now()
            if not force and now - self._last_sample < self.sample_every_s * 1000:
                return None
            self._last_sample = now
            snap = system.snapshot(self.system_root, self.data_dir)
            self._append("os", {"t": now, "topic": "os/system", "kind": "telemetry", "data": snap})
            disk = snap.get("disk") or {}
            if disk.get("usedPercent") is not None:
                self._threshold("disk", disk["usedPercent"] >= self.disk_warn_percent, "disk-nearly-full", f"The disk holding {disk['path']} is {disk['usedPercent']}% full.", now)
            for zone in snap.get("temperatures") or []:
                self._threshold(f"temp:{zone['zone']}", zone["celsius"] >= self.temperature_warn_c, "temperature-high", f"{zone['type']} is at {zone['celsius']} °C.", now, device=zone["zone"])
            for link in snap.get("network") or []:
                before = self._links.get(link["interface"])
                if before is not None and before != link["state"]:
                    self.event("os", "network-link-changed", "warning" if link["state"] != "up" else "info", f"Network interface {link['interface']} is {link['state']} (was {before}).", at=now, device=link["interface"])
                self._links[link["interface"]] = link["state"]
            return snap

    def _threshold(self, key: str, over: bool, type_: str, summary: str, at: int, device: str | None = None) -> None:
        if over and key not in self._warned:
            self._warned.add(key)
            self.event("os", type_, "warning", summary, at=at, device=device)
        elif not over:
            self._warned.discard(key)

    # ---------------- housekeeping and upload ----------------
    def flush(self) -> None:
        with self._lock:
            for stream in list(self._open):
                self._close(stream, self._now())

    def sweep(self, now_ms: int | None = None) -> list[str]:
        with self._lock:
            now_ms = self._now() if now_ms is None else now_ms
            gone = [key for key, item in self._index.items() if item["closed"] and item["toMs"] + self.retention.get(item["kind"], 72.0) * 3_600_000 <= now_ms]
            for key in gone:
                self._remove(key)
            return gone

    def segments(self) -> list[dict]:
        with self._lock:
            return [dict(item) for item in sorted(self._index.values(), key=lambda value: value["toMs"])]

    def pending_events(self, limit: int = 100) -> list[dict]:
        with self._lock:
            return [dict(item) for item in self._outbox[:limit]]

    def mark_uploaded(self, ids) -> None:
        with self._lock:
            done = set(ids)
            self._outbox = [item for item in self._outbox if item["id"] not in done]

    def envelopes(self, limit: int = 50) -> list:
        """Pending events as Robot OS bridge envelopes (kind "event"), oldest first. Sign them as every envelope is signed."""
        from ..network.bridge import BridgeEnvelope

        return [BridgeEnvelope(envelope_id=f"env_{item['id']}", robot_id=self.robot_id, ts_ms=self._now(), kind="event", payload={"blackbox": item, "simulated": self.simulated})
                for item in self.pending_events(limit)]


__all__ = ["OSBlackBox", "SOURCES"]
