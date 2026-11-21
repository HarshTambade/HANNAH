"""The Robotics Safety Gateway, robot side: the last check before anything moves.

HANNAH's server runs the same kind of checks before it sends a command. These
run again here, against limits read from the robot's own profile file, because
the robot must not depend on the server having been right, reachable or
uncompromised. A command can ask for less than these limits (a lower speed),
never for more.

This is still software on a general-purpose computer. It is not a safety
function in the sense of ISO 13849 or IEC 61508: speed and force limiting,
protective stops and the emergency stop belong in the robot's safety-rated
controller and wiring, and they must work with this program stopped.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from .geometry import distance_to_rect, point_in_polygon

MOTION = {"navigate_to", "return_to_dock", "inspect_area"}
ARM = {"move_robot_arm", "grasp_object", "release_object"}
EXCLUSIVE = MOTION | ARM   # one of these at a time
KNOWN = EXCLUSIVE | {"stop_motion", "set_supported_device_state"}


@dataclass
class Decision:
    ok: bool
    reason: str = ""
    params: dict = field(default_factory=dict)
    max_speed: float = 0.0


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


class LocalSafety:
    def __init__(self, limits: dict, capabilities: list[str], world: dict | None = None, robot_radius: float = 0.2, devices: list[str] | None = None, dock: dict | None = None):
        self.limits = limits
        self.capabilities = set(capabilities)
        self.world = world or {}
        self.radius = robot_radius
        self.devices = set(devices or [])
        self.dock = dock

    def _point_problem(self, point: dict, label: str) -> str:
        if not isinstance(point, dict) or not _number(point.get("x")) or not _number(point.get("y")):
            return f"{label} has no valid position"
        x, y = float(point["x"]), float(point["y"])
        workspace = (self.limits.get("workspace") or {}).get("polygon")
        if not workspace:
            return "this robot has no workspace configured"
        if not point_in_polygon(x, y, workspace):
            return f"{label} ({x:.2f}, {y:.2f}) is outside this robot's workspace"
        for zone in self.limits.get("keepOut") or []:
            if point_in_polygon(x, y, zone["polygon"]):
                return f"{label} ({x:.2f}, {y:.2f}) is inside the keep-out zone '{zone.get('name', 'zone')}'"
        for rect in self.world.get("obstacles") or []:
            if distance_to_rect(x, y, rect) < self.radius:
                return f"{label} ({x:.2f}, {y:.2f}) is inside or touching the obstacle '{rect.get('name', 'obstacle')}'"
        return ""

    def check(self, capability: str, params: dict, state: dict, command_limits: dict | None = None, busy: bool = False) -> Decision:
        """May this command run now? `state` is the robot's own current state."""
        if capability not in KNOWN or capability not in self.capabilities:
            return Decision(False, f"this robot doesn't offer '{capability}'")
        if not isinstance(params, dict):
            return Decision(False, "the command's parameters are not an object")
        if capability == "stop_motion":
            return Decision(True, params={})
        if capability == "set_supported_device_state":
            if params.get("device") not in self.devices or params.get("state") not in ("on", "off"):
                return Decision(False, "not a switchable device of this robot, or not on/off")
            if state.get("faults"):
                return Decision(False, "the robot has an active fault")
            return Decision(True, params={"device": params["device"], "state": params["state"]})

        # Everything below moves the robot.
        if (state.get("estop") or {}).get("engaged"):
            return Decision(False, "the emergency stop is engaged")
        if state.get("motorsEnabled") is False:
            return Decision(False, "the motors are disabled")
        if state.get("faults"):
            return Decision(False, f"the robot has an active fault ({state['faults'][0].get('code', 'fault')})")
        if state.get("localized") is False:
            return Decision(False, "the robot isn't localized")
        for sensor in ("lidar", "odometry"):
            if ((state.get("sensors") or {}).get(sensor) or {}).get("ok") is False:
                return Decision(False, f"the {sensor} sensor isn't reporting")
        if busy:
            return Decision(False, "another motion mission is running")
        if capability in ARM:
            # The arm's planner checks joint limits and collisions along the whole motion; here, only where the tool may go.
            if capability == "move_robot_arm":
                problem = self._point_problem(params, "the target")
                return Decision(False, problem) if problem else Decision(True, params={"x": float(params["x"]), "y": float(params["y"])})
            if capability == "grasp_object":
                name = params.get("object")
                if not isinstance(name, str) or not name:
                    return Decision(False, "no object was named")
                if (state.get("gripper") or {}).get("holding"):
                    return Decision(False, f"the gripper is already holding {state['gripper']['holding']}")
                return Decision(True, params={"object": name})
            if not (state.get("gripper") or {}).get("holding"):
                return Decision(False, "the gripper isn't holding anything")
            return Decision(True, params={})
        local_max = self.limits.get("maxLinearSpeed")
        if not _number(local_max) or local_max <= 0:
            return Decision(False, "this robot has no speed limit configured")
        battery = (state.get("battery") or {}).get("percent")
        minimum = self.limits.get("minBatteryPercent")
        if capability != "return_to_dock" and _number(battery) and _number(minimum) and battery < minimum:
            return Decision(False, f"battery {battery:.0f}% is below the {minimum:.0f}% minimum")

        requested = params.get("maxSpeed")
        if requested is not None and (not _number(requested) or requested <= 0):
            return Decision(False, "the requested speed isn't a positive number")
        ceiling = [float(local_max)]
        if _number(requested):
            ceiling.append(float(requested))
        if command_limits and _number(command_limits.get("maxLinearSpeed")):
            ceiling.append(float(command_limits["maxLinearSpeed"]))
        speed = min(ceiling)  # a command can lower the speed, never raise it

        tolerance = params.get("tolerance", 0.25)
        if not _number(tolerance) or not 0.05 <= tolerance <= 1.0:
            return Decision(False, "the tolerance must be between 0.05 and 1 metre")

        if capability == "inspect_area":
            waypoints = params.get("waypoints")
            if not isinstance(waypoints, list) or not 1 <= len(waypoints) <= 12:
                return Decision(False, "a patrol needs 1 to 12 points")
            for index, point in enumerate(waypoints):
                problem = self._point_problem(point, f"point {index + 1}")
                if problem:
                    return Decision(False, problem)
            return Decision(True, params={"waypoints": [{"x": float(p["x"]), "y": float(p["y"])} for p in waypoints], "tolerance": float(tolerance)}, max_speed=speed)

        goal = params
        if capability == "return_to_dock":
            if not self.dock:
                return Decision(False, "this robot has no dock configured")
            # The dock is where this robot says it is, whatever the command says.
            goal = self.dock
        problem = self._point_problem(goal, "the goal")
        if problem:
            return Decision(False, problem)
        out = {"x": float(goal["x"]), "y": float(goal["y"]), "tolerance": float(tolerance)}
        if _number(goal.get("yaw")):
            out["yaw"] = float(goal["yaw"])
        return Decision(True, params=out, max_speed=speed)
