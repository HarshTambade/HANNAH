"""The robot's link to HANNAH: HTTPS requests the robot opens, each one signed.

The robot never listens for connections. It needs outbound HTTPS only, which
works behind NAT and leaves no port open on the robot. Without TLS the address
must be this computer (loopback): a plain-HTTP link across a network is refused
unless it is explicitly allowed for a closed development network.
"""
from __future__ import annotations

import ipaddress
import json
import time
import urllib.error
import urllib.parse
import urllib.request

from . import PROTOCOL, __version__
from .protocol import sign_request

SYNC_PATH = "/api/robots/device/sync"
ENROLL_PATH = "/api/robots/enroll"


class LinkError(Exception):
    def __init__(self, message: str, status: int = 0, reason: str = ""):
        super().__init__(message)
        self.status = status
        self.reason = reason


def check_server_url(url: str, allow_insecure: bool = False) -> str:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise LinkError("The server address must start with https://")
    if parsed.scheme == "http":
        host = parsed.hostname
        try:
            loopback = host == "localhost" or ipaddress.ip_address(host).is_loopback
        except ValueError:
            loopback = False
        if not loopback and not allow_insecure:
            raise LinkError("Refusing an unencrypted link to another computer. Use https://, or --allow-insecure on a closed development network.")
    return url.rstrip("/")


def _post(url: str, body: str, headers: dict, timeout: float) -> dict:
    request = urllib.request.Request(url, data=body.encode("utf-8"), method="POST", headers={"Content-Type": "application/json", "User-Agent": f"hannah-robot/{__version__} ({PROTOCOL})", **headers})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read().decode("utf-8") or "{}")
        except ValueError:
            detail = {}
        raise LinkError(detail.get("error") or f"The server answered {error.code}.", error.code, detail.get("reason", "")) from None
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise LinkError(f"The server can't be reached ({type(error).__name__}).") from None


def enroll(server: str, code: str, descriptor: dict, timeout: float = 10.0) -> dict:
    return _post(server + ENROLL_PATH, json.dumps({"code": code, "descriptor": descriptor}), {}, timeout)


class Link:
    def __init__(self, server: str, robot_id: str, secret: str, timeout: float = 4.0):
        self.server = server
        self.robot_id = robot_id
        self._secret = secret
        self.timeout = timeout
        # Starts from the clock so it stays ahead of every counter used before a restart.
        self._counter = int(time.time() * 1000)

    def sync(self, body: dict) -> dict:
        text = json.dumps(body, separators=(",", ":"))
        self._counter = max(self._counter + 1, int(time.time() * 1000))
        now = int(time.time() * 1000)
        headers = {
            "X-Hannah-Robot": self.robot_id,
            "X-Hannah-Time": str(now),
            "X-Hannah-Counter": str(self._counter),
            "X-Hannah-Signature": sign_request(self._secret, self.robot_id, now, self._counter, "POST", SYNC_PATH, text),
        }
        return _post(self.server + SYNC_PATH, text, headers, self.timeout)
