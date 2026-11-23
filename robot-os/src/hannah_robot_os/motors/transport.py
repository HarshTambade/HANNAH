from __future__ import annotations

from dataclasses import dataclass

from .protocol import AckPacket, VelocityPacket
from .sim import SimMotorController


@dataclass
class SimMCUResponder:
    """Simulated MCU that accepts validated packets and controls a SimMotorController.

    This models a serial/CAN controller boundary for tests. Real implementations must
    enforce watchdogs/limits on the MCU side as well.
    """

    controller: SimMotorController

    def handle(self, raw: bytes) -> bytes:
        try:
            pkt = VelocityPacket.decode(raw)
            if pkt.type == "enable":
                self.controller.enable(pkt.enabled)
            elif pkt.type == "stop":
                self.controller.stop()
            elif pkt.type == "velocity":
                self.controller.send_velocity(pkt.linear_x_mps, pkt.angular_z_rps)
            elif pkt.type == "status":
                pass
            else:
                return AckPacket(type="fault", controller_id=pkt.controller_id, ok=False, reason="unknown packet type").encode()
            st = self.controller.status()
            return AckPacket(type="ack", controller_id=pkt.controller_id, ok=True, status=st.__dict__).encode()
        except Exception as e:
            cid = getattr(self.controller, "controller_id", "unknown")
            return AckPacket(type="fault", controller_id=cid, ok=False, reason=str(e)).encode()


@dataclass
class LoopbackTransport:
    responder: SimMCUResponder

    def send(self, packet: VelocityPacket) -> AckPacket:
        raw = self.responder.handle(packet.encode())
        return AckPacket.decode(raw)
