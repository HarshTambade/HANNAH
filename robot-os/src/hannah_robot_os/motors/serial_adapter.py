from __future__ import annotations

from dataclasses import dataclass

from .base import ControllerStatus
from .framed import FramedTransport
from .protocol import VelocityPacket


@dataclass
class SerialControllerAdapter:
    """Motor controller adapter over a framed serial/CAN transport."""

    controller_id: str
    transport: FramedTransport
    _connected: bool = False
    _enabled: bool = False

    def connect(self) -> None:
        self._connected = True

    def disconnect(self) -> None:
        self._connected = False
        self._enabled = False

    def status(self) -> ControllerStatus:
        ack = self.transport.request(VelocityPacket(type="status", controller_id=self.controller_id))
        data = ack.status or {}
        return ControllerStatus(
            controller_id=self.controller_id,
            connected=self._connected and bool(data.get("connected", True)),
            enabled=bool(data.get("enabled", self._enabled)),
            fault=data.get("fault") if not ack.ok else None,
            estop_active=bool(data.get("estop_active", False)),
            watchdog_ok=bool(data.get("watchdog_ok", True)),
            encoder_left=data.get("encoder_left"),
            encoder_right=data.get("encoder_right"),
            velocity_left_mps=data.get("velocity_left_mps"),
            velocity_right_mps=data.get("velocity_right_mps"),
            last_feedback_ms=data.get("last_feedback_ms"),
            details={"transport_reason": ack.reason} if ack.reason else {},
        )

    def enable(self, enabled: bool) -> None:
        ack = self.transport.request(VelocityPacket(type="enable", controller_id=self.controller_id, enabled=enabled))
        if not ack.ok:
            raise RuntimeError(f"enable failed: {ack.reason}")
        self._enabled = enabled

    def send_velocity(self, linear_x_mps: float, angular_z_rps: float) -> None:
        ack = self.transport.request(VelocityPacket(type="velocity", controller_id=self.controller_id, linear_x_mps=linear_x_mps, angular_z_rps=angular_z_rps))
        if not ack.ok:
            raise RuntimeError(f"velocity command failed: {ack.reason}")

    def stop(self) -> None:
        ack = self.transport.request(VelocityPacket(type="stop", controller_id=self.controller_id))
        if not ack.ok:
            raise RuntimeError(f"stop failed: {ack.reason}")
