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
import time

from ..geometry import clamp, distance_to_rect, path_length, ray_bounds, ray_rect, wrap
from ..vision import Frame
from .base import NavigationStatus, RobotAdapter

DT = 0.02                 # simulation step, seconds
GRID = 0.1                # planning grid cell, metres
LIDAR_BEAMS = 72
LIDAR_RANGE = 8.0
LIDAR_PERIOD = 0.2
COMMAND_TIMEOUT = 0.5     # the base controller stops if it hears nothing for this long
LOOKAHEAD = 0.45
BLOCKED_GIVE_UP = 8.0     # seconds standing in front of an obstacle before the goal fails
CAMERA_WIDTH, CAMERA_HEIGHT, CAMERA_FOV_DEG, CAMERA_RANGE = 64, 48, 70.0, 8.0
# What the simulated camera paints. An obstacle with no colour is grey, which no detector here picks out.
PALETTE = {"red": (205, 45, 45), "orange": (230, 130, 30), "yellow": (225, 205, 40), "green": (40, 160, 70), "blue": (45, 85, 205), "purple": (140, 60, 170)}
GREY, WALL, FLOOR, CEILING = (120, 120, 126), (172, 172, 166), (70, 70, 74), (202, 207, 212)


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
        self.static = bytes(self.blocked)   # the map as surveyed; what the sensor finds is added on top
        self.dirty = False

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

    def clear_point(self, x: float, y: float) -> None:
        """The sensor now sees through a cell it once found occupied: the thing that was there has gone."""
        cell = self.cell(x, y)
        if cell in self.discovered:
            self.discovered.discard(cell)
            self.dirty = True

    def rebuild(self) -> None:
        """Recompute the blocked cells from the surveyed map and what is still discovered."""
        self.blocked = bytearray(self.static)
        remaining, self.discovered = self.discovered, set()
        for col, row in remaining:
            self.add_obstacle_point(*self.centre(col, row))
        self.dirty = False

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
        self.sensor_faults: set[str] = set()   # sensors that have stopped reporting (set through the simulated inputs)
        self._frames, self._captured_at = 0, 0.0
        self.ambient = dict(world.get("ambient") or {"temperatureC": 21.0, "humidityPercent": 45.0})
        self._scan_at = time.time()
        self._clusters: list[dict] = []
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
                {"id": "lidar", "type": "2d-range", "description": f"{LIDAR_BEAMS} beams, {LIDAR_RANGE:.0f} m, simulated by ray casting", "frame": "laser", "rateHz": round(1 / LIDAR_PERIOD, 1), "resolution": f"{LIDAR_BEAMS} beams over 360 degrees", "messageType": "sensor_msgs/msg/LaserScan", "calibration": "none needed (simulated)"},
                {"id": "odometry", "type": "wheel-odometry", "description": "Integrated wheel motion with simulated drift", "frame": "odom", "rateHz": round(1 / DT), "messageType": "nav_msgs/msg/Odometry", "calibration": "none needed (simulated)"},
                {"id": "imu", "type": "imu", "description": "Simulated gyroscope; fused with the wheels for heading", "frame": "imu_link", "rateHz": round(1 / DT), "messageType": "sensor_msgs/msg/Imu", "calibration": "none needed (simulated)"},
                {"id": "environment", "type": "temperature-humidity", "description": "Simulated ambient temperature and humidity", "frame": "base_link", "rateHz": 1, "messageType": "sensor_msgs/msg/Temperature, sensor_msgs/msg/RelativeHumidity"},
                {"id": "bumper", "type": "contact", "description": "Latches a fault on collision", "frame": "base_link", "messageType": "none (a fault flag)"},
                {"id": "battery", "type": "battery", "description": "Simulated charge", "frame": "base_link", "rateHz": 1, "messageType": "sensor_msgs/msg/BatteryState"},
                {"id": "camera", "type": "rgbd-camera", "description": "Simulated forward camera with depth, rendered by ray casting only when a picture is asked for", "frame": "camera_link", "rateHz": 0, "resolution": f"{CAMERA_WIDTH}x{CAMERA_HEIGHT}, {CAMERA_FOV_DEG:.0f} degrees", "messageType": "sensor_msgs/msg/Image, sensor_msgs/msg/CameraInfo", "calibration": "ideal pinhole (simulated); no distortion"},
            ],
            "actuators": [{"id": "drive", "type": "differential-drive", "description": "Two driven wheels, simulated base controller"}],
            "devices": sorted(self.devices),
            "capabilities": ["report_robot_state", "read_sensor", "report_surroundings", "stop_motion", "navigate_to", "return_to_dock", "inspect_area", "set_supported_device_state", "capture_image"],
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
        if "lidar" in self.sensor_faults:
            return  # no new measurement: the last one goes stale and is reported as such
        self._scan_at = time.time()
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
        # Clearing: something found earlier is taken off the map again when the beam that points at it,
        # and the beams on either side, now all see well past where it was.
        for col, row in list(self.grid.discovered):
            cx, cy = self.grid.centre(col, row)
            away = math.hypot(cx - self.odom_x, cy - self.odom_y)
            beam = int(round(wrap(math.atan2(cy - self.odom_y, cx - self.odom_x) - self.odom_yaw) / (2 * math.pi) * LIDAR_BEAMS)) % LIDAR_BEAMS
            if away < LIDAR_RANGE - 0.5 and all(self.ranges[(beam + offset) % LIDAR_BEAMS] > away + 0.3 for offset in (-1, 0, 1)):
                self.grid.clear_point(cx, cy)
        if self.grid.dirty:
            self.grid.rebuild()
            self._replan_due = 0.0

    def capture(self, sensor: str = "camera") -> Frame:
        """Render one frame from where the robot really is. Called only for a capture: nothing is rendered otherwise."""
        if sensor != "camera":
            raise ValueError(f"this robot has no camera called '{sensor}'")
        if "camera" in self.sensor_faults:
            raise RuntimeError("the camera isn't reporting")
        bounds = self.world["bounds"]
        obstacles = self._obstacles()
        half = CAMERA_HEIGHT / 2.0
        columns, depth = [], []
        for col in range(CAMERA_WIDTH):
            offset = math.radians(CAMERA_FOV_DEG * (0.5 - (col + 0.5) / CAMERA_WIDTH))  # the image's left is the robot's left
            angle = self.yaw + offset
            dx, dy = math.cos(angle), math.sin(angle)
            best, colour = ray_bounds(self.x, self.y, dx, dy, bounds), WALL
            for rect in obstacles:
                hit = ray_rect(self.x, self.y, dx, dy, rect)
                if hit is not None and hit < best:
                    best, colour = hit, PALETTE.get(str(rect.get("colour", "")).lower(), GREY)
            seen = best <= CAMERA_RANGE
            depth.append(round(best, 3) if seen else None)
            flat = max(0.05, best * math.cos(offset))  # distance along the optical axis, so walls don't bulge
            shade = max(0.45, 1.0 - best / 12.0)
            columns.append((min(half, CAMERA_HEIGHT * 0.3 / flat) if seen else 0.0, tuple(int(channel * shade) for channel in colour)))
        pixels = []
        for row in range(CAMERA_HEIGHT):
            away = abs(row + 0.5 - half)
            pixels.append([colour if away <= height else (CEILING if row < half else FLOOR) for height, colour in columns])
        self._frames += 1
        self._captured_at = time.time()
        return Frame(
            width=CAMERA_WIDTH, height=CAMERA_HEIGHT, pixels=pixels, sensor="camera", number=self._frames, at_ms=int(self._captured_at * 1000), fov_deg=CAMERA_FOV_DEG,
            source="simulated camera (HANNAH's built-in simulator, ray cast)", depth=depth, depth_source="simulated depth (ray cast)",
            pose={"x": round(self.odom_x, 3), "y": round(self.odom_y, 3), "yaw": round(self.odom_yaw, 4), "frame": "map", "source": "odometry"},
        )

    def _detect(self) -> list[dict]:
        """Group the range sensor's returns into objects. A measurement, not an interpretation:
        each object is the returns that lie together, placed with the pose the robot believes."""
        bounds = self.world["bounds"]
        points = []
        for beam, distance in enumerate(self.ranges):
            if distance >= LIDAR_RANGE - 1e-6:
                points.append(None)
                continue
            angle = self.odom_yaw + (2 * math.pi * beam / LIDAR_BEAMS)
            px, py = self.odom_x + math.cos(angle) * distance, self.odom_y + math.sin(angle) * distance
            if min(px - bounds["minX"], bounds["maxX"] - px, py - bounds["minY"], bounds["maxY"] - py) < 0.15:
                kind = "wall"
            elif any(distance_to_rect(px, py, rect) < 0.15 for rect in self.static):
                kind = "mapped obstacle"
            else:
                kind = "object not on the map"
            points.append((beam, distance, px, py, kind))
        # Start at a gap, so an object straight ahead (around beam 0) isn't cut in two by the end of the list.
        gaps = [index for index, point in enumerate(points) if point is None or point[4] == "wall"]
        if gaps:
            points = points[gaps[0]:] + points[:gaps[0]]
        groups, current = [], []
        for point in points:
            if point is None or point[4] == "wall" or (current and (point[4] != current[-1][4] or math.hypot(point[2] - current[-1][2], point[3] - current[-1][3]) > 0.45)):
                if current:
                    groups.append(current)
                current = []
            if point is not None and point[4] != "wall":
                current.append(point)
        if current:
            groups.append(current)
        found = []
        for group in groups:
            nearest = min(group, key=lambda item: item[1])
            xs, ys = [item[2] for item in group], [item[3] for item in group]
            bearing = 360.0 * nearest[0] / LIDAR_BEAMS
            found.append({
                "kind": group[0][4], "x": round(sum(xs) / len(xs), 2), "y": round(sum(ys) / len(ys), 2),
                "widthM": round(math.hypot(max(xs) - min(xs), max(ys) - min(ys)), 2), "distanceM": round(nearest[1], 2),
                "bearingDeg": round(bearing if bearing <= 180 else bearing - 360, 1), "returns": len(group),
                # More returns on an object, more certainty that it is one. Never 1.
                "confidence": round(min(0.97, 0.45 + 0.13 * len(group)), 2), "sensor": "lidar",
            })
        found.sort(key=lambda item: item["distanceM"])
        unmapped = [item for item in found if item["kind"] == "object not on the map"][:8]
        return unmapped + [item for item in found if item["kind"] == "mapped obstacle"][:6]

    def _changes(self) -> list[dict]:
        """Places where the range sensor found something the map doesn't have, as boxes."""
        cells, boxes = set(self.grid.discovered), []
        while cells and len(boxes) < 10:
            stack, group = [cells.pop()], []
            while stack:
                col, row = stack.pop()
                group.append((col, row))
                # Beams are a few cells apart at range, so cells two apart belong to the same thing.
                for d_col in (-2, -1, 0, 1, 2):
                    for d_row in (-2, -1, 0, 1, 2):
                        neighbour = (col + d_col, row + d_row)
                        if neighbour in cells:
                            cells.remove(neighbour)
                            stack.append(neighbour)
            low_x, low_y = self.grid.centre(min(c for c, _ in group), min(r for _, r in group))
            high_x, high_y = self.grid.centre(max(c for c, _ in group), max(r for _, r in group))
            boxes.append({"x": round(low_x - GRID / 2, 2), "y": round(low_y - GRID / 2, 2), "w": round(high_x - low_x + GRID, 2), "h": round(high_y - low_y + GRID, 2), "cells": len(group), "sensor": "lidar"})
        return sorted(boxes, key=lambda box: -box["cells"])

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

    def _limit(self, key: str, default: float) -> float:
        """The robot's own limit, lowered by a mission's tighter one. describe() keeps reporting the robot's own."""
        own = float(self.limits.get(key, default))
        tighter = getattr(self, "_tightened", {}).get(key)
        return min(own, float(tighter)) if tighter is not None else own

    def tighten_limits(self, limits: dict) -> list[str]:
        supported = ("maxLinearSpeed", "maxAngularSpeed", "maxLinearAccel")
        self._tightened = {key: float(value) for key, value in limits.items() if key in supported}
        return sorted(key for key in limits if key not in supported)

    def _physics(self) -> None:
        max_v = self._limit("maxLinearSpeed", 0.5)
        max_w = self._limit("maxAngularSpeed", 1.5)
        accel = self._limit("maxLinearAccel", 0.8)
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
        # Heading: the wheels alone over- or under-read a turn; the gyroscope has no such scale error.
        # With the IMU working the two are fused, mostly the gyroscope. Without it, wheels only, and it drifts.
        wheel_rate = self.w * (1.0 + self.drift * 2.0)
        if "imu" in self.sensor_faults:
            rate = wheel_rate
        else:
            self._gyro = self.w + (self.random.gauss(0.0, 0.002) if self.w else 0.0)
            rate = 0.98 * self._gyro + 0.02 * wheel_rate
        self.odom_yaw = wrap(self.odom_yaw + rate * DT)
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
        if "lidar" in self.sensor_faults:
            return self._fail("The range sensor stopped reporting. The robot doesn't drive without it.")
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
        accel = self._limit("maxLinearAccel", 0.8)
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
        self._nav_speed = min(float(max_speed), self._limit("maxLinearSpeed", float(max_speed)))
        self._nav_tolerance = float(tolerance)
        self._path, self._replan_due, self._blocked_for = [], 0.0, 0.0
        self._lidar_due = self.sim_time   # plan with what the sensor sees now, not with the last scan
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

    def teleop_velocity(self, linear: float, angular: float) -> tuple[float, float]:
        """An operator's manual command. The simulated base brakes for an obstacle in front as the navigator does,
        and its controller stops on its own after COMMAND_TIMEOUT without a new command."""
        self.cancel_navigation()
        v, w = float(linear), float(angular)
        if v > 0.0:
            accel = self._limit("maxLinearAccel", 0.8)
            clear = self._clear_ahead() - self.radius
            if clear < 0.12 + (v * v) / (2 * accel):
                v = 0.0
        self._drive(v, w)
        return v, w

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
        self.dynamic.append({"name": rect.get("name", "unexpected object"), "x": float(rect["x"]), "y": float(rect["y"]), "w": float(rect["w"]), "h": float(rect["h"]), **({"colour": str(rect["colour"])} if rect.get("colour") else {})})

    def clear_obstacles(self) -> None:
        self.dynamic = []

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
        if isinstance(inputs.get("sensorFaults"), list):
            self.sensor_faults = {str(item) for item in inputs["sensorFaults"]} & {"lidar", "imu", "environment", "battery", "camera"}

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
                self._clusters = self._detect() if "lidar" not in self.sensor_faults else self._clusters
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
    def _sensor_readings(self, nearest: int) -> dict:
        """Each reading says when it was measured and that it is simulated. A sensor that stopped reporting says so and carries no value."""
        now_ms = int(time.time() * 1000)
        down = lambda sensor: {"ok": False, "problem": "not reporting", "source": "simulated"}  # noqa: E731
        scan_ms = int(self._scan_at * 1000)
        return {
            "lidar": down("lidar") if "lidar" in self.sensor_faults else {"ok": True, "source": "simulated", "measuredAt": scan_ms, "beams": LIDAR_BEAMS, "maxRange": LIDAR_RANGE, "minRange": round(self.ranges[nearest], 3), "minBearingDeg": round(360.0 * nearest / LIDAR_BEAMS, 1), "ranges": [round(value, 2) for value in self.ranges]},
            "odometry": {"ok": True, "source": "simulated", "measuredAt": now_ms, "travelled": round(self.travelled, 2)},
            "imu": down("imu") if "imu" in self.sensor_faults else {"ok": True, "source": "simulated", "measuredAt": now_ms, "yawRate": round(getattr(self, "_gyro", 0.0), 4), "unit": "rad/s"},
            "environment": down("environment") if "environment" in self.sensor_faults else {"ok": True, "source": "simulated", "measuredAt": now_ms, "temperatureC": round(float(self.ambient.get("temperatureC", 21.0)), 1), "humidityPercent": round(float(self.ambient.get("humidityPercent", 45.0)), 1)},
            "bumper": {"ok": True, "source": "simulated", "measuredAt": now_ms, "pressed": any(item["code"] == "collision" for item in self.faults)},
            "battery": down("battery") if "battery" in self.sensor_faults else {"ok": True, "source": "simulated", "measuredAt": now_ms, "percent": round(self.battery, 1)},
            # The camera's health only. It holds no image: a frame exists only when a capture was asked for.
            "camera": down("camera") if "camera" in self.sensor_faults else {"ok": True, "source": "simulated", "measuredAt": now_ms, "width": CAMERA_WIDTH, "height": CAMERA_HEIGHT, "fovDeg": CAMERA_FOV_DEG, "framesCaptured": self._frames, "lastCapturedAt": int(self._captured_at * 1000) if self._captured_at else None},
        }

    def _perception(self) -> dict:
        """What the sensors detect, with where each item came from. No model is involved."""
        lidar_ok = "lidar" not in self.sensor_faults
        waiting = self._goal is not None and self._blocked_for > 0.1
        gave_up = self._goal is None and self._nav.state == "failed" and self._nav.reason.startswith(("No path", "Blocked"))
        blocked = waiting or gave_up
        return {
            "measuredAt": int(self._scan_at * 1000), "sensor": "lidar", "source": "simulated range sensor",
            "obstacles": list(self._clusters) if lidar_ok else [],
            "obstaclesKnown": lidar_ok,
            "route": {"blocked": blocked, "reason": f"The last goal was given up: {self._nav.reason}" if gave_up else "Something the range sensor sees is in the robot's path." if blocked else ("No route is being followed." if self._goal is None else "Clear ahead.")} if lidar_ok else {"blocked": None, "reason": "Unknown: the range sensor isn't reporting."},
            "changes": self._changes(),
            "sensorHealth": [{"id": name, "ok": name not in self.sensor_faults, **({"problem": "not reporting"} if name in self.sensor_faults else {})} for name in ("lidar", "odometry", "imu", "environment", "bumper", "battery", "camera")],
        }

    def state(self) -> dict:
        nearest = min(range(LIDAR_BEAMS), key=lambda index: self.ranges[index])
        path = [(self.odom_x, self.odom_y), *self._path] if self._goal else []
        stride = max(1, len(path) // 40)
        return {
            "pose": {"x": round(self.odom_x, 3), "y": round(self.odom_y, 3), "yaw": round(self.odom_yaw, 4), "frame": "map", "source": "odometry", "heading": "wheels only (IMU not reporting)" if "imu" in self.sensor_faults else "wheels fused with the IMU"},
            "velocity": {"linear": round(self.v, 3), "angular": round(self.w, 3)},
            "battery": None if "battery" in self.sensor_faults else {"percent": round(self.battery, 1), "charging": bool(getattr(self, "_docked", False))},
            "estop": {"engaged": self.estop, "source": "simulated-hardware"},
            "motorsEnabled": not self.estop and not self.faults and self.battery > 0.0,
            "localized": True,
            "docked": bool(getattr(self, "_docked", False)),
            "faults": list(self.faults),
            "sensors": self._sensor_readings(nearest),
            "perception": self._perception(),
            "devices": dict(self.devices),
            "nav": {"goal": self._goal, "path": [[round(p[0], 2), round(p[1], 2)] for p in path[::stride]], "status": self._nav.state},
            "map": {"coveragePercent": round(self.grid.coverage(), 1), "discovered": [[round(v, 2) for v in self.grid.centre(*cell)] for cell in sorted(self.grid.discovered)[:120]]},
            "sim": {
                "kind": "hannah-kinematic", "timeFactor": self.time_factor, "time": round(self.sim_time, 2),
                "truth": {"x": round(self.x, 3), "y": round(self.y, 3), "yaw": round(self.yaw, 4)},
                "odometryError": round(math.hypot(self.x - self.odom_x, self.y - self.odom_y), 3),
            },
        }
