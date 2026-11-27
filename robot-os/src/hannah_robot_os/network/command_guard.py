from __future__ import annotations

import hashlib
import hmac
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
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
    """Checks a signed command. With `state_path`, the nonces it has accepted
    survive a restart, so a command delivered again after a restart is still a
    replay and never runs twice. Nonces are kept until their command expires."""

    secret: str
    now: Any = now_ms
    state_path: Any = None
    _seen: dict[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.state_path:
            try:
                saved = json.loads(Path(self.state_path).read_text(encoding="utf-8"))
                self._seen = {str(key): int(value) for key, value in (saved.get("seen") or {}).items()}
            except (OSError, ValueError, AttributeError, TypeError):
                self._seen = {}

    def _save(self) -> None:
        if not self.state_path:
            return
        path = Path(self.state_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.tmp")
        temporary.write_text(json.dumps({"seen": self._seen}), encoding="utf-8")
        os.replace(temporary, path)

    def verify(self, command: dict[str, Any]) -> tuple[bool, str]:
        try:
            return self._verify(command)
        except (TypeError, ValueError, UnicodeError, OverflowError):
            # A field of the wrong type, or text UTF-8 can't encode: refused, never a crash.
            return False, "malformed command"

    def _verify(self, command: dict[str, Any]) -> tuple[bool, str]:
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
        for nonce, expires_at in list(self._seen.items()):
            if expires_at <= now:
                del self._seen[nonce]
        if command["nonce"] in self._seen:
            return False, "replayed command"
        self._seen[str(command["nonce"])] = expires
        self._save()
        return True, "ok"
