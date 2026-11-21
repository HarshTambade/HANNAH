"""HANNAH's built-in arm simulator: a three-joint planar arm with a gripper, seen from above.

This is NOT MoveIt 2 and not Gazebo. It is a kinematic simulation that needs
nothing but Python, so the manipulation path (a named pose or a point, checks,
approval, motion, grasp, verification) can run and be tested anywhere. What it
really computes:

  - forward and inverse kinematics for three revolute joints in a plane;
  - joint limits, and a joint speed limit enforced by how every motion is timed;
  - collision checking of every link against the fixtures on the table, along
    the whole motion, before the motion starts: a motion that would touch
    something is never begun;
  - a choice among elbow and wrist solutions, and a detour through the home
    position when the straight joint motion would collide;
  - a gripper whose fingers either close on an object that is really between
    them or close on nothing and say so; a held object moves with the tool;
  - a simulated emergency stop that freezes the joints at once.

The interface above it never sees a joint angle to command: the runtime gives a
tool position, and this module (like MoveIt on a real arm) decides the joints.
"""
from __future__ import annotations

import json
import math
import os
import time

from ..geometry import distance_to_rect, point_in_polygon, wrap
from .base import NavigationStatus, RobotAdapter

DT = 0.02
GRASP_REACH = 0.035      # an object's centre must be this close to the tool point to be between the fingers
GRIP_TIME = 0.4


def forward(links, joints):
    """The positions of the shoulder, elbow, wrist and tool for these joint angles."""
    points, angle, x, y = [(0.0, 0.0)], 0.0, 0.0, 0.0
    for length, joint in zip(links, joints):
        angle += joint
        x, y = x + length * math.cos(angle), y + length * math.sin(angle)
        points.append((x, y))
    return points, angle


