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

import ipaddress
import json
import os
import subprocess
import threading
import time

from . import PROTOCOL, __version__, adapters
from .adapters.base import AdapterError, check_value, writable
from . import discovery
from .link import LinkError
from .protocol import CONFIG_LABEL, CommandGuard, verified, write_private
from .update import MAX_BUNDLE, Updater
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
    def __init__(self, hub_id: str, secret: str, state_dir: str | None = None, link=None, clock=time.time, sync_interval: float = 2.0, log=None, isolate_adapters: bool = True):
        self.hub_id, self._secret, self.state_dir, self.link, self.clock = hub_id, secret, state_dir, link, clock
        self.sync_interval = sync_interval
        # Fake clocks are used by deterministic unit tests and cannot be safely
        # shared across process boundaries. Production uses one child per device.
        self._isolate_adapters = bool(isolate_adapters and clock is time.time)
        self._log = log or (lambda **fields: None)
        self._guard = CommandGuard(secret, hub_id, os.path.join(state_dir, "guard.json") if state_dir else None)
        self._lock = threading.RLock()
        self._devices: dict = {}
        self._config: dict = {"version": 0, "devices": [], "rules": []}
        self._outbox: list = []
        self._serial = 0
        self._last_write: dict = {}
        self._key_rotation_versions: dict = {}
        self._confirm: list = []
        self._next_sync = 0.0
        self._restart_after_update: str | None = None
        self._restart_requested = False
        self.link_up = None
        self.rules = RuleEngine(self._reading, self._rule_write, self._online, clock)
        self._stop = threading.Event()
        self._updater = Updater(os.path.join(state_dir or ".", "updates"))
        if state_dir:
            self._updater.initialize(__version__, os.path.dirname(__file__))
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
                    entry["adapter"] = adapters.create(device, client_id=f"hannah-{self.hub_id[-6:]}-{device_id[-6:]}", clock=None if self._isolate_adapters else self.clock, isolated=self._isolate_adapters)
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
            adapter = adapters.create(
                device,
                client_id=f"hannah-{self.hub_id[-6:]}-probe",
                clock=None if self._isolate_adapters else self.clock,
                isolated=self._isolate_adapters,
            )
        except AdapterError as error:
            self._result(command, "failed", reason=error.reason, message=str(error))
            return
        try:
            adapter.start()
            end = time.monotonic() + seconds
            feedback = {point_id: adapter.has_feedback(point_id) for point_id in adapter.points}
            wanted = [point_id for point_id, has_feedback in feedback.items() if has_feedback]
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
            "points": {point_id: {"heard": point_id in readings, **(readings.get(point_id) or {}), "expected": feedback[point_id]} for point_id in adapter.points},
        })

    def _run_discover(self, command: dict) -> None:
        kind = str(command.get("kind") or "")
        if kind not in ("serial", "usb", "mdns", "mqtt"):
            self._result(command, "refused", reason="unknown-kind", message="This hub can look at an MQTT broker's topics, browse one local mDNS service type, list serial ports, or list USB devices.")
            return
        settings = command.get("settings") if isinstance(command.get("settings"), dict) else {}
        try:
            seconds = max(1.0, min(15.0, float(command.get("seconds") or settings.get("seconds") or 5)))
        except (TypeError, ValueError):
            self._result(command, "refused", reason="bad-request", message="Discovery duration must be a number between 1 and 15 seconds.")
            return
        request = {"kind": kind, "settings": settings, "seconds": seconds, "clientId": f"hannah-{self.hub_id[-6:]}-look-{str(command.get('id') or '')[-6:]}"}
        timeout = min(25.0, seconds + 10) if kind in ("mdns", "mqtt") else 5.0
        try:
            discovered = discovery.run_isolated(request, timeout=timeout)
        except subprocess.TimeoutExpired:
            self._result(command, "failed", reason="worker-timeout", message="The discovery worker reached its time limit and was stopped.")
            return
        except discovery.DiscoveryError as error:
            status = "refused" if error.reason in ("unknown-kind", "invalid-service-type") else "failed"
            self._result(command, status, reason=error.reason, message=str(error))
            return
        discovered.pop("_workerPid", None)
        self._result(command, "done", discovered=discovered)

    # ---------- the loop ----------
    def _mdns_browse(self, service_type: str, seconds: float) -> list:
        return discovery.mdns_browse(service_type, seconds)

    @staticmethod
    def _parse_mdns(data: bytes, found: dict, hosts: dict | None = None, service_type: str | None = None) -> None:
        discovery.parse_mdns(data, found, hosts, service_type)

    @staticmethod
    def _usb_devices(base: str = "/sys/bus/usb/devices") -> list:
        return discovery.usb_devices(base)

    @staticmethod
    def _skip_name(data: bytes, offset: int) -> int:
        return discovery._skip_name(data, offset)

    @staticmethod
    def _read_name(data: bytes, offset: int):
        return discovery._read_name(data, offset)

    def _run_update(self, command: dict) -> None:
        if command.get("rollback") is True:
            try:
                state = self._updater.rollback("HANNAH received a signed fleet rollback command.")
                self._restart_after_update = command["id"]
                self._result(command, "done", update=state)
            except Exception as error:
                self._result(command, "failed", reason="rollback-error", message=str(error), update=self._updater.status())
            return
        announced = {"version": command.get("version"), "size": command.get("size"), "sha256": command.get("sha256")}
        url = str(command.get("url") or "")
        if not url:
            self._result(command, "failed", reason="no-url", message="The update didn't say where to get it.")
            return
        try:
            import urllib.error
            import urllib.parse
            import urllib.request
            parsed = urllib.parse.urlsplit(url)
            if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError("The update address must be HTTPS (or HTTP on this computer for development).")
            if parsed.scheme == "http":
                try:
                    loopback = parsed.hostname == "localhost" or ipaddress.ip_address(parsed.hostname).is_loopback
                except ValueError:
                    loopback = False
                if not loopback:
                    raise ValueError("Refusing to fetch an update over unencrypted HTTP from another computer.")

            class Redirects(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, request, file, code, message, headers, new_url):
                    old = urllib.parse.urlsplit(request.full_url)
                    new = urllib.parse.urlsplit(new_url)
                    if new.username or new.password or (old.scheme == "https" and new.scheme != "https"):
                        raise urllib.error.URLError("The update redirect isn't secure.")
                    if old.scheme == "http" and (new.scheme != "http" or new.hostname != old.hostname or new.port != old.port):
                        raise urllib.error.URLError("A development update can't redirect to another address.")
                    return super().redirect_request(request, file, code, message, headers, new_url)

            opener = urllib.request.build_opener(Redirects())
            with opener.open(url, timeout=120) as response:
                length = response.headers.get("Content-Length")
                if length and int(length) > MAX_BUNDLE:
                    raise ValueError("The update is larger than the 20 MiB limit.")
                bundle = response.read(MAX_BUNDLE + 1)
            if len(bundle) > MAX_BUNDLE:
                raise ValueError("The update is larger than the 20 MiB limit.")
            version = self._updater.stage(bundle, announced)
            self._updater.activate(version)
            self._restart_after_update = command["id"]
            self._result(command, "done", update=self._updater.status())
        except Exception as error:
            self._result(command, "failed", reason="update-error", message=str(error), update=self._updater.status())

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
        update = self._updater.status()
        if update.get("current") == __version__ and update.get("pending"):
            self._updater.confirm()
        received = set(answer.get("received") or [])
        with self._lock:
            restart_acknowledged = bool(self._restart_after_update and any(
                item.get("kind") == "result"
                and item.get("commandId") == self._restart_after_update
                and item.get("key") in received
                for item in self._outbox
            ))
            self._outbox = [item for item in self._outbox if item["key"] not in received]
        config = answer.get("config")
        if isinstance(config, dict) and not self.apply_config(config.get("payload"), config.get("signature")):
            self._log(event="config-rejected", message="The server sent a configuration this hub can't accept (wrong signature, hub or version).")
        for item in answer.get("commands") or []:
            if isinstance(item, dict):
                self.handle(item.get("payload"), item.get("signature"))
        if restart_acknowledged:
            self._restart_requested = True
            self._stop.set()
        return True

    def run(self, tick_s: float = 0.5) -> None:
        while not self._stop.is_set():
            self.tick()
            self._stop.wait(tick_s)
        self.close()

    def stop(self) -> None:
        self._stop.set()

    @property
    def restart_requested(self) -> bool:
        return self._restart_requested

    @property
    def update_version(self) -> str | None:
        return self._updater.status().get("current")

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
