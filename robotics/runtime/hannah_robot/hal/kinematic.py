"""HANNAH's built-in simulator: a differential-drive robot in a 2-D room.

This is NOT Gazebo and not a physics engine. It is a kinematic simulation that
needs nothing but Python, so the whole path from a sentence to a verified robot
state can run and be tested anywhere. What it really computes:

  - a base controller with speed and acceleration limits and a command
    timeout (it stops if the navigator goes quiet), like ros2_control's
    diff_drive_controller;
  - unicycle kinematics for the true pose, collision with the room's walls and
    obstacles (a collision stops the base and latches a bumper fault);
  - wheel odometry with a configurable systematic error, so the pose the robot
    reports drifts from the truth as it would on a real machine;
  - a 2-D range sensor by ray casting against the room, including obstacles
    that are not on the robot's map;
  - a navigator standing in for Nav2: A* over an inflated occupancy grid, path
    following, stopping for whatever the range sensor sees ahead, re-planning
    around obstacles it discovers, and giving up honestly when it can't get
    there;
  - a battery, a dock that charges it, and a simulated hardware emergency stop
    that cuts the drive and can only be released locally.

Simulation time advances with the wall clock times `time_factor`.
"""
from __future__ import annotations

import heapq
import json
import math
import os
import random

from ..geometry import clamp, distance_to_rect, path_length, ray_bounds, ray_rect, wrap
from .base import NavigationStatus, RobotAdapter

DT = 0.02                 # simulation step, seconds
GRID = 0.1                # planning grid cell, metres
LIDAR_BEAMS = 72
LIDAR_RANGE = 8.0
LIDAR_PERIOD = 0.2
COMMAND_TIMEOUT = 0.5     # the base controller stops if it hears nothing for this long
LOOKAHEAD = 0.45
BLOCKED_GIVE_UP = 8.0     # seconds standing in front of an obstacle before the goal fails


