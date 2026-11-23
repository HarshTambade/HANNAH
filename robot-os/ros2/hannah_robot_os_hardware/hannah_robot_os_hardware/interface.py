"""ROS2-control-facing hardware interface skeleton for HANNAH Robot OS.

No rclpy import here on purpose: the control logic is testable without ROS.
A real ros2_control SystemInterface plugin should wrap this class and only
forward commands that have passed the onboard HANNAH safety gateway.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


class ManagerClient(Protocol):
    def status(self) -> dict[str, Any]: ...
    def send_velocity(self, linear_x_mps: float, angular_z_rps: float) -> None: ...
    def stop(self) -> None: ...


@dataclass
class HannahSystemInterface:
    """Mockable bridge between ros2_control and Motor Controller Manager."""

    client: ManagerClient
    configured: bool = False
    active: bool = False
    config: dict[str, Any] = field(default_factory=dict)

    def on_configure(self, config: dict[str, Any]) -> bool:
        if not config.get("controller_id"):
            return False
        self.config = dict(config)
        self.configured = True
        return True

    def on_activate(self) -> bool:
        if not self.configured:
            return False
        self.active = True
        return True

    def on_deactivate(self) -> None:
        self.active = False
        self.client.stop()

    def read(self) -> dict[str, Any]:
        if not self.active:
            return {}
        return self.client.status()

    def write(self, command: dict[str, Any]) -> bool:
        """Accept only high-level velocity/stop commands within configured limits."""
        if not self.active:
            return False
        kind = command.get("type")
        if kind == "stop":
            self.client.stop()
            return True
        if kind != "velocity":
            return False
        linear = float(command.get("linear_x_mps", 0.0))
        angular = float(command.get("angular_z_rps", 0.0))
        limits = self.config.get("limits", {})
        if abs(linear) > float(limits.get("max_linear_speed_mps", 0.5)):
            return False
        if abs(angular) > float(limits.get("max_angular_speed_rps", 1.5)):
            return False
        self.client.send_velocity(linear, angular)
        return True
