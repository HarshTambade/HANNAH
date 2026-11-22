"""Read-only discovery work, runnable in a short-lived helper process.

The main hub uses :func:`run_isolated` so a blocking socket, parser failure or
process crash during discovery cannot hold its tick loop or other commands.
This process uses the same OS account and permissions as the hub; it is a
fault boundary, not a privilege sandbox or an untrusted-driver runtime.
"""
from __future__ import annotations

import glob
import ipaddress
import json
import re
import socket
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

from .mqtt import MqttClient, MqttError

MAX_TOPICS = 200
MAX_SERIAL_PORTS = 40
MDNS_TYPE = re.compile(r"_[A-Za-z0-9-]{1,15}\._(?:tcp|udp)\.local", re.IGNORECASE)


class DiscoveryError(ValueError):
    def __init__(self, message: str, reason: str = "discovery-error"):
        super().__init__(message)
        self.reason = reason


def serial_ports() -> list[dict]:
    paths = sorted(set(sum((glob.glob(pattern) for pattern in ("/dev/ttyUSB*", "/dev/ttyACM*", "/dev/cu.usb*", "/dev/serial/by-id/*")), [])))
    return [{"path": path} for path in paths[:MAX_SERIAL_PORTS]]


def usb_devices(base: str = "/sys/bus/usb/devices") -> list[dict]:
    """Read USB metadata from sysfs only. Nothing is opened or written to."""
    devices = []
    root = Path(base)
    if not root.is_dir():
        return devices
    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue

        def read(name: str) -> str | None:
            try:
                return (entry / name).read_text(encoding="utf-8", errors="replace").strip()[:200] or None
            except (OSError, UnicodeError):
                return None

        devices.append({
            "path": entry.name,
            "vendorId": read("idVendor"),
            "productId": read("idProduct"),
            "manufacturer": read("manufacturer"),
            "product": read("product"),
            "serial": read("serial"),
            "version": read("version"),
        })
    return devices


def _skip_name(data: bytes, offset: int) -> int:
    while offset < len(data):
        length = data[offset]
        if length == 0:
            return offset + 1
        if (length & 0xC0) == 0xC0:
            return offset + 2
        offset += 1 + length
    return offset


def _read_name(data: bytes, offset: int) -> tuple[str, int]:
    labels = []
    jumped = False
    original_offset = offset
    visited = set()
    while offset < len(data):
        if offset in visited:
            break
        visited.add(offset)
        length = data[offset]
        if length == 0:
            offset += 1
            break
        if (length & 0xC0) == 0xC0:
            if offset + 2 > len(data):
                break
            ptr = ((length & 0x3F) << 8) | data[offset + 1]
            if not jumped:
                original_offset = offset + 2
            offset = ptr
            jumped = True
            continue
        offset += 1
        if offset + length > len(data):
            break
        labels.append(data[offset:offset + length].decode("utf-8", "replace"))
        offset += length
    return ".".join(labels), (original_offset if jumped else offset)


def parse_mdns(data: bytes, found: dict, hosts: dict | None = None, service_type: str | None = None) -> None:
    """Add matching DNS-SD PTR/SRV records and addresses to a browse result."""
    if len(data) < 12:
        return
    _id, _flags, qd, an, ns, ar = struct.unpack("!HHHHHH", data[:12])
    offset = 12
    for _ in range(qd):
        offset = _skip_name(data, offset)
        if offset + 4 > len(data):
            return
        offset += 4
    records = an + ns + ar
    hosts = hosts if hosts is not None else {}
    wanted_type = service_type.rstrip(".").lower() if service_type else None
    for _ in range(records):
        if offset >= len(data):
            return
        name, offset = _read_name(data, offset)
        if offset + 10 > len(data):
            return
        rtype, _rclass, _ttl, rdlength = struct.unpack("!HHIH", data[offset:offset + 10])
        offset += 10
        if offset + rdlength > len(data):
            return
        rdata = data[offset:offset + rdlength]
        offset += rdlength
        if rtype == 12:
            if wanted_type and name.rstrip(".").lower() != wanted_type:
                continue
            target, _ = _read_name(data, offset - rdlength)
            if target:
                service = found.setdefault(target, {"name": target})
                service["service"] = name
                service["_ptr"] = True
        elif rtype == 33 and rdlength >= 6:
            _priority, _weight, port = struct.unpack("!HHH", rdata[:6])
            target, _ = _read_name(data, offset - rdlength + 6)
            if name and target and 0 < port <= 65535:
                service = found.setdefault(name, {"name": name})
                service["port"] = port
                service["_host"] = target
        elif rtype == 1 and rdlength == 4 and name:
            hosts[name] = str(ipaddress.IPv4Address(rdata))
        elif rtype == 28 and rdlength == 16 and name:
            hosts[name] = str(ipaddress.IPv6Address(rdata))
    for service in found.values():
        address = hosts.get(service.get("_host", ""))
        if address:
            service["address"] = address


