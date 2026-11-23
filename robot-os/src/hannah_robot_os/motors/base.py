from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class MotorCommand:
    command_id: str
    controller_id: str
    linear_x_mps: float = 0.0
    angular_z_rps: float = 0.0
    issued_at_ms: int = 0
    ttl_ms: int = 500
    source: str = "unknown"  # must be validated source, never raw AI
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ControllerStatus:
    controller_id: str
    connected: bool
    enabled: bool
    fault: str | None = None
    estop_active: bool = False
    watchdog_ok: bool = True
    encoder_left: float | None = None
    encoder_right: float | None = None
    velocity_left_mps: float | None = None
    velocity_right_mps: float | None = None
    last_feedback_ms: int | None = None
    details: dict[str, Any] = field(default_factory=dict)


class MotorControllerAdapter(Protocol):
    controller_id: str

    def connect(self) -> None: ...
    def disconnect(self) -> None: ...
    def status(self) -> ControllerStatus: ...
    def enable(self, enabled: bool) -> None: ...
    def send_velocity(self, linear_x_mps: float, angular_z_rps: float) -> None: ...
    def stop(self) -> None: ...
