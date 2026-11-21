"""A device with a small HTTP API on the local network (many Wi-Fi plugs and sensors have one). It is polled."""
from __future__ import annotations

import base64
import json
import urllib.error
import urllib.parse
import urllib.request

from ..netpolicy import PolicyError, require_local_or_tls
from .base import AdapterError, DeviceAdapter, dig, fill

MAX_BODY = 64_000


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None  # a device that redirects elsewhere is not followed


class HttpDevice(DeviceAdapter):
    NAME = "http"
    ABOUT = {
        "protocol": "HTTP", "version": "1.1, JSON bodies",
        "authentication": "HTTP Basic when the device has a user name and password",
        "encryption": "HTTPS when the device offers it. Plain HTTP only to a device on the local network",
        "reads": "GET on the paths a profile lists, one field of the JSON answer per point",
        "writes": "The one request a profile lists for a writable point; never an arbitrary URL",
        "rateLimit": "Polled no faster than once a second",
        "errors": "Unreachable, refused sign-in, an answer that isn't JSON, and HTTP errors are each named",
        "permissions": "network-local",
        "security": "Redirects are not followed; answers over 64 kB are dropped; the address can't be changed by the device",
        "diagnostics": "Reachability, the last HTTP status, time since each point was read",
        "tested": "Against a local test server. Not against any physical device",
        "notSupported": "Digest sign-in, OAuth, WebSockets, CoAP",
    }

    def __init__(self, device: dict, clock=None, client_id: str = ""):
        super().__init__(device, **({"clock": clock} if clock else {}))
        self._base = str(self.settings.get("url", "")).rstrip("/")
        self._next_poll = 0.0
        self._poll_s = max(1.0, float(device.get("pollS") or self.settings.get("pollS") or 5))
        self._opener = urllib.request.build_opener(_NoRedirect)

    def _request(self, method: str, path: str, query: dict | None = None, body=None):
        parsed = urllib.parse.urlsplit(self._base)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise AdapterError("The device's address must start with http:// or https://.", "bad-address")
        try:
            require_local_or_tls(parsed.hostname, parsed.scheme == "https", "A connection")
        except PolicyError as error:
            raise AdapterError(str(error), "insecure") from None
        url = self._base + "/" + fill(path, self.settings).lstrip("/")
        if query:
            url += "?" + urllib.parse.urlencode(query)
        headers = {"Accept": "application/json", "User-Agent": "hannah-hub"}
        if self.settings.get("username"):
            headers["Authorization"] = "Basic " + base64.b64encode(f"{self.settings['username']}:{self.settings.get('password', '')}".encode("utf-8")).decode("ascii")
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        try:
            with self._opener.open(urllib.request.Request(url, data=data, method=method, headers=headers), timeout=4.0) as response:
                raw = response.read(MAX_BODY + 1)
        except urllib.error.HTTPError as error:
            error.close()
            if error.code in (401, 403):
                raise AdapterError("The device refused the user name or password.", "auth") from None
            raise AdapterError(f"The device answered {error.code}.", "http-error") from None
        except (urllib.error.URLError, OSError) as error:
            raise AdapterError(f"Can't reach the device ({type(getattr(error, 'reason', error)).__name__}).", "unreachable") from None
        if len(raw) > MAX_BODY:
            raise AdapterError("The device's answer was too large.", "too-large")
        try:
            return json.loads(raw.decode("utf-8") or "null")
        except (ValueError, UnicodeDecodeError):
            raise AdapterError("The device's answer wasn't JSON.", "not-json") from None

    def start(self) -> None:
        self.poll()

    def _read(self, only: str | None = None) -> None:
        answers: dict = {}
        for point in self.points.values():
            state = (point.get("binding") or {}).get("state")
            if not state or (only and point["id"] != only):
                continue
            if state["path"] not in answers:
                answers[state["path"]] = self._request("GET", state["path"])
            found, raw = dig(answers[state["path"]], state.get("json", ""))
            if found:
                self._record(point["id"], raw, state)
            else:
                self.rejected += 1

    def poll(self) -> None:
        if self.clock() < self._next_poll:
            return
        self._next_poll = self.clock() + self._poll_s
        try:
            self._read()
            self._set_state("online" if self._readings else "no-data", "" if self._readings else "nothing-heard", "" if self._readings else "The device answered, but none of the expected fields were in its answer.")
        except AdapterError as error:
            self._set_state("error", error.reason, str(error))

    def has_feedback(self, point_id: str) -> bool:
        return bool((self.points.get(point_id, {}).get("binding") or {}).get("state"))

    def refresh(self, point_id: str) -> None:
        try:
            self._read(point_id)
        except AdapterError:
            pass

    def write(self, point_id: str, value) -> None:
        point, value = self.point_for_write(point_id, value)
        command = (point.get("binding") or {}).get("command")
        if not command:
            raise AdapterError(f"The profile has no command for {point.get('name') or point_id}.", "not-writable")
        sent = (command.get("on", "on") if value else command.get("off", "off")) if point["type"] == "boolean" else value
        swap = lambda item: sent if item == "{value}" else item
        query = {key: swap(item) for key, item in (command.get("query") or {}).items()} or None
        body = {key: swap(item) for key, item in command["body"].items()} if command.get("body") else None
        self._request(command.get("method", "POST"), command["path"], query, body)

    def stop(self) -> None:
        self._set_state("stopped")
