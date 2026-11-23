from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Any


@dataclass
class VelocityPacket:
    type: str  # "velocity" | "stop" | "enable" | "status"
    controller_id: str
    linear_x_mps: float = 0.0
    angular_z_rps: float = 0.0
    enabled: bool = False

    def encode(self) -> bytes:
        return (json.dumps(asdict(self), separators=(",", ":")) + "\n").encode("utf-8")

    @staticmethod
    def decode(data: bytes) -> "VelocityPacket":
        obj = json.loads(data.decode("utf-8").strip())
        return VelocityPacket(**obj)


@dataclass
class AckPacket:
    type: str  # "ack" | "fault" | "status"
    controller_id: str
    ok: bool
    reason: str = ""
    status: dict[str, Any] | None = None

    def encode(self) -> bytes:
        return (json.dumps(asdict(self), separators=(",", ":")) + "\n").encode("utf-8")

    @staticmethod
    def decode(data: bytes) -> "AckPacket":
        obj = json.loads(data.decode("utf-8").strip())
        return AckPacket(**obj)
