"""The hub: devices, rules, and the exchange with HANNAH.

Each tick (about once a second) it lets every device adapter do its work, runs
the rules, and, when it is time, exchanges one signed request with the server:
it reports what it sees and receives a signed configuration and signed
commands. It decides nothing about what should happen to a device; it checks
that what it was asked is allowed for that device, does it, reads the result
back, and reports what it observed.

What it holds itself, whatever the server says:
  - a write goes only to a point on that device's allow-list, in range;
  - one write per point per second;
  - a command is run once, in order, before it expires;
  - a configuration or command with a wrong signature is ignored.
"""
from __future__ import annotations

import glob
import json
import os
import socket
import struct
import threading
import time

from . import PROTOCOL, __version__, adapters
from .adapters.base import AdapterError, check_value, writable
from .link import LinkError
from .mqtt import MqttClient, MqttError
from .protocol import CONFIG_LABEL, CommandGuard, verified, write_private
from .update import Updater
from .rules import RuleEngine

CONFIRM_S = 4.0
MAX_PROBE_S = 20.0
MAX_OUTBOX = 200


def same(wanted, got) -> bool:
    if isinstance(wanted, bool) or isinstance(got, bool):
        return wanted is got
    if isinstance(wanted, (int, float)) and isinstance(got, (int, float)):
        return abs(wanted - got) <= max(1e-6, abs(wanted) * 1e-4)
    return wanted == got


