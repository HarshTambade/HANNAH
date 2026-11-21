"""Shared pieces for the hub tests: profiles from the repository, a signing stand-in for the server, patience."""
from __future__ import annotations

import json
import os
import time

from hannah_edge.protocol import COMMAND_LABEL, CONFIG_LABEL, sign

PROFILES = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "profiles")
SECRET = "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LTEyMzQ"
HUB = "hub_test0001"


def profile(name: str) -> dict:
    with open(os.path.join(PROFILES, f"org.hannah.sim.{name}.json"), encoding="utf-8") as handle:
        return json.load(handle)


def wait(check, seconds: float = 5.0, every: float = 0.05):
    end = time.time() + seconds
    while time.time() < end:
        value = check()
        if value:
            return value
        time.sleep(every)
    return check()


def device(device_id: str, kind: str, settings: dict, writable=(), name: str = "") -> dict:
    return {"id": device_id, "name": name or kind, "profile": profile(kind), "settings": settings, "writable": list(writable)}


class Server:
    """Signs what the real server would sign."""

    def __init__(self, secret: str = SECRET, hub_id: str = HUB):
        self.secret, self.hub_id, self.seq, self.version = secret, hub_id, 0, 0

    def config(self, devices: list, rules: list = (), suspended: bool = False, version: int | None = None) -> tuple:
        self.version = version if version is not None else self.version + 1
        payload = json.dumps({"v": 1, "hubId": self.hub_id, "version": self.version, "devices": devices, "rules": list(rules), "rulesSuspended": suspended})
        return payload, sign(self.secret, CONFIG_LABEL, payload)

    def command(self, command_type: str, ttl_ms: int = 20_000, seq: int | None = None, now_ms: int | None = None, **fields) -> tuple:
        self.seq = seq if seq is not None else self.seq + 1
        now = now_ms if now_ms is not None else int(time.time() * 1000)
        payload = json.dumps({"v": 1, "hubId": self.hub_id, "id": fields.pop("id", f"cmd_{self.seq}"), "type": command_type, "seq": self.seq, "issuedAt": now, "expiresAt": now + ttl_ms, **fields})
        return payload, sign(self.secret, COMMAND_LABEL, payload)
