"""HANNAH's robot protocol, robot side: signing requests and checking commands.

At enrollment the robot receives a 256-bit secret, once. Two keys are derived
from it. One signs every request the robot makes (robot id, time, a counter
that only goes up, method, path, SHA-256 of the body). The other verifies the
commands the server sends: each command is a JSON text with an HMAC-SHA256 of
exactly that text, so nothing has to be re-serialised to check it.

CommandGuard decides whether a signed command may be acted on:
  - the signature matches (constant-time comparison);
  - it names this robot;
  - it has not expired, and was not issued in the future;
  - its sequence number is higher than any accepted before (kept on disk, so a
    restart doesn't reopen the window) and its nonce is new.
A command that was already accepted is recognised as a repeat delivery, not as
a new order. A cancellation or a pause only needs a valid signature for a
mission this robot knows: repeating one can only stop something. A resume
starts motion again, so it expires in seconds and its nonce works once.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import tempfile
from dataclasses import dataclass
from typing import Any

AUTH_LABEL = b"hannah-robot-auth-v1"
COMMAND_LABEL = b"hannah-robot-command-v1"
FUTURE_TOLERANCE_MS = 60_000


def _secret_bytes(secret: str) -> bytes:
    return base64.urlsafe_b64decode(secret + "=" * (-len(secret) % 4))


def derive_key(secret: str, label: bytes) -> bytes:
    return hmac.new(_secret_bytes(secret), label, hashlib.sha256).digest()


def request_message(robot_id: str, time_ms: int | str, counter: int | str, method: str, path: str, body: str) -> str:
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
    return f"{robot_id}\n{time_ms}\n{counter}\n{method.upper()}\n{path}\n{digest}"


def sign_request(secret: str, robot_id: str, time_ms: int | str, counter: int | str, method: str, path: str, body: str) -> str:
    message = request_message(robot_id, time_ms, counter, method, path, body)
    return hmac.new(derive_key(secret, AUTH_LABEL), message.encode("utf-8"), hashlib.sha256).hexdigest()


def fingerprint(secret: str) -> str:
    """A short fingerprint of this robot's secret. HANNAH shows the same one, so a person can check which device enrolled."""
    digest = hashlib.sha256(f"hannah-robot-fingerprint-v1:{secret}".encode("utf-8")).hexdigest()[:16].upper()
    return " ".join(digest[index:index + 4] for index in range(0, 16, 4))


def sign_command(secret: str, payload: str) -> str:
    return hmac.new(derive_key(secret, COMMAND_LABEL), payload.encode("utf-8"), hashlib.sha256).hexdigest()


@dataclass
class Verdict:
    ok: bool
    command: dict | None = None
    reason: str = ""
    duplicate: bool = False


class CommandGuard:
    """Accepts each genuine command once, in order, while it is still valid."""

    def __init__(self, secret: str, robot_id: str, state_path: str | None = None):
        self._secret = secret
        self._robot_id = robot_id
        self._path = state_path
        self._last_seq = 0
        self._nonces: list[str] = []
        self._missions: set[str] = set()
        if state_path and os.path.exists(state_path):
            try:
                with open(state_path, "r", encoding="utf-8") as handle:
                    saved = json.load(handle)
                self._last_seq = int(saved.get("lastSeq", 0))
                self._nonces = [str(item) for item in saved.get("nonces", [])][-200:]
                self._missions = set(str(item) for item in saved.get("missions", [])[-200:])
            except (OSError, ValueError):
                # An unreadable file must not reopen the replay window: refuse everything older than now.
                self._last_seq = 2**62

    @property
    def last_seq(self) -> int:
        return self._last_seq

    def _save(self) -> None:
        if not self._path:
            return
        folder = os.path.dirname(self._path) or "."
        handle, temporary = tempfile.mkstemp(dir=folder, prefix=".guard-")
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            json.dump({"lastSeq": self._last_seq, "nonces": self._nonces[-200:], "missions": sorted(self._missions)[-200:]}, out)
        os.replace(temporary, self._path)

    def check(self, payload: Any, signature: Any, now_ms: int) -> Verdict:
        if not isinstance(payload, str) or not isinstance(signature, str):
            return Verdict(False, reason="malformed")
        if not hmac.compare_digest(sign_command(self._secret, payload), signature):
            return Verdict(False, reason="bad-signature")
        try:
            command = json.loads(payload)
        except ValueError:
            return Verdict(False, reason="malformed")
        if not isinstance(command, dict) or command.get("v") != 1:
            return Verdict(False, reason="unsupported-version")
        if command.get("robotId") != self._robot_id:
            return Verdict(False, command, "wrong-robot")
        mission_id = command.get("missionId")
        if not isinstance(mission_id, str) or not mission_id:
            return Verdict(False, command, "malformed")
        kind = command.get("type")
        if kind in ("cancel", "pause"):
            # Both only reduce what is happening: a valid signature for a mission this robot knows is enough.
            if mission_id not in self._missions:
                return Verdict(False, command, "unknown-mission")
            return Verdict(True, command)
        if kind == "resume":
            # A resume starts motion again, so it expires and works once.
            if mission_id not in self._missions:
                return Verdict(False, command, "unknown-mission")
            nonce, expires = command.get("nonce"), command.get("expiresAt")
            if not isinstance(nonce, str) or not nonce or not isinstance(expires, (int, float)):
                return Verdict(False, command, "malformed")
            if expires <= now_ms:
                return Verdict(False, command, "expired")
            if nonce in self._nonces:
                return Verdict(True, command, duplicate=True)
            self._nonces.append(nonce)
            self._save()
            return Verdict(True, command)
        if kind != "mission":
            return Verdict(False, command, "unknown-type")
        if mission_id in self._missions:
            return Verdict(True, command, duplicate=True)
        seq, nonce = command.get("seq"), command.get("nonce")
        issued, expires = command.get("issuedAt"), command.get("expiresAt")
        if not all(isinstance(value, (int, float)) for value in (seq, issued, expires)) or not isinstance(nonce, str):
            return Verdict(False, command, "malformed")
        if expires <= now_ms:
            return Verdict(False, command, "expired")
        if issued > now_ms + FUTURE_TOLERANCE_MS:
            return Verdict(False, command, "issued-in-the-future")
        if seq <= self._last_seq or nonce in self._nonces:
            return Verdict(False, command, "replayed")
        self._last_seq = int(seq)
        self._nonces.append(nonce)
        self._missions.add(mission_id)
        self._save()
        return Verdict(True, command)