class ArmSimAdapter(RobotAdapter):
    name = "arm-kinematic"

    def __init__(self, world: dict, limits: dict, simulation: dict | None = None, time_factor: float = 1.0, inputs_path: str | None = None):
        arm = world["arm"]
        self.world = world
        self.limits = limits
        self.links = [float(value) for value in arm["links"]]
        self.joint_limits = [tuple(pair) for pair in arm["jointLimits"]]
        self.link_radius = float(arm.get("linkRadius", 0.03))
        self.max_speed = float(limits.get("maxJointSpeed", 1.2))
        self.time_factor = max(0.1, min(50.0, float(time_factor)))
        self.inputs_path = inputs_path
        self._inputs_mtime = 0.0
        self._inputs_check = 0.0
        self.obstacles = [dict(rect) for rect in world.get("obstacles", [])]
        self.objects = {item["id"]: {"x": float(item["x"]), "y": float(item["y"]), "size": float(item.get("size", 0.04))} for item in world.get("objects", [])}
        self.home = [float(value) for value in arm.get("home", [0.0, 1.2, -1.0])]
        self.joints = list(self.home)
        self.speeds = [0.0, 0.0, 0.0]
        self.sim_time = 0.0
        self.estop = False
        self.faults: list[dict] = []
        self.gripper_open = True
        self.holding: str | None = None
        self._segments: list[tuple[list[float], list[float], float]] = []   # (from, to, duration)
        self._elapsed = 0.0
        self._status = NavigationStatus()
        self._grip_until = 0.0
        self._grip_result: tuple[str, str] | None = None
        self._accumulator = 0.0
        self._target: dict | None = None

    # ---------------- description ----------------
    def describe(self) -> dict:
        bounds = self.world["bounds"]
        return {
            "robotType": "manipulator-arm", "protocols": ["hannah-robot-v1"],
            "sensors": [
                {"id": "joint_encoders", "type": "joint-position", "description": "Three joint angles, simulated"},
                {"id": "gripper", "type": "gripper-feedback", "description": "Open or closed, and whether something is between the fingers; simulated"},
            ],
            "actuators": [{"id": "arm", "type": "three-joint planar arm", "description": "Moved by the simulator's own planner"}, {"id": "gripper", "type": "parallel gripper", "description": "Simulated"}],
            "devices": [],
            "capabilities": ["report_robot_state", "read_sensor", "stop_motion", "move_robot_arm", "grasp_object", "release_object"],
            # Named poses. "home" is wherever the home joint position puts the tool.
            "places": {"home": dict(zip(("x", "y"), (round(value, 4) for value in forward(self.links, self.home)[0][-1]))), **{name: {"x": point["x"], "y": point["y"]} for name, point in self.world.get("places", {}).items() if name not in self.objects}},
            "dock": None,
            "world": {"name": self.world.get("name", "bench"), "bounds": bounds, "obstacles": [{"name": r.get("name", "fixture"), "x": r["x"], "y": r["y"], "w": r["w"], "h": r["h"]} for r in self.obstacles]},
            "limits": {
                "maxJointSpeed": self.max_speed, "robotRadius": self.link_radius,
                **{key: self.limits[key] for key in ("linkTimeoutS", "commandTtlS") if key in self.limits},
                "environment": "simulation",
                "workspace": self.world["workspace"], "keepOut": self.world.get("keepOut", []),
                "estop": {"hardware": False, "description": "Simulated emergency-stop input. Not a safety device."},
            },
            "simulation": {"kind": "hannah-arm-kinematic", "note": "HANNAH's built-in planar arm simulator. Not MoveIt 2, not Gazebo; no physics engine."},
        }

    # ---------------- kinematics and checks ----------------
    def _within_limits(self, joints) -> bool:
        return all(low - 1e-9 <= value <= high + 1e-9 for value, (low, high) in zip(joints, self.joint_limits))

    def _collides(self, joints) -> str:
        points, _ = forward(self.links, joints)
        for start, end in zip(points, points[1:]):
            steps = max(2, int(math.hypot(end[0] - start[0], end[1] - start[1]) / 0.02))
            for index in range(steps + 1):
                t = index / steps
                x, y = start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t
                for rect in self.obstacles:
                    if distance_to_rect(x, y, rect) < self.link_radius:
                        return rect.get("name", "fixture")
        return ""

    def solve(self, x: float, y: float) -> list[list[float]]:
        """Joint solutions that put the tool at (x, y): several wrist directions, elbow either way. Inside limits, not colliding."""
        a, b, c = self.links
        radial = math.atan2(y, x)
        found = []
        for offset in (0.0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5):
            tool = radial + offset
            wx, wy = x - c * math.cos(tool), y - c * math.sin(tool)
            reach = math.hypot(wx, wy)
            if reach > a + b - 1e-6 or reach < abs(a - b) + 1e-6:
                continue
            cosine = (reach * reach - a * a - b * b) / (2 * a * b)
            for sign in (1.0, -1.0):
                elbow = sign * math.acos(max(-1.0, min(1.0, cosine)))
                shoulder = math.atan2(wy, wx) - math.atan2(b * math.sin(elbow), a + b * math.cos(elbow))
                joints = [wrap(shoulder), elbow, wrap(tool - shoulder - elbow)]
                if self._within_limits(joints) and not self._collides(joints):
                    found.append(joints)
        return found

    def _path_clear(self, start, end) -> bool:
        for index in range(1, 41):
            t = index / 40
            if self._collides([s + (e - s) * t for s, e in zip(start, end)]):
                return False
        return True

    def plan(self, x: float, y: float) -> tuple[list[tuple[list[float], list[float], float]] | None, str]:
        """Segments of joint motion to the point, or None and the reason. Nothing moves here."""
        workspace = (self.world.get("workspace") or {}).get("polygon")
        if workspace and not point_in_polygon(x, y, workspace):
            return None, "That position is outside the arm's workspace."
        solutions = self.solve(x, y)
        if not solutions:
            return None, "The arm can't reach that position without exceeding a joint limit or touching a fixture."
        travel = lambda joints: max(abs(target - current) for target, current in zip(joints, self.joints))  # noqa: E731
        duration = lambda start, end: max(0.2, 1.5 * max(abs(e - s) for s, e in zip(start, end)) / self.max_speed)  # noqa: E731
        for joints in sorted(solutions, key=travel):
            if self._path_clear(self.joints, joints):
                return [(list(self.joints), joints, duration(self.joints, joints))], ""
        # A straight joint motion would touch something: go by way of the home position.
        if self._path_clear(self.joints, self.home):
            for joints in sorted(solutions, key=lambda item: max(abs(target - current) for target, current in zip(item, self.home))):
                if self._path_clear(self.home, joints):
                    return [(list(self.joints), list(self.home), duration(self.joints, self.home)), (list(self.home), joints, duration(self.home, joints))], ""
        # Or fold the arm in, swing the shoulder round while folded, and reach out again.
        for joints in sorted(solutions, key=travel):
            for bend in (2.3, -2.3):
                tucked_here = [self.joints[0], bend, -bend * 0.8]
                tucked_there = [joints[0], bend, -bend * 0.8]
                legs = [(list(self.joints), tucked_here), (tucked_here, tucked_there), (tucked_there, joints)]
                if all(self._within_limits(leg[1]) and self._path_clear(*leg) for leg in legs):
                    return [(start, end, duration(start, end)) for start, end in legs], ""
        return None, "No motion to that position is free of collisions."

    # ---------------- operations ----------------
    def move_arm(self, target: dict) -> None:
        if self.estop:
            self._status = NavigationStatus("failed", "The emergency stop is engaged.")
            return
        segments, reason = self.plan(float(target["x"]), float(target["y"]))
        if segments is None:
            self._status = NavigationStatus("failed", reason)
            return
        self._target = {"x": float(target["x"]), "y": float(target["y"])}
        self._segments, self._elapsed = segments, 0.0
        self._status = NavigationStatus("active", "", self._distance_to_target())

    def grasp(self, object_id: str) -> None:
        if self.estop:
            self._status = NavigationStatus("failed", "The emergency stop is engaged.")
            return
        if self.holding:
            self._status = NavigationStatus("failed", f"The gripper is already holding {self.holding}.")
            return
        tool = self.tool()
        item = self.objects.get(object_id)
        near = item is not None and math.hypot(item["x"] - tool[0], item["y"] - tool[1]) <= GRASP_REACH
        self.gripper_open = False
        self._grip_until = self.sim_time + GRIP_TIME
        # Decided by what is really between the fingers, not by what was asked for.
        self._grip_result = ("succeeded", object_id) if near else ("failed", "The gripper closed on nothing: the object isn't between its fingers." if item is not None else "There is no such object on the table.")
        self._status = NavigationStatus("active", "")

    def release(self) -> None:
        if self.holding:
            tool = self.tool()
            self.objects[self.holding]["x"], self.objects[self.holding]["y"] = tool[0], tool[1]
        self.holding = None
        self.gripper_open = True
        self._grip_until = self.sim_time + GRIP_TIME
        self._grip_result = ("succeeded", "")
        self._status = NavigationStatus("active", "")

    def arm_status(self) -> NavigationStatus:
        return self._status

    def navigation_status(self) -> NavigationStatus:
        return self._status

    def navigate(self, goal: dict, max_speed: float, tolerance: float) -> None:
        self._status = NavigationStatus("failed", "An arm doesn't drive.")

    def cancel_navigation(self) -> None:
        if self._segments:
            self._status = NavigationStatus("cancelled", "Cancelled.")
        self._segments = []
        self.speeds = [0.0, 0.0, 0.0]

    def hold(self) -> None:
        self.cancel_navigation()

    def acknowledge_fault(self) -> None:
        self.faults = []

    def press_estop(self, engaged: bool) -> None:
        self.estop = bool(engaged)

    # ---------------- time ----------------
    def tool(self) -> tuple[float, float]:
        return forward(self.links, self.joints)[0][-1]

    def _distance_to_target(self) -> float:
        if not self._target:
            return 0.0
        tool = self.tool()
        return math.hypot(tool[0] - self._target["x"], tool[1] - self._target["y"])

    def _tick(self) -> None:
        self.sim_time += DT
        if self.estop:
            if self._segments or self._grip_result:
                self._status = NavigationStatus("failed", "The emergency stop was engaged.")
            self._segments, self._grip_result, self.speeds = [], None, [0.0, 0.0, 0.0]
            return
        if self._grip_result and self.sim_time >= self._grip_until:
            outcome, detail = self._grip_result
            self._grip_result = None
            if outcome == "succeeded" and detail:
                self.holding = detail
            self._status = NavigationStatus(outcome, "" if outcome == "succeeded" else detail)
        if not self._segments:
            self.speeds = [0.0, 0.0, 0.0]
            return
        start, end, duration = self._segments[0]
        self._elapsed += DT
        t = min(1.0, self._elapsed / duration)
        eased = t * t * (3 - 2 * t)   # smooth start and stop; its steepest slope is 1.5, which the duration allows for
        previous = self.joints
        self.joints = [s + (e - s) * eased for s, e in zip(start, end)]
        self.speeds = [(now - before) / DT for now, before in zip(self.joints, previous)]
        if self.holding:
            tool = self.tool()
            self.objects[self.holding]["x"], self.objects[self.holding]["y"] = tool[0], tool[1]
        if t >= 1.0:
            self._segments.pop(0)
            self._elapsed = 0.0
            if not self._segments:
                self.speeds = [0.0, 0.0, 0.0]
                self._status = NavigationStatus("succeeded", "", 0.0)
        else:
            self._status = NavigationStatus("active", "", self._distance_to_target())

    def advance(self, sim_seconds: float) -> None:
        self._accumulator += sim_seconds
        while self._accumulator >= DT:
            self._accumulator -= DT
            self._tick()

    def _read_inputs(self) -> None:
        if not self.inputs_path:
            return
        try:
            mtime = os.stat(self.inputs_path).st_mtime
            if mtime == self._inputs_mtime:
                return
            self._inputs_mtime = mtime
            with open(self.inputs_path, "r", encoding="utf-8") as handle:
                inputs = json.load(handle)
        except (OSError, ValueError):
            return
        if isinstance(inputs.get("estop"), bool):
            self.press_estop(inputs["estop"])

    def step(self, wall_dt: float) -> None:
        self._inputs_check += wall_dt
        if self._inputs_check >= 0.1:
            self._inputs_check = 0.0
            self._read_inputs()
        self.advance(min(wall_dt, 0.25) * self.time_factor)

    # ---------------- state ----------------
    def state(self) -> dict:
        points, angle = forward(self.links, self.joints)
        tool = points[-1]
        now_ms = int(time.time() * 1000)
        fastest = max(abs(value) for value in self.speeds)
        return {
            "pose": {"x": round(tool[0], 4), "y": round(tool[1], 4), "yaw": round(wrap(angle), 4), "frame": "base", "source": "joint encoders (forward kinematics)"},
            "velocity": {"linear": round(fastest * sum(self.links), 4), "angular": round(fastest, 4)},
            "battery": None,
            "estop": {"engaged": self.estop, "source": "simulated-hardware"},
            "motorsEnabled": not self.estop and not self.faults,
            "localized": True,
            "faults": list(self.faults),
            "sensors": {
                "joint_encoders": {"ok": True, "source": "simulated", "measuredAt": now_ms, "positions": [round(value, 4) for value in self.joints], "speeds": [round(value, 4) for value in self.speeds], "unit": "rad"},
                "gripper": {"ok": True, "source": "simulated", "measuredAt": now_ms, "open": self.gripper_open, "holding": self.holding},
            },
            "devices": {},
            "arm": {"points": [[round(x, 4), round(y, 4)] for x, y in points], "target": self._target, "status": self._status.state},
            "gripper": {"open": self.gripper_open, "holding": self.holding},
            "scene": {"source": "the simulator's own scene (not a camera)", "objects": [{"id": name, "x": round(item["x"], 4), "y": round(item["y"], 4), "held": name == self.holding} for name, item in self.objects.items()]},
            "sim": {"kind": "hannah-arm-kinematic", "timeFactor": self.time_factor, "time": round(self.sim_time, 2)},
        }
