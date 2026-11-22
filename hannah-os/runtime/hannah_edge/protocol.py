"""The hub's side of its protocol with HANNAH: signing requests, checking what the server sends.

At enrollment the hub receives a 256-bit secret, once. Three keys are derived
from it: one signs every request the hub makes; one verifies commands; one
verifies the configuration (which devices, which points may be written, which
rules). A command is acted on only when its signature matches, it names this
hub, it has not expired, and its sequence number is higher than any before
(kept on disk, so a restart doesn't reopen the window).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import tempfile
from dataclasses import dataclass

AUTH_LABEL = b"hannah-hub-auth-v1"
COMMAND_LABEL = b"hannah-hub-command-v1"
CONFIG_LABEL = b"hannah-hub-config-v1"
FUTURE_TOLERANCE_MS = 60_000
COMMAND_TYPES = ("write", "probe", "discover", "update")


def _key(secret: str, label: bytes) -> bytes:
    raw = base64.urlsafe_b64decode(secret + "=" * (-len(secret) % 4))
    return hmac.new(raw, label, hashlib.sha256).digest()


def sign_request(secret: str, hub_id: str, time_ms, counter, method: str, path: str, body: str) -> str:
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
    message = f"{hub_id}\n{time_ms}\n{counter}\n{method.upper()}\n{path}\n{digest}"
    return hmac.new(_key(secret, AUTH_LABEL), message.encode("utf-8"), hashlib.sha256).hexdigest()


def sign(secret: str, label: bytes, payload: str) -> str:
    return hmac.new(_key(secret, label), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def verified(secret: str, label: bytes, payload, signature) -> bool:
    return isinstance(payload, str) and isinstance(signature, str) and hmac.compare_digest(sign(secret, label, payload), signature)


def fingerprint(secret: str) -> str:
    digest = hashlib.sha256(f"hannah-hub-fingerprint-v1:{secret}".encode("utf-8")).hexdigest()[:16].upper()
    return " ".join(digest[index:index + 4] for index in range(0, 16, 4))


def write_private(path: str, text: str) -> None:
    """Write a file only this user can read, replacing it in one step."""
    folder = os.path.dirname(path) or "."
    handle, temporary = tempfile.mkstemp(dir=folder, prefix=".tmp-")
    with os.fdopen(handle, "w", encoding="utf-8") as out:
        out.write(text)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


@dataclass
class Verdict:
    ok: bool
    command: dict | None = None
    reason: str = ""
    duplicate: bool = False


class CommandGuard:
    def __init__(self, secret: str, hub_id: str, state_path: str | None = None):
        self._secret, self._hub_id, self._path = secret, hub_id, state_path
        self._last_seq = 0
        self._seen: list = []
        if state_path and os.path.exists(state_path):
            try:
                with open(state_path, "r", encoding="utf-8") as handle:
                    saved = json.load(handle)
                self._last_seq = int(saved.get("lastSeq", 0))
                self._seen = [str(item) for item in saved.get("seen", [])][-300:]
            except (OSError, ValueError):
                self._last_seq = 2**62  # an unreadable file must not reopen the replay window

    def check(self, payload, signature, now_ms: int) -> Verdict:
        if not verified(self._secret, COMMAND_LABEL, payload, signature):
            return Verdict(False, reason="bad-signature")
        try:
            command = json.loads(payload)
        except ValueError:
            return Verdict(False, reason="malformed")
        if not isinstance(command, dict) or command.get("v") != 1:
            return Verdict(False, reason="unsupported-version")
        if command.get("hubId") != self._hub_id:
            return Verdict(False, command, "wrong-hub")
        if command.get("type") not in COMMAND_TYPES or not isinstance(command.get("id"), str) or not command["id"]:
            return Verdict(False, command, "malformed")
        if command["id"] in self._seen:
            return Verdict(True, command, duplicate=True)
        seq, issued, expires = command.get("seq"), command.get("issuedAt"), command.get("expiresAt")
        if not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in (seq, issued, expires)):
            return Verdict(False, command, "malformed")
        if expires <= now_ms:
            return Verdict(False, command, "expired")
        if issued > now_ms + FUTURE_TOLERANCE_MS:
            return Verdict(False, command, "issued-in-the-future")
        if seq <= self._last_seq:
            return Verdict(False, command, "replayed")
        self._last_seq = int(seq)
        self._seen.append(command["id"])
        if self._path:
            write_private(self._path, json.dumps({"lastSeq": self._last_seq, "seen": self._seen[-300:]}))
        return Verdict(True, command)
