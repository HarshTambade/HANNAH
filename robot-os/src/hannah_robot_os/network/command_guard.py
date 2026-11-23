from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass, field
from typing import Any

from ..common import now_ms

FUTURE_TOLERANCE_MS = 60_000


def _params_json(params: Any) -> str:
    # Match JavaScript JSON.stringify (no spaces, insertion order preserved).
    return json.dumps(params if params is not None else {}, separators=(",", ":"), ensure_ascii=False)


def command_message(command: dict[str, Any]) -> str:
    digest = hashlib.sha256(_params_json(command.get("params", {})).encode("utf-8")).hexdigest()
    return "\n".join([
        str(command.get("id", "")),
        str(command.get("robotId", "")),
        str(command.get("capability", "")),
        str(command.get("issuedAt", "")),
        str(command.get("expiresAt", "")),
        str(command.get("nonce", "")),
        digest,
    ])


def sign_command(secret: str, command: dict[str, Any]) -> str:
    return hmac.new(secret.encode("utf-8"), command_message(command).encode("utf-8"), hashlib.sha256).hexdigest()


@dataclass
class CommandGuard:
    secret: str
    now: Any = now_ms
    _seen: set[str] = field(default_factory=set)

    def verify(self, command: dict[str, Any]) -> tuple[bool, str]:
        now = self.now()
        required = ["id", "robotId", "capability", "issuedAt", "expiresAt", "nonce", "signature"]
        if any(not command.get(k) for k in required):
            return False, "incomplete command"
        issued = int(command["issuedAt"])
        expires = int(command["expiresAt"])
        if issued > now + FUTURE_TOLERANCE_MS:
            return False, "command issued in future"
        if now >= expires:
            return False, "command expired"
        expected = sign_command(self.secret, command)
        signature = str(command.get("signature", ""))
        if not hmac.compare_digest(expected, signature):
            return False, "bad signature"
        if command["nonce"] in self._seen:
            return False, "replayed command"
        self._seen.add(command["nonce"])
        return True, "ok"