def mdns_browse(service_type: str, seconds: float) -> list[dict]:
    service_type = str(service_type or "").strip().rstrip(".")
    if not MDNS_TYPE.fullmatch(service_type):
        raise DiscoveryError("Use one local service type, for example _http._tcp.local.", "invalid-service-type")
    seconds = max(1.0, min(15.0, float(seconds)))
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        sock.settimeout(0.25)
        sock.bind(("", 0))
        try:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
        except (AttributeError, OSError):
            pass

        def encode_name(name: str) -> bytes:
            labels = [label.encode("utf-8") for label in name.strip(".").split(".")]
            if any(not label or len(label) > 63 for label in labels):
                raise ValueError("The service type has an invalid DNS label.")
            return b"".join(bytes((len(label),)) + label for label in labels) + b"\x00"

        packet = struct.pack("!HHHHHH", 0, 0, 1, 0, 0, 0) + encode_name(service_type) + struct.pack("!HH", 12, 0x8001)
        found: dict = {}
        hosts: dict = {}
        sock.sendto(packet, ("224.0.0.251", 5353))
        deadline = time.monotonic() + seconds
        retried = False
        while time.monotonic() < deadline:
            try:
                data, _addr = sock.recvfrom(9000)
            except socket.timeout:
                if not retried and time.monotonic() >= deadline - seconds / 2:
                    try:
                        sock.sendto(packet, ("224.0.0.251", 5353))
                    except OSError:
                        pass
                    retried = True
                continue
            parse_mdns(data, found, hosts, service_type)
        for service in found.values():
            address = hosts.get(service.get("_host", ""))
            if address:
                service["address"] = address
        return sorted(({key: value for key, value in service.items() if not key.startswith("_")} for service in found.values() if service.get("_ptr")), key=lambda item: item.get("name", ""))[:MAX_TOPICS]
    finally:
        sock.close()


def mqtt_topics(settings: dict, seconds: float, client_id: str) -> list[dict]:
    seconds = max(1.0, min(15.0, float(seconds)))
    seen: dict = {}

    def heard(topic: str, payload: bytes, _retained: bool) -> None:
        if len(seen) < MAX_TOPICS or topic in seen:
            entry = seen.setdefault(topic, {"topic": topic, "messages": 0})
            entry["messages"] += 1
            entry["sample"] = payload[:160].decode("utf-8", "replace")

    client = MqttClient(str(settings.get("host", "")), int(settings.get("port") or (8883 if settings.get("tls") else 1883)), client_id=client_id,
                        username=settings.get("username") or None, password=settings.get("password") or None, tls=bool(settings.get("tls")), timeout=4.0, on_message=heard)
    try:
        client.connect()
        client.subscribe(["#"])
        threading.Event().wait(seconds)
    except MqttError as error:
        raise DiscoveryError(str(error), error.reason) from None
    finally:
        client.close()
    return sorted(seen.values(), key=lambda item: item["topic"])[:MAX_TOPICS]


def discover(request: dict) -> dict:
    kind = request.get("kind")
    settings = request.get("settings") if isinstance(request.get("settings"), dict) else {}
    seconds = max(1.0, min(15.0, float(request.get("seconds") or 5)))
    if kind == "serial":
        return {"kind": "serial", "ports": serial_ports(), "note": "Listed only. Nothing was opened or written to."}
    if kind == "usb":
        return {"kind": "usb", "devices": usb_devices(), "note": "Listed only. Nothing was opened or written to."}
    if kind == "mdns":
        service = str(settings.get("service") or "_http._tcp.local").strip().rstrip(".")
        services = mdns_browse(service, seconds)
        return {"kind": "mdns", "service": service, "seconds": round(seconds, 1), "services": services, "note": "Listened only. Nothing was published."}
    if kind == "mqtt":
        topics = mqtt_topics(settings, seconds, str(request.get("clientId") or "hannah-discovery"))
        return {"kind": "mqtt", "seconds": round(seconds, 1), "topics": topics, "note": "Listened only. Nothing was published."}
    raise DiscoveryError("This hub can look at an MQTT broker's topics, list serial ports, or list USB devices.", "unknown-kind")


def run_isolated(request: dict, timeout: float = 20.0) -> dict:
    """Run one discovery request in a child process with a hard wall-clock limit."""
    try:
        completed = subprocess.run(
            [sys.executable, "-m", "hannah_edge.discovery_worker"],
            input=json.dumps(request),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise
    except OSError as error:
        raise DiscoveryError("The discovery worker couldn't start (" + type(error).__name__ + ").", "worker-start") from None
    if completed.returncode != 0:
        raise DiscoveryError("The discovery worker stopped unexpectedly.", "worker-exit")
    try:
        answer = json.loads(completed.stdout)
    except (TypeError, ValueError):
        raise DiscoveryError("The discovery worker returned an unreadable answer.", "worker-response") from None
    if not isinstance(answer, dict) or answer.get("ok") is not True or not isinstance(answer.get("result"), dict):
        error = answer.get("error") if isinstance(answer, dict) else None
        raise DiscoveryError(str((error or {}).get("message") or "Discovery failed."), str((error or {}).get("reason") or "discovery-error"))
    result = answer["result"]
    result["_workerPid"] = answer.get("pid")
    return result