class OccupancyGrid:
    """A planning grid over the room: cells the robot's centre may not enter."""

    def __init__(self, bounds: dict, obstacles: list[dict], inflation: float):
        self.bounds = bounds
        self.inflation = inflation
        self.width = int(round((bounds["maxX"] - bounds["minX"]) / GRID))
        self.height = int(round((bounds["maxY"] - bounds["minY"]) / GRID))
        self.blocked = bytearray(self.width * self.height)
        self.seen = bytearray(self.width * self.height)
        self.discovered: set[tuple[int, int]] = set()
        for row in range(self.height):
            for col in range(self.width):
                x, y = self.centre(col, row)
                wall = min(x - bounds["minX"], bounds["maxX"] - x, y - bounds["minY"], bounds["maxY"] - y)
                if wall < inflation or any(distance_to_rect(x, y, rect) < inflation for rect in obstacles):
                    self.blocked[row * self.width + col] = 1

    def centre(self, col: int, row: int) -> tuple[float, float]:
        return self.bounds["minX"] + (col + 0.5) * GRID, self.bounds["minY"] + (row + 0.5) * GRID

    def cell(self, x: float, y: float) -> tuple[int, int]:
        return int((x - self.bounds["minX"]) / GRID), int((y - self.bounds["minY"]) / GRID)

    def inside(self, col: int, row: int) -> bool:
        return 0 <= col < self.width and 0 <= row < self.height

    def is_blocked(self, col: int, row: int) -> bool:
        return not self.inside(col, row) or self.blocked[row * self.width + col] == 1

    def mark_seen(self, x: float, y: float) -> None:
        col, row = self.cell(x, y)
        if self.inside(col, row):
            self.seen[row * self.width + col] = 1

    def add_obstacle_point(self, x: float, y: float) -> bool:
        """Something the range sensor hit that isn't on the map. Blocks the cells around it. True if new."""
        col, row = self.cell(x, y)
        if not self.inside(col, row) or (col, row) in self.discovered:
            return False
        self.discovered.add((col, row))
        reach = int(math.ceil(self.inflation / GRID))
        for d_row in range(-reach, reach + 1):
            for d_col in range(-reach, reach + 1):
                c, r = col + d_col, row + d_row
                if self.inside(c, r) and math.hypot(d_col, d_row) * GRID <= self.inflation + GRID * 0.5:
                    self.blocked[r * self.width + c] = 1
        return True

    def coverage(self) -> float:
        return 100.0 * sum(self.seen) / max(1, len(self.seen))

    def line_free(self, a: tuple[float, float], b: tuple[float, float]) -> bool:
        steps = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / (GRID * 0.5)))
        for index in range(steps + 1):
            t = index / steps
            if self.is_blocked(*self.cell(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)):
                return False
        return True

    def nearest_free(self, col: int, row: int, reach: int = 4) -> tuple[int, int] | None:
        if not self.is_blocked(col, row):
            return col, row
        best = None
        for d_row in range(-reach, reach + 1):
            for d_col in range(-reach, reach + 1):
                if not self.is_blocked(col + d_col, row + d_row):
                    distance = math.hypot(d_col, d_row)
                    if best is None or distance < best[0]:
                        best = (distance, col + d_col, row + d_row)
        return (best[1], best[2]) if best else None

    def plan(self, start: tuple[float, float], goal: tuple[float, float]) -> list[tuple[float, float]] | None:
        """A* from start to goal. None when there is no way."""
        goal_cell = self.cell(*goal)
        if self.is_blocked(*goal_cell):
            return None
        # The robot may be standing in a cell that became blocked around it; start from the nearest free one.
        start_cell = self.nearest_free(*self.cell(*start))
        if start_cell is None:
            return None
        frontier = [(0.0, start_cell)]
        cost = {start_cell: 0.0}
        parent: dict[tuple[int, int], tuple[int, int]] = {}
        moves = [(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0), (1, 1, 1.4142), (1, -1, 1.4142), (-1, 1, 1.4142), (-1, -1, 1.4142)]
        while frontier:
            _, current = heapq.heappop(frontier)
            if current == goal_cell:
                break
            for d_col, d_row, step in moves:
                nxt = (current[0] + d_col, current[1] + d_row)
                if self.is_blocked(*nxt):
                    continue
                if d_col and d_row and (self.is_blocked(current[0] + d_col, current[1]) or self.is_blocked(current[0], current[1] + d_row)):
                    continue  # no cutting corners
                new_cost = cost[current] + step
                if new_cost < cost.get(nxt, math.inf):
                    cost[nxt] = new_cost
                    parent[nxt] = current
                    heapq.heappush(frontier, (new_cost + math.hypot(goal_cell[0] - nxt[0], goal_cell[1] - nxt[1]), nxt))
        if goal_cell not in cost:
            return None
        cells = [goal_cell]
        while cells[-1] != start_cell:
            cells.append(parent[cells[-1]])
        cells.reverse()
        points = [self.centre(*cell) for cell in cells]
        points[0] = start if not self.is_blocked(*self.cell(*start)) else points[0]
        points[-1] = goal
        # Pull the path straight wherever there is a clear line.
        smooth = [points[0]]
        index = 0
        while index < len(points) - 1:
            reach = len(points) - 1
            while reach > index + 1 and not self.line_free(points[index], points[reach]):
                reach -= 1
            smooth.append(points[reach])
            index = reach
        return smooth