class Hub:
    def __init__(self, hub_id: str, secret: str, state_dir: str | None = None, link=None, clock=time.time, sync_interval: float = 2.0, log=None):
        self.hub_id, self._secret, self.state_dir, self.link, self.clock = hub_id, secret, state_dir, link, clock
        self.sync_interval = sync_interval
        self._log = log or (lambda **fields: None)
        self._guard = CommandGuard(secret, hub_id, os.path.join(state_dir, "guard.json") if state_dir else None)
        self._lock = threading.RLock()
        self._devices: dict = {}
        self._config: dict = {"version": 0, "devices": [], "rules": []}
        self._outbox: list = []
        self._updater = Updater(os.path.join(state_dir or ".", "updates"))
        self._serial = 0
        self._last_write: dict = {}
        self._confirm: list = []
        self._next_sync = 0.0
        self.link_up = None
        self.rules = RuleEngine(self._reading, self._rule_write, self._online, clock)
        self._stop = threading.Event()
        self._load_saved()

    # ---------- configuration ----------
    def _load_saved(self) -> None:
        if not self.state_dir:
            return
        path = os.path.join(self.state_dir, "config.json")
        if not os.path.exists(path):
            return
        try:
            with open(path, "r", encoding="utf-8") as handle:
                saved = json.load(handle)
        except (OSError, ValueError):
            return
        # The saved copy is checked exactly like a fresh one: a file edited by hand is not obeyed.
        if not self.apply_config(saved.get("payload"), saved.get("signature"), save=False):
            self._log(event="config-rejected", message="The saved configuration's signature is wrong. Waiting for the server.")

    def apply_config(self, payload, signature, save: bool = True) -> bool:
        if not verified(self._secret, CONFIG_LABEL, payload, signature):
            return False
        try:
            config = json.loads(payload)
        except ValueError:
            return False
        if not isinstance(config, dict) or config.get("hubId") != self.hub_id or not isinstance(config.get("version"), int):
            return False
        with self._lock:
            if config["version"] < self._config.get("version", 0):
                return False  # an older configuration is never brought back
            wanted = {device["id"]: device for device in config.get("devices", [])}
            for device_id in list(self._devices):
                current = self._devices[device_id]
                if device_id not in wanted or json.dumps(wanted[device_id], sort_keys=True) != current["fingerprint"]:
                    current["adapter"].stop()
                    del self._devices[device_id]
            for device_id, device in wanted.items():
                if device_id in self._devices:
                    continue
                entry = {"config": device, "fingerprint": json.dumps(device, sort_keys=True), "adapter": None, "error": None}
                try:
                    entry["adapter"] = adapters.create(device, client_id=f"hannah-{self.hub_id[-6:]}-{device_id[-6:]}", clock=self.clock)
                    entry["adapter"].start()
                except AdapterError as error:
                    entry["error"] = {"state": "error", "reason": error.reason, "message": str(error), "since": self.clock()}
                    entry["adapter"] = None
                self._devices[device_id] = entry
            self._config = config
            self.rules.load(config.get("rules", []), config.get("rulesSuspended", False))
        if save and self.state_dir:
            write_private(os.path.join(self.state_dir, "config.json"), json.dumps({"payload": payload, "signature": signature}))
        self._log(event="config-applied", version=config["version"], devices=len(wanted), rules=len(config.get("rules", [])))
        return True

    # ---------- reading ----------
    def _reading(self, device_id: str, point_id: str):
        entry = self._devices.get(device_id)
        return entry["adapter"].reading(point_id) if entry and entry["adapter"] else None

    def _online(self, device_id: str) -> bool:
        entry = self._devices.get(device_id)
        return bool(entry and entry["adapter"] and entry["adapter"].connection()["state"] == "online")

    # ---------- writing ----------
    def _write(self, device_id: str, point_id: str, value) -> None:
        """Every write passes here, whoever asked. Raises AdapterError with the reason when it is refused."""
        entry = self._devices.get(device_id)
        if not entry:
            raise AdapterError("This hub doesn't have that device.", "unknown-device")
        if not entry["adapter"]:
            raise AdapterError(entry["error"]["message"], entry["error"]["reason"])
        if point_id not in (entry["config"].get("writable") or []):
            raise AdapterError("Writing to this point hasn't been allowed for this device.", "not-allowed")
        key = (device_id, point_id)
        if self.clock() - self._last_write.get(key, -10) < 1.0:
            raise AdapterError("That point was written less than a second ago.", "too-fast")
        entry["adapter"].write(point_id, value)
        self._last_write[key] = self.clock()

    def _rule_write(self, device_id: str, point_id: str, value) -> tuple:
        entry = self._devices.get(device_id)
        name = entry["config"].get("name", device_id) if entry else device_id
        try:
            self._write(device_id, point_id, value)
        except AdapterError as error:
            return False, f"{name}: {error}"
        if entry["adapter"].has_feedback(point_id):
            self._confirm.append({"device": device_id, "point": point_id, "value": value, "by": self.clock() + CONFIRM_S, "name": name})
        shown = ("on" if value else "off") if isinstance(value, bool) else value
        return True, f"{name} {entry['adapter'].points[point_id].get('name', point_id)} set to {shown}."

    def _confirmed(self, device_id: str, point_id: str, value, started_ms: int, seconds: float = CONFIRM_S) -> dict:
        adapter = self._devices[device_id]["adapter"]
        if not adapter.has_feedback(point_id):
            return {"confirmed": None, "note": "This point reports nothing back, so the write can't be confirmed."}
        end = time.monotonic() + seconds
        reading = None
        while time.monotonic() < end and not self._stop.is_set():
            adapter.refresh(point_id)
            reading = adapter.reading(point_id)
            if reading and reading["at"] >= started_ms and same(value, reading["value"]):
                return {"confirmed": True, "value": reading["value"], "at": reading["at"]}
            time.sleep(0.15)
        return {"confirmed": False, "value": reading["value"] if reading else None, "at": reading["at"] if reading else None}

    # ---------- commands ----------
    def _queue(self, kind: str, body: dict) -> None:
        with self._lock:
            self._serial += 1
            self._outbox.append({"key": f"{int(self.clock() * 1000)}-{self._serial}", "kind": kind, **body})
            del self._outbox[:-MAX_OUTBOX]

    def _result(self, command: dict, status: str, **extra) -> None:
        self._queue("result", {"commandId": command["id"], "status": status, **extra})
        self._log(event="command", id=command["id"], type=command["type"], status=status, reason=extra.get("reason", ""))

    def handle(self, payload, signature) -> None:
        verdict = self._guard.check(payload, signature, int(self.clock() * 1000))
        if not verdict.ok:
            if verdict.command and isinstance(verdict.command.get("id"), str):
                self._result(verdict.command, "refused", reason=verdict.reason, message="The hub's own checks refused the command.")
            self._log(event="command-refused", reason=verdict.reason)
            return
        if verdict.duplicate:
            return
        command = verdict.command
        runner = {"write": self._run_write, "probe": self._run_probe, "discover": self._run_discover, "update": self._run_update}[command["type"]]
        threading.Thread(target=self._guarded, args=(runner, command), name=f"command-{command['id'][-6:]}", daemon=True).start()

    def _guarded(self, runner, command: dict) -> None:
        try:
            runner(command)
        except Exception as error:  # a command must always get an answer
            self._result(command, "failed", reason="hub-error", message=f"The hub hit an error ({type(error).__name__}).")

    def _run_write(self, command: dict) -> None:
        started = int(self.clock() * 1000)
        try:
            self._write(str(command.get("deviceId")), str(command.get("point")), command.get("value"))
        except AdapterError as error:
            refused = error.reason in ("unknown-device", "unknown-point", "not-allowed", "not-writable", "bad-value", "out-of-range", "bad-step", "no-range", "too-fast", "no-adapter")
            self._result(command, "refused" if refused else "failed", reason=error.reason, message=str(error))
            return
        readback = self._confirmed(command["deviceId"], command["point"], command.get("value"), started)
        self._result(command, "done" if readback["confirmed"] else "unverified", readback=readback, wroteAt=started)

    def _run_probe(self, command: dict) -> None:
        device = command.get("device") or {}
        seconds = max(1.0, min(MAX_PROBE_S, float(command.get("seconds") or 8)))
        try:
            adapter = adapters.create(device, client_id=f"hannah-{self.hub_id[-6:]}-probe", clock=self.clock)
        except AdapterError as error:
            self._result(command, "failed", reason=error.reason, message=str(error))
            return
        try:
            adapter.start()
            end = time.monotonic() + seconds
            wanted = [point_id for point_id in adapter.points if adapter.has_feedback(point_id)]
            while time.monotonic() < end and not self._stop.is_set():
                adapter.poll()
                if adapter.connection()["state"] == "online" and all(adapter.reading(point_id) for point_id in wanted):
                    break
                time.sleep(0.2)
            connection, readings = adapter.connection(), adapter.readings()
        finally:
            adapter.stop()
        self._result(command, "done", probe={
            "adapter": adapter.NAME, "connection": connection, "seconds": round(seconds, 1), "rejected": adapter.rejected,
            "points": {point_id: {"heard": point_id in readings, **(readings.get(point_id) or {}), "expected": adapter.has_feedback(point_id)} for point_id in adapter.points},
        })

    def _run_discover(self, command: dict) -> None:
        kind = command.get("kind")
        if kind == "serial":
            ports = sorted(set(sum((glob.glob(pattern) for pattern in ("/dev/ttyUSB*", "/dev/ttyACM*", "/dev/cu.usb*", "/dev/serial/by-id/*")), [])))[:40]
            self._result(command, "done", discovered={"kind": "serial", "ports": [{"path": port} for port in ports], "note": "Listed only. Nothing was opened or written to."})
            return
        if kind == "mdns":
            service_type = str((command.get("settings") or {}).get("service") or "_http._tcp.local")
            seconds = max(1.0, min(15.0, float((command.get("settings") or {}).get("seconds") or 5)))
            try:
                found = self._mdns_browse(service_type, seconds)
            except Exception as error:
                self._result(command, "failed", reason="mdns-error", message=str(error))
                return
            self._result(command, "done", discovered={"kind": "mdns", "service": service_type, "seconds": seconds, "services": found, "note": "Listened only. Nothing was published."})
            return
        if kind != "mqtt":
            self._result(command, "refused", reason="unknown-kind", message="This hub can look at an MQTT broker's topics or list serial ports.")
        settings = command.get("settings") or {}
        seconds = max(1.0, min(15.0, float(command.get("seconds") or 5)))
        seen: dict = {}

        def heard(topic: str, payload: bytes, _retained: bool) -> None:
            if len(seen) < 200 or topic in seen:
                entry = seen.setdefault(topic, {"topic": topic, "messages": 0})
                entry["messages"] += 1
                entry["sample"] = payload[:160].decode("utf-8", "replace")

        client = MqttClient(str(settings.get("host", "")), int(settings.get("port") or (8883 if settings.get("tls") else 1883)), client_id=f"hannah-{self.hub_id[-6:]}-look",
                            username=settings.get("username") or None, password=settings.get("password") or None, tls=bool(settings.get("tls")), timeout=4.0, on_message=heard)
        try:
            client.connect()
            client.subscribe(["#"])
            self._stop.wait(seconds)
        except MqttError as error:
            self._result(command, "failed", reason=error.reason, message=str(error))
            return
        finally:
            client.close()
        self._result(command, "done", discovered={"kind": "mqtt", "seconds": seconds, "topics": sorted(seen.values(), key=lambda item: item["topic"])[:200], "note": "Listened only. Nothing was published."})

    # ---------- the loop ----------
    def _mdns_browse(self, service_type: str, seconds: float) -> list:
        """A named, person-authorised look for one service type. Best effort; parses PTR/SRV/A records."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except (AttributeError, OSError):
            pass
        sock.bind(("", 5353))
        sock.settimeout(0.5)
        group = "224.0.0.251"
        # Build a DNS query for service_type PTR.
        def encode_name(name: str) -> bytes:
            out = b""
            for label in name.strip(".").split("."):
                raw = label.encode("utf-8")
                out += bytes([len(raw)]) + raw
            return out + b"\x00"

        transaction = 0x1234
        header = struct.pack("!HHHHHH", transaction, 0x0000, 1, 0, 0, 0)
        question = encode_name(service_type) + struct.pack("!HH", 12, 0x0001)  # PTR, IN
        packet = header + question
        sock.sendto(packet, (group, 5353))
        found: dict = {}
        deadline = time.time() + seconds
        while time.time() < deadline:
            try:
                data, _addr = sock.recvfrom(4096)
            except socket.timeout:
                # re-send query once midway
                try:
                    sock.sendto(packet, (group, 5353))
                except OSError:
                    pass
                continue
            self._parse_mdns(data, found)
        sock.close()
        return sorted(found.values(), key=lambda item: item.get("name", ""))[:200]

    @staticmethod
    def _parse_mdns(data: bytes, found: dict) -> None:
        if len(data) < 12:
            return
        _id, flags, qd, an, ns, ar = struct.unpack("!HHHHHH", data[:12])
        offset = 12
        # skip questions
        for _ in range(qd):
            offset = Hub._skip_name(data, offset)
            offset += 4
        records = an + ns + ar
        instances: list = []
        for _ in range(records):
            name, offset = Hub._read_name(data, offset)
            if offset + 10 > len(data):
                return
            rtype, rclass, ttl, rdlength = struct.unpack("!HHIH", data[offset:offset+10])
            offset += 10
            rdata = data[offset:offset+rdlength]
            offset += rdlength
            if rtype == 12:  # PTR
                target, _ = Hub._read_name(data, offset - rdlength)
                # target is the instance name; resolve later by name
                found.setdefault(target, {"name": target, "type": "ptr"})
            elif rtype == 33:  # SRV
                if rdlength >= 6:
                    priority, weight, port = struct.unpack("!HHH", rdata[:6])
                    target, _ = Hub._read_name(data, offset - rdlength + 6)
                    # find matching instance by target host? store port under target host
                    found.setdefault(target, {"name": target, "port": port})
            elif rtype == 1:  # A
                if rdlength == 4:
                    addr = ".".join(str(b) for b in rdata)
                    # associate with the name we read
                    found.setdefault(name, {"name": name, "address": addr})
                    found[name]["address"] = addr
        # merge: if an instance name has a port/address, keep it; also keep ptr targets
        # Flatten: move ptr-target entries that look like instances
        for key, value in list(found.items()):
            if "port" not in value and "address" not in value and key.count(".") >= 2:
                found[key] = {"name": key}

    @staticmethod
    def _skip_name(data: bytes, offset: int) -> int:
        while offset < len(data):
            length = data[offset]
            if length == 0:
                return offset + 1
            if (length & 0xC0) == 0xC0:
                return offset + 2
            offset += 1 + length
        return offset

    @staticmethod
    def _read_name(data: bytes, offset: int):
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
            labels.append(data[offset:offset+length].decode("utf-8", "replace"))
            offset += length
        name = ".".join(labels)
        return name, (original_offset if jumped else offset)

    def _run_update(self, command: dict) -> None:
        announced = {"version": command.get("version"), "size": command.get("size"), "sha256": command.get("sha256")}
        url = command.get("url")
        if not url:
            self._result(command, "failed", reason="no-url", message="The update didn't say where to get it.")
            return
        try:
            import urllib.request
            with urllib.request.urlopen(str(url), timeout=120) as response:
                bundle = response.read()
            version = self._updater.stage(bundle, announced)
            self._updater.activate(version)
            self._updater.on_start()
            self._result(command, "done", update=self._updater.status())
        except Exception as error:
            self._result(command, "failed", reason="update-error", message=str(error))

    def tick(self) -> None:
        with self._lock:
            entries = list(self._devices.items())
        for _device_id, entry in entries:
            if entry["adapter"]:
                try:
                    entry["adapter"].poll()
                except Exception as error:  # one device's fault must not stop the others
                    self._log(event="adapter-error", device=entry["config"].get("id"), error=type(error).__name__)
        for event in self.rules.tick():
            self._queue("event", event)
            self._log(event=event["type"], rule=event.get("ruleId"), message=event["message"])
        now = self.clock()
        for pending in [item for item in self._confirm if now >= item["by"]]:
            self._confirm.remove(pending)
            reading = self._reading(pending["device"], pending["point"])
            if not reading or not same(pending["value"], reading["value"]):
                self._queue("event", {"type": "write-unconfirmed", "severity": "warning", "deviceId": pending["device"], "message": f"A rule wrote to {pending['name']}, and the device has not reported the new value."})
        if self.link and now >= self._next_sync:
            self._next_sync = now + self.sync_interval
            self.exchange()

    def report(self) -> dict:
        with self._lock:
            devices = []
            for device_id, entry in self._devices.items():
                adapter = entry["adapter"]
                devices.append({"id": device_id, "connection": adapter.connection() if adapter else entry["error"], "points": adapter.readings() if adapter else {}, "rejected": adapter.rejected if adapter else 0})
            return {
                "at": int(self.clock() * 1000), "protocol": PROTOCOL, "software": __version__, "configVersion": self._config.get("version", 0),
                "devices": devices, "rules": self.rules.report(), "outbox": list(self._outbox[:40]), "update": self._updater.status(),
            }

    def exchange(self) -> bool:
        try:
            answer = self.link.sync(self.report())
        except LinkError as error:
            if self.link_up is not False:
                self._log(event="link-lost", message=str(error), status=error.status)
            self.link_up = False
            if error.status in (401, 403) and error.reason in ("revoked", "unknown-hub"):
                self._log(event="revoked", message="This hub is no longer enrolled. Its rules keep running; it accepts no commands.")
            return False
        if self.link_up is False:
            self._log(event="link-restored")
        self.link_up = True
        received = set(answer.get("received") or [])
        with self._lock:
            self._outbox = [item for item in self._outbox if item["key"] not in received]
        config = answer.get("config")
        if isinstance(config, dict) and not self.apply_config(config.get("payload"), config.get("signature")):
            self._log(event="config-rejected", message="The server sent a configuration this hub can't accept (wrong signature, hub or version).")
        for item in answer.get("commands") or []:
            if isinstance(item, dict):
                self.handle(item.get("payload"), item.get("signature"))
        return True

    def run(self, tick_s: float = 0.5) -> None:
        while not self._stop.is_set():
            self.tick()
            self._stop.wait(tick_s)
        self.close()

    def stop(self) -> None:
        self._stop.set()

    def close(self) -> None:
        self._stop.set()
        with self._lock:
            for entry in self._devices.values():
                if entry["adapter"]:
                    entry["adapter"].stop()


def describe() -> dict:
    """What a hub says about itself when it enrolls."""
    import platform
    return {"protocol": PROTOCOL, "software": __version__, "python": platform.python_version(), "system": platform.system(), "machine": platform.machine(), "adapters": adapters.about()}


__all__ = ["Hub", "check_value", "describe", "same", "writable"]
