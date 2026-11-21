"""The hardware abstraction layer's contract.

The runtime never talks to motors, sensors or ROS directly. It talks to a
RobotAdapter, which presents one robot as: a description of itself, a current
state, and a few high-level operations that the robot's own planner and
controller carry out. An adapter exists per way of reaching a robot:

  KinematicSimAdapter   HANNAH's built-in mobile-robot simulator (hal/kinematic.py)
  ArmSimAdapter         HANNAH's built-in arm simulator (hal/arm.py)
  Ros2Adapter           any ROS 2 robot with Nav2: Gazebo or hardware (hal/ros2.py)

Adding a robot family means writing an adapter (or, for a ROS 2 robot, only a
profile file). Nothing above this layer changes.

Deliberately absent: set_velocity, set_pwm, set_torque. The runtime hands a
goal to the robot's navigation stack and can cancel it or ask for a hold; it
does not close the control loop itself.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class NavigationStatus:
    """What the robot's planner says about the goal it was given."""
    state: str = "idle"            # idle | active | succeeded | failed | cancelled
    reason: str = ""
    distance_remaining: float | None = None
    travelled: float = 0.0
    extra: dict = field(default_factory=dict)


class RobotAdapter(ABC):
    #: Shown in the registry: "kinematic", "ros2".
    name = "adapter"

    @abstractmethod
    def describe(self) -> dict:
        """Static facts: robotType, sensors, actuators, devices, capabilities, places, dock, world, limits,
        and `simulation` ({kind, note}) when this is not physical hardware (None when it is)."""

    @abstractmethod
    def state(self) -> dict:
        """The robot now: mode-independent facts only (pose, velocity, battery, estop, motorsEnabled,
        localized, faults, sensors, devices, nav). The runtime adds mode and mission."""

    def start(self) -> None:
        """Connect to the robot. Raise if it can't be reached."""

    def step(self, wall_dt: float) -> None:
        """Called every runtime tick. A simulator advances here; a real robot needs nothing."""

    def close(self) -> None:
        """Stop and disconnect."""

    # ---- high-level operations: carried out by the robot's planner and controller ----
    @abstractmethod
    def navigate(self, goal: dict, max_speed: float, tolerance: float) -> None:
        """Give the navigation stack a goal ({x, y, yaw?}, map frame) and a speed ceiling."""

    @abstractmethod
    def navigation_status(self) -> NavigationStatus:
        ...

    @abstractmethod
    def cancel_navigation(self) -> None:
        """Cancel the current goal. Idempotent."""

    @abstractmethod
    def hold(self) -> None:
        """Ask the base to stand still now (cancel goals, command zero motion). Idempotent."""

    # ---- manipulation: carried out by the arm's own planner (MoveIt 2 on a real arm) ----
    def move_arm(self, target: dict) -> None:
        """Give the arm's planner a tool position ({x, y}, base frame). Never joint values."""
        raise NotImplementedError(f"{self.name} has no arm")

    def arm_status(self) -> NavigationStatus:
        return self.navigation_status()

    def grasp(self, object_id: str) -> None:
        """Close the gripper on a named object that is at the tool."""
        raise NotImplementedError(f"{self.name} has no gripper")

    def release(self) -> None:
        """Open the gripper."""
        raise NotImplementedError(f"{self.name} has no gripper")

    def heartbeat(self) -> None:
        """Called every tick while the runtime is healthy, for an adapter-side watchdog."""

    def set_device(self, device: str, on: bool) -> None:
        raise NotImplementedError(f"{self.name} has no switchable devices")

    def acknowledge_fault(self) -> None:
        """Local operator action only. Never reachable from a HANNAH command."""
