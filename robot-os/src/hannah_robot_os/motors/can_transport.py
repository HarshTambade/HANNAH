from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from ..common import now_ms
from .can_codec import FrameReassembler, encode_frames
from .protocol import AckPacket, VelocityPacket


@dataclass
class CANFramedTransport:
    """Request/response transport over CAN-style frames.

    Inject send_frame/recv_frame so tests can use a virtual bus; a real adapter
    passes SocketCAN send/recv bound to one interface.
    """

    send_frame: Callable[[bytes], None]
    recv_frame: Callable[[], bytes | None]
    channel: int = 0
    timeout_ms: int = 500
    retries: int = 1
    clock: Callable[[], int] = now_ms

    def request(self, packet: VelocityPacket) -> AckPacket:
        frames = encode_frames(packet.encode(), channel=self.channel)
        reason = "no response"
        for _ in range(self.retries + 1):
            deadline = self.clock() + self.timeout_ms
            for frame in frames:
                self.send_frame(frame)
            reassembler = FrameReassembler(channel=self.channel)
            while self.clock() <= deadline:
                frame = self.recv_frame()
                if not frame:
                    continue
                payload = reassembler.feed(frame)
                if not payload:
                    continue
                try:
                    ack = AckPacket.decode(payload)
                except Exception:
                    reason = "malformed ack"
                    continue
                if ack.controller_id != packet.controller_id:
                    reason = "ack for another controller"
                    continue
                return ack
            reason = "timeout"
        return AckPacket(type="fault", controller_id=packet.controller_id, ok=False, reason=reason)
