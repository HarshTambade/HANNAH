from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from ..common import now_ms
from .protocol import AckPacket, VelocityPacket


@dataclass
class FramedTransport:
    """Newline-framed request/response transport for a serial/CAN controller.

    Write and read_line are injected so tests can use an in-memory MCU loopback.
    Real adapters pass functions over a serial port or CAN frame stream.
    """

    write: Callable[[bytes], None]
    read_line: Callable[[], bytes]
    clock: Callable[[], int] = now_ms
    timeout_ms: int = 500
    retries: int = 1

    def request(self, packet: VelocityPacket) -> AckPacket:
        payload = packet.encode()
        last_reason = "no response"
        for _ in range(self.retries + 1):
            deadline = self.clock() + self.timeout_ms
            self.write(payload)
            while self.clock() <= deadline:
                raw = self.read_line()
                if not raw:
                    continue
                try:
                    ack = AckPacket.decode(raw)
                except Exception:
                    last_reason = "malformed ack"
                    continue
                if ack.controller_id != packet.controller_id:
                    last_reason = "ack for another controller"
                    continue
                return ack
            last_reason = "timeout"
        return AckPacket(type="fault", controller_id=packet.controller_id, ok=False, reason=last_reason)