class KinematicSimAdapter(RobotAdapter):
    name = "kinematic"

    def __init__(self, world: dict, limits: dict, robot: dict | None = None, simulation: dict | None = None, time_factor: float = 1.0, inputs_path: str | None = None):
        robot = robot or {}
        simulation = simulation or {}
        self.world = world
        self.limits = limits
        self.radius = float(robot.get("radius", 0.18))
        self.time_factor = max(0.1, min(50.0, float(time_factor)))
        self.inputs_path = inputs_path
        self._inputs_mtime = 0.0
        self._inputs_check = 0.0
        self.random = random.Random(simulation.get("seed", 7))
        self.drift = float(simulation.get("odometryDrift", 0.004))
        self.static = [dict(rect) for rect in world.get("obstacles", [])]
        self.dynamic: list[dict] = []
        self.grid = OccupancyGrid(world["bounds"], self.static, self.radius + 0.08)
        start = world.get("start") or world.get("dock") or {"x": 0.0, "y": 0.0, "yaw": 0.0}
        # Ground truth, and what the robot believes from its wheels.
        self.x, self.y, self.yaw = float(start["x"]), float(start["y"]), float(start.get("yaw", 0.0))
        self.odom_x, self.odom_y, self.odom_yaw = self.x, self.y, self.yaw
        self.v = self.w = 0.0
        self.sim_time = 0.0
        self.travelled = 0.0
        self.battery = float(simulation.get("startBatteryPercent", 85.0))
        self.estop = False
        self.faults: list[dict] = []
        self.devices = {"beacon": "off"}
        self.ranges = [LIDAR_RANGE] * LIDAR_BEAMS
        self._lidar_due = 0.0
        self._command = (0.0, 0.0)
        self._command_at = -1.0
        self._accumulator = 0.0
        self._frozen = False       # test hook: the navigator stops issuing commands
        # Navigation
        self._goal: dict | None = None
        self._path: list[tuple[float, float]] = []
        self._nav = NavigationStatus()
        self._nav_speed = 0.0
        self._nav_tolerance = 0.25
        self._blocked_for = 0.0
        self._replan_due = 0.0
        self._goal_start_travel = 0.0
        self._scan()

    # ---------------- description ----------------
    def describe(self) -> dict:
        bounds = self.world["bounds"]
        polygon = [[bounds["minX"], bounds["minY"]], [bounds["maxX"], bounds["minY"]], [bounds["maxX"], bounds["maxY"]], [bounds["minX"], bounds["maxY"]]]
        return {
            "robotType": "differential-drive",
            "protocols": ["hannah-robot-v1"],
            "sensors": [
                {"id": "lidar", "type": "2d-range", "description": f"{LIDAR_BEAMS} beams, {LIDAR_RANGE:.0f} m, simulated by ray casting"},
                {"id": "odometry", "type": "wheel-odometry", "description": "Integrated wheel motion with simulated drift"},
                {"id": "bumper", "type": "contact", "description": "Latches a fault on collision"},
                {"id": "battery", "type": "battery", "description": "Simulated charge"},
            ],
            "actuators": [{"id": "drive", "type": "differential-drive", "description": "Two driven wheels, simulated base controller"}],
            "devices": sorted(self.devices),
            "capabilities": ["report_robot_state", "read_sensor", "stop_motion", "navigate_to", "return_to_dock", "inspect_area", "set_supported_device_state"],
            "places": self.world.get("places", {}),
            "dock": self.world.get("dock"),
            "world": {"name": self.world.get("name", "world"), "bounds": bounds, "obstacles": [{"name": r.get("name", "obstacle"), "x": r["x"], "y": r["y"], "w": r["w"], "h": r["h"]} for r in self.static]},
            "limits": {
                **{key: self.limits[key] for key in ("maxLinearSpeed", "maxAngularSpeed", "maxLinearAccel", "minBatteryPercent", "linkTimeoutS", "commandTtlS") if key in self.limits},
                "robotRadius": self.radius,
                "environment": "simulation",
                "workspace": self.limits.get("workspace") or {"frame": "map", "polygon": polygon},
                "keepOut": self.limits.get("keepOut") or self.world.get("keepOut", []),
                "estop": {"hardware": False, "description": "Simulated emergency-stop input. Not a safety device."},
            },
            "simulation": {"kind": "hannah-kinematic", "note": "HANNAH's built-in 2-D kinematic simulator. Not Gazebo; no physics engine."},
        }

    # ---------------- sensing ----------------
    def _obstacles(self) -> list[dict]:
        return self.static + self.dynamic

    def _scan(self) -> None:
        bounds = self.world["bounds"]
        obstacles = self._obstacles()
        for beam in range(LIDAR_BEAMS):
            angle = self.yaw + (2 * math.pi * beam / LIDAR_BEAMS)
            dx, dy = math.cos(angle), math.sin(angle)
            best = min(LIDAR_RANGE, ray_bounds(self.x, self.y, dx, dy, bounds))
            for rect in obstacles:
                hit = ray_rect(self.x, self.y, dx, dy, rect)
                if hit is not None and hit < best:
                    best = hit
            self.ranges[beam] = best
            # Mapping: cells along the beam were seen; a hit that isn't on the map is a new obstacle.
            # The map is built with the pose the robot believes (odometry), as a real robot's would be.
            o_angle = self.odom_yaw + (2 * math.pi * beam / LIDAR_BEAMS)
            ox, oy = math.cos(o_angle), math.sin(o_angle)
            distance = 0.0
            while distance < best:
                self.grid.mark_seen(self.odom_x + ox * distance, self.odom_y + oy * distance)
                distance += GRID
            if best < LIDAR_RANGE - 1e-6:
                hx, hy = self.x + dx * best, self.y + dy * best
                on_wall = min(hx - bounds["minX"], bounds["maxX"] - hx, hy - bounds["minY"], bounds["maxY"] - hy) < 0.05
                if not on_wall and not any(distance_to_rect(hx, hy, rect) < 0.05 for rect in self.static):
                    if self.grid.add_obstacle_point(self.odom_x + ox * best, self.odom_y + oy * best):
                        self._replan_due = 0.0

    def _clear_ahead(self) -> float:
        """The nearest return in a cone in front of the robot."""
        half = max(1, int(LIDAR_BEAMS * 25 / 360))
        return min(self.ranges[index % LIDAR_BEAMS] for index in range(-half, half + 1))

    # ---------------- the base controller and the world ----------------
    def _collides(self, x: float, y: float) -> str:
        bounds = self.world["bounds"]
        if min(x - bounds["minX"], bounds["maxX"] - x, y - bounds["minY"], bounds["maxY"] - y) < self.radius:
            return "wall"
        for rect in self._obstacles():
            if distance_to_rect(x, y, rect) < self.radius:
                return rect.get("name", "obstacle")
        return ""

    def _fault(self, code: str, message: str) -> None:
        if not any(item["code"] == code for item in self.faults):
            self.faults.append({"code": code, "message": message, "at": round(self.sim_time, 2)})

    def _physics(self) -> None:
        max_v = float(self.limits.get("maxLinearSpeed", 0.5))
        max_w = float(self.limits.get("maxAngularSpeed", 1.5))
        accel = float(self.limits.get("maxLinearAccel", 0.8))
        accel_w = float(self.limits.get("maxAngularAccel", 3.0))
        want_v, want_w = self._command
        # The controller's own rules, whatever it is asked for.
        if self.sim_time - self._command_at > COMMAND_TIMEOUT:
            want_v = want_w = 0.0
        want_v, want_w = clamp(want_v, -max_v, max_v), clamp(want_w, -max_w, max_w)
        if self.estop or self.faults or self.battery <= 0.0:
            self.v = self.w = 0.0          # drive power is cut: no ramp
            return
        self.v += clamp(want_v - self.v, -accel * DT, accel * DT)
        self.w += clamp(want_w - self.w, -accel_w * DT, accel_w * DT)
        if abs(self.v) < 1e-4 and abs(self.w) < 1e-4:
            self.v = self.w = 0.0 if (want_v == 0.0 and want_w == 0.0) else self.v
            if want_v == 0.0 and want_w == 0.0:
                return
        new_yaw = wrap(self.yaw + self.w * DT)
        new_x = self.x + self.v * math.cos(new_yaw) * DT
        new_y = self.y + self.v * math.sin(new_yaw) * DT
        hit = self._collides(new_x, new_y)
        if hit:
            self.v = self.w = 0.0
            self._fault("collision", f"Bumper pressed against {hit}. The drive is stopped until the fault is acknowledged at the robot.")
            return
        step = abs(self.v) * DT
        self.x, self.y, self.yaw = new_x, new_y, new_yaw
        self.travelled += step
        # Odometry: what the wheels say, with a systematic scale error and a little noise.
        scale = 1.0 + self.drift
        noise = self.random.gauss(0.0, 0.002) if step else 0.0
        self.odom_yaw = wrap(self.odom_yaw + self.w * DT * (1.0 + self.drift * 0.5))
        self.odom_x += (self.v * scale + noise) * math.cos(self.odom_yaw) * DT
        self.odom_y += (self.v * scale + noise) * math.sin(self.odom_yaw) * DT
        self.battery = max(0.0, self.battery - 0.15 * step)

    def _battery_and_dock(self) -> None:
        dock = self.world.get("dock")
        docked = bool(dock) and math.hypot(self.x - dock["x"], self.y - dock["y"]) < 0.25 and self.v == 0.0
        if docked:
            self.battery = min(100.0, self.battery + 0.5 * DT)
            if not getattr(self, "_docked", False):
                # In the dock the robot knows exactly where it is: the dock's position is surveyed.
                self.odom_x, self.odom_y, self.odom_yaw = self.x, self.y, self.yaw
        else:
            self.battery = max(0.0, self.battery - 0.004 * DT)
        self._docked = docked

    # ---------------- the navigator (stands in for Nav2) ----------------
    def _drive(self, v: float, w: float) -> None:
        self._command = (v, w)
        self._command_at = self.sim_time

    def _fail(self, reason: str) -> None:
        self._nav = NavigationStatus("failed", reason, travelled=self.travelled - self._goal_start_travel)
        self._goal, self._path = None, []
        self._drive(0.0, 0.0)

    def _navigate_step(self) -> None:
        if self._goal is None or self._frozen:
            return
        if self.estop:
            return self._fail("The emergency stop was engaged.")
        if self.faults:
            return self._fail(f"The robot faulted: {self.faults[0]['message']}")
        if self.battery <= 0.0:
            return self._fail("The battery is empty.")
        gx, gy = self._goal["x"], self._goal["y"]
        distance = math.hypot(gx - self.odom_x, gy - self.odom_y)
        arrive = max(0.05, self._nav_tolerance * 0.5)
        if distance <= arrive:
            yaw = self._goal.get("yaw")
            error = wrap(yaw - self.odom_yaw) if yaw is not None else 0.0
            if yaw is not None and abs(error) > 0.08:
                return self._drive(0.0, clamp(2.0 * error, -1.0, 1.0))
            self._drive(0.0, 0.0)
            if abs(self.v) < 0.005 and abs(self.w) < 0.01:
                self._nav = NavigationStatus("succeeded", "", 0.0, self.travelled - self._goal_start_travel)
                self._goal, self._path = None, []
            return
        if self.sim_time >= self._replan_due or not self._path:
            path = self.grid.plan((self.odom_x, self.odom_y), (gx, gy))
            self._replan_due = self.sim_time + 2.0
            if path is None:
                return self._fail("No path to the goal: it is blocked or unreachable on the robot's map.")
            self._path = path
        # Follow: aim at the point a lookahead distance along the path.
        while len(self._path) > 1 and math.hypot(self._path[0][0] - self.odom_x, self._path[0][1] - self.odom_y) < LOOKAHEAD * 0.6:
            self._path.pop(0)
        tx, ty = self._path[0]
        heading = wrap(math.atan2(ty - self.odom_y, tx - self.odom_x) - self.odom_yaw)
        accel = float(self.limits.get("maxLinearAccel", 0.8))
        clear = self._clear_ahead() - self.radius
        stop_distance = 0.12 + (self.v * self.v) / (2 * accel)
        blocked = clear < stop_distance and abs(heading) < 0.6
        if blocked:
            self._blocked_for += DT
            self._replan_due = min(self._replan_due, self.sim_time + 0.4)
            if self._blocked_for > BLOCKED_GIVE_UP:
                return self._fail("Blocked: something is in the way and there is no way around it.")
            return self._drive(0.0, 0.0)
        self._blocked_for = max(0.0, self._blocked_for - DT)
        if abs(heading) > 0.9:
            return self._drive(0.0, clamp(2.2 * heading, -1.2, 1.2))
        speed = min(self._nav_speed, math.sqrt(max(0.0, 2 * accel * 0.6 * max(0.0, distance - arrive * 0.5))) + 0.05, max(0.05, (clear - 0.1) * 1.2))
        self._drive(max(0.0, speed * math.cos(heading)), clamp(2.4 * heading, -1.4, 1.4))
        self._nav = NavigationStatus("active", "", path_length([(self.odom_x, self.odom_y), *self._path]), self.travelled - self._goal_start_travel)

    def navigate(self, goal: dict, max_speed: float, tolerance: float) -> None:
        self._goal = {"x": float(goal["x"]), "y": float(goal["y"]), **({"yaw": float(goal["yaw"])} if goal.get("yaw") is not None else {})}
        self._nav_speed = min(float(max_speed), float(self.limits.get("maxLinearSpeed", max_speed)))
        self._nav_tolerance = float(tolerance)
        self._path, self._replan_due, self._blocked_for = [], 0.0, 0.0
        self._goal_start_travel = self.travelled
        self._nav = NavigationStatus("active", "", math.hypot(self._goal["x"] - self.odom_x, self._goal["y"] - self.odom_y))

    def navigation_status(self) -> NavigationStatus:
        return self._nav

    def cancel_navigation(self) -> None:
        if self._goal is not None:
            self._nav = NavigationStatus("cancelled", "Cancelled.", travelled=self.travelled - self._goal_start_travel)
        self._goal, self._path = None, []
        self._drive(0.0, 0.0)

    def hold(self) -> None:
        self.cancel_navigation()
        self._drive(0.0, 0.0)

    def set_device(self, device: str, on: bool) -> None:
        if device not in self.devices:
            raise ValueError(f"no device called {device}")
        self.devices[device] = "on" if on else "off"

    def acknowledge_fault(self) -> None:
        # Only clears when the robot is no longer in contact with anything.
        if not self._collides(self.x, self.y):
            self.faults = []

    # ---------------- simulated inputs a person would make at the robot ----------------
    def press_estop(self, engaged: bool) -> None:
        self.estop = bool(engaged)

    def place_obstacle(self, rect: dict) -> None:
        self.dynamic.append({"name": rect.get("name", "unexpected object"), "x": float(rect["x"]), "y": float(rect["y"]), "w": float(rect["w"]), "h": float(rect["h"])})

    def _read_inputs(self) -> None:
        """A file next to the robot's state stands in for the buttons on a real machine."""
        if not self.inputs_path:
            return
        try:
            mtime = os.stat(self.inputs_path).st_mtime
        except OSError:
            return
        if mtime == self._inputs_mtime:
            return
        self._inputs_mtime = mtime
        try:
            with open(self.inputs_path, "r", encoding="utf-8") as handle:
                inputs = json.load(handle)
        except (OSError, ValueError):
            return
        if isinstance(inputs.get("estop"), bool):
            self.press_estop(inputs["estop"])
        if isinstance(inputs.get("obstacles"), list):
            self.dynamic = []
            for rect in inputs["obstacles"][:20]:
                if all(isinstance(rect.get(key), (int, float)) for key in ("x", "y", "w", "h")):
                    self.place_obstacle(rect)
        if isinstance(inputs.get("batteryPercent"), (int, float)):
            self.battery = clamp(float(inputs["batteryPercent"]), 0.0, 100.0)
        if inputs.get("acknowledgeFault"):
            self.acknowledge_fault()
        if isinstance(inputs.get("freezeNavigator"), bool):
            self._frozen = inputs["freezeNavigator"]

    # ---------------- time ----------------
    def advance(self, sim_seconds: float) -> None:
        """Advance the simulation by this much simulated time."""
        self._accumulator += sim_seconds
        while self._accumulator >= DT:
            self._accumulator -= DT
            self.sim_time += DT
            if self.sim_time >= self._lidar_due:
                self._lidar_due = self.sim_time + LIDAR_PERIOD
                self._scan()
            self._navigate_step()
            self._physics()
            self._battery_and_dock()

    def step(self, wall_dt: float) -> None:
        self._inputs_check += wall_dt
        if self._inputs_check >= 0.1:
            self._inputs_check = 0.0
            self._read_inputs()
        self.advance(min(wall_dt, 0.25) * self.time_factor)

    # ---------------- state ----------------
    def state(self) -> dict:
        nearest = min(range(LIDAR_BEAMS), key=lambda index: self.ranges[index])
        path = [(self.odom_x, self.odom_y), *self._path] if self._goal else []
        stride = max(1, len(path) // 40)
        return {
            "pose": {"x": round(self.odom_x, 3), "y": round(self.odom_y, 3), "yaw": round(self.odom_yaw, 4), "frame": "map", "source": "odometry"},
            "velocity": {"linear": round(self.v, 3), "angular": round(self.w, 3)},
            "battery": {"percent": round(self.battery, 1), "charging": bool(getattr(self, "_docked", False))},
            "estop": {"engaged": self.estop, "source": "simulated-hardware"},
            "motorsEnabled": not self.estop and not self.faults and self.battery > 0.0,
            "localized": True,
            "docked": bool(getattr(self, "_docked", False)),
            "faults": list(self.faults),
            "sensors": {
                "lidar": {"ok": True, "beams": LIDAR_BEAMS, "maxRange": LIDAR_RANGE, "minRange": round(self.ranges[nearest], 3), "minBearingDeg": round(360.0 * nearest / LIDAR_BEAMS, 1), "ranges": [round(value, 2) for value in self.ranges]},
                "odometry": {"ok": True, "travelled": round(self.travelled, 2)},
                "bumper": {"ok": True, "pressed": any(item["code"] == "collision" for item in self.faults)},
                "battery": {"ok": True, "percent": round(self.battery, 1)},
            },
            "devices": dict(self.devices),
            "nav": {"goal": self._goal, "path": [[round(p[0], 2), round(p[1], 2)] for p in path[::stride]], "status": self._nav.state},
            "map": {"coveragePercent": round(self.grid.coverage(), 1), "discovered": [[round(v, 2) for v in self.grid.centre(*cell)] for cell in sorted(self.grid.discovered)[:120]]},
            "sim": {
                "kind": "hannah-kinematic", "timeFactor": self.time_factor, "time": round(self.sim_time, 2),
                "truth": {"x": round(self.x, 3), "y": round(self.y, 3), "yaw": round(self.yaw, 4)},
                "odometryError": round(math.hypot(self.x - self.odom_x, self.y - self.odom_y), 3),
            },
        }
