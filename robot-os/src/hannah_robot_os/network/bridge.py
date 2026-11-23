from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from ..common import now_ms


@dataclass
class BridgeEnvelope:
    """Signed envelope for Robot OS <-> Parent HANNAH communication.

    Signature verification is not implemented here; production uses device keys/HMAC or asymmetric signatures.
    """

    envelope_id: str
    robot_id: str
    ts_ms: int
    kind: str  # telemetry, event, command_ack, heartbeat, sync_request
    payload: dict[str, Any] = field(default_factory=dict)
    nonce: str = ""
    signature: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class OfflineQueue:
    max_items: int = 1000
    _items: list[BridgeEnvelope] = field(default_factory=list)

    def push(self, env: BridgeEnvelope) -> None:
        if len(self._items) >= self.max_items:
            # drop oldest non-critical; real policy should be configurable
            self._items.pop(0)
        self._items.append(env)

    def drain(self, limit: int = 100) -> list[BridgeEnvelope]:
        out = self._items[:limit]
        self._items = self._items[limit:]
        return out

    def size(self) -> int:
        return len(self._items)


def make_heartbeat(robot_id: str, envelope_id: str, nonce: str = "") -> BridgeEnvelope:
    return BridgeEnvelope(
        envelope_id=envelope_id,
        robot_id=robot_id,
        ts_ms=now_ms(),
        kind="heartbeat",
        payload={"status": "ok"},
        nonce=nonce,
    )
