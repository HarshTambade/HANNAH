"""The ROS 2 adapter: any robot that runs Nav2, in Gazebo or on hardware.

STATUS: written against ROS 2 Jazzy's interfaces and NOT YET RUN, in simulation
or on a robot. Treat every line as unverified until robotics/README.md's
Gazebo check passes.

What it uses, all standard interfaces, so the same adapter serves a simulated
robot and a physical one:

  nav_msgs/Odometry on the odometry topic          speed, and position when there is no map
  tf2 (map → base frame)                           position on the map, and whether the robot is localized
  sensor_msgs/LaserScan                            range readings
  sensor_msgs/BatteryState (optional)              battery
  std_msgs/Bool on an emergency-stop topic (opt.)  the state of the robot's hardware emergency stop, read only
  nav2_msgs/action/NavigateToPose                  goals, feedback, cancellation
  nav2_msgs/SpeedLimit                             a lower speed for one mission

What it never does: it does not publish velocity to drive the robot, set a
controller parameter, enable motors or clear an emergency stop. The only
velocity it ever publishes is zero, for a hold.

This adapter also publishes a heartbeat. hal/ros2_watchdog.py is a separate
process that cancels navigation and zeroes the velocity if that heartbeat
stops, so a crashed runtime doesn't leave a mission running unsupervised.
"""
from __future__ import annotations

import math
import os
import threading
import time

from .base import NavigationStatus, RobotAdapter

STALE_ODOMETRY_S = 1.5
STALE_SCAN_S = 3.0
BEAMS = 72


def _yaw(q) -> float:
    return math.atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z))


class Ros2Adapter(RobotAdapter):
    name = "ros2"

    def __init__(self, profile: dict):
        self.profile = profile
        self.ros = profile.get("ros") or {}
        self.topics = self.ros.get("topics") or {}
        self.limits = dict(profile.get("limits") or {})
        self.world = None
        if profile.get("world"):
            from ..profile import _world  # the same world file the built-in simulator reads, when there is one
            self.world = _world(profile)
        self._lock = threading.Lock()
        self._odom = None
        self._odom_at = 0.0
        self._scan = None
        self._scan_at = 0.0
        self._battery = None
        self._estop = None
        self._goal_handle = None
        self._result = NavigationStatus()
        self._travel = 0.0
        self._last_xy = None
        self._goal_start = 0.0
        self._node = None

    # ---------------- description ----------------
    def describe(self) -> dict:
        world = self.world or {}
        bounds = world.get("bounds")
        workspace = self.limits.get("workspace")
        if not workspace and bounds:
            workspace = {"frame": "map", "polygon": [[bounds["minX"], bounds["minY"]], [bounds["maxX"], bounds["minY"]], [bounds["maxX"], bounds["maxY"]], [bounds["minX"], bounds["maxY"]]]}
        sensors = [{"id": "lidar", "type": "2d-range", "description": f"sensor_msgs/LaserScan on {self.topics.get('scan', '/scan')}"}, {"id": "odometry", "type": "wheel-odometry", "description": f"nav_msgs/Odometry on {self.topics.get('odom', '/odom')}"}]
        if self.topics.get("battery"):
            sensors.append({"id": "battery", "type": "battery", "description": f"sensor_msgs/BatteryState on {self.topics['battery']}"})
        estop_topic = self.topics.get("estop")
        return {
            "robotType": (self.profile.get("identity") or {}).get("robotType", "differential-drive"),
            "rosDistro": os.environ.get("ROS_DISTRO", ""),
            "protocols": ["hannah-robot-v1", "ros2", "nav2"],
            "sensors": sensors,
            "actuators": [{"id": "drive", "type": "mobile-base", "description": "Driven by the robot's own controller through Nav2"}],
            "devices": [],
            "capabilities": ["report_robot_state", "read_sensor", "stop_motion", "navigate_to", "return_to_dock", "inspect_area"],
            "places": self.profile.get("places") or world.get("places", {}),
            "dock": self.profile.get("dock") or world.get("dock"),
            "world": {"name": world.get("name", "map"), "bounds": bounds, "obstacles": [{"name": r.get("name", "obstacle"), "x": r["x"], "y": r["y"], "w": r["w"], "h": r["h"]} for r in world.get("obstacles", [])]} if bounds else None,
            "limits": {
                **{key: self.limits[key] for key in ("maxLinearSpeed", "maxAngularSpeed", "maxLinearAccel", "minBatteryPercent", "linkTimeoutS", "commandTtlS", "environment") if key in self.limits},
                "robotRadius": (self.profile.get("robot") or {}).get("radius", 0.2),
                "workspace": workspace,
                "keepOut": self.limits.get("keepOut") or world.get("keepOut", []),
                "estop": {"hardware": bool(estop_topic) and not self.ros.get("simulation"), "description": f"State read from {estop_topic}" if estop_topic else "Not monitored by HANNAH's runtime."},
            },
            "simulation": self.ros.get("simulation") or None,
        }

    # ---------------- connection ----------------
    def start(self) -> None:
        import rclpy
        from geometry_msgs.msg import PoseWithCovarianceStamped, Twist
        from nav2_msgs.action import NavigateToPose
        from nav2_msgs.msg import SpeedLimit
        from nav_msgs.msg import Odometry
        from rclpy.action import ActionClient
        from rclpy.executors import MultiThreadedExecutor
        from rclpy.parameter import Parameter
        from rclpy.qos import qos_profile_sensor_data
        from sensor_msgs.msg import BatteryState, LaserScan
        from std_msgs.msg import Bool, Empty
        from tf2_ros import Buffer, TransformListener

        sim_time = bool(self.ros.get("useSimTime"))
        # A profile that says "simulation" must be running on simulated time, and the reverse: the
        # registry treats the two very differently, so they can't be allowed to disagree.
        if bool(self.ros.get("simulation")) != sim_time:
            raise RuntimeError("The profile's ros.simulation and ros.useSimTime disagree. A simulated robot uses simulated time; a physical one doesn't.")
        rclpy.init()
        node = rclpy.create_node("hannah_robot_bridge", parameter_overrides=[Parameter("use_sim_time", Parameter.Type.BOOL, sim_time)])
        self._node = node
        self._types = {"Twist": Twist, "SpeedLimit": SpeedLimit, "NavigateToPose": NavigateToPose, "Pose": PoseWithCovarianceStamped, "Empty": Empty}
        self._tf = Buffer()
        self._tf_listener = TransformListener(self._tf, node)
        node.create_subscription(Odometry, self.topics.get("odom", "/odom"), self._on_odom, 10)
        node.create_subscription(LaserScan, self.topics.get("scan", "/scan"), self._on_scan, qos_profile_sensor_data)
        if self.topics.get("battery"):
            node.create_subscription(BatteryState, self.topics["battery"], self._on_battery, 10)
        if self.topics.get("estop"):
            node.create_subscription(Bool, self.topics["estop"], self._on_estop, 10)
        self._cmd = node.create_publisher(Twist, self.topics.get("cmdVel", "/cmd_vel"), 10)
        self._speed = node.create_publisher(SpeedLimit, self.topics.get("speedLimit", "/speed_limit"), 10)
        self._beat = node.create_publisher(Empty, self.topics.get("heartbeat", "/hannah/heartbeat"), 10)
        self._initial = node.create_publisher(PoseWithCovarianceStamped, self.topics.get("initialPose", "/initialpose"), 10)
        self._navigator = ActionClient(node, NavigateToPose, self.ros.get("navigateAction", "navigate_to_pose"))
        self._executor = MultiThreadedExecutor(num_threads=2)
        self._executor.add_node(node)
        self._thread = threading.Thread(target=self._executor.spin, name="hannah-ros", daemon=True)
        self._thread.start()
        self._rclpy = rclpy
        if self.ros.get("publishInitialPose"):
            self._publish_initial_pose()

    def _publish_initial_pose(self) -> None:
        """Tell the localizer where the robot starts (a known, surveyed start position)."""
        start = (self.world or {}).get("start") or self.profile.get("start")
        if not start:
            return
        message = self._types["Pose"]()
        message.header.frame_id = self.ros.get("mapFrame", "map")
        message.pose.pose.position.x = float(start["x"])
        message.pose.pose.position.y = float(start["y"])
        yaw = float(start.get("yaw", 0.0))
        message.pose.pose.orientation.z = math.sin(yaw / 2.0)
        message.pose.pose.orientation.w = math.cos(yaw / 2.0)
        message.pose.covariance[0] = message.pose.covariance[7] = 0.05
        message.pose.covariance[35] = 0.03
        for _ in range(5):
            message.header.stamp = self._node.get_clock().now().to_msg()
            self._initial.publish(message)
            time.sleep(0.5)

    def close(self) -> None:
        if self._node is None:
            return
        try:
            self._executor.shutdown(timeout_sec=1.0)
            self._node.destroy_node()
            self._rclpy.shutdown()
        except Exception:  # noqa: BLE001 - shutting down; nothing useful to do with a failure here
            pass
        self._node = None

    # ---------------- subscriptions ----------------
    def _on_odom(self, message) -> None:
        with self._lock:
            position = message.pose.pose.position
            if self._last_xy is not None:
                self._travel += math.hypot(position.x - self._last_xy[0], position.y - self._last_xy[1])
            self._last_xy = (position.x, position.y)
            self._odom, self._odom_at = message, time.monotonic()

    def _on_scan(self, message) -> None:
        with self._lock:
            self._scan, self._scan_at = message, time.monotonic()

    def _on_battery(self, message) -> None:
        with self._lock:
            self._battery = message

    def _on_estop(self, message) -> None:
        with self._lock:
            self._estop = bool(message.data)

    # ---------------- state ----------------
    def _map_pose(self):
        try:
            from rclpy.time import Time
            transform = self._tf.lookup_transform(self.ros.get("mapFrame", "map"), self.ros.get("baseFrame", "base_footprint"), Time())
        except Exception:  # noqa: BLE001 - no transform yet means "not localized", which is reported as such
            return None
        t = transform.transform
        return {"x": round(t.translation.x, 3), "y": round(t.translation.y, 3), "yaw": round(_yaw(t.rotation), 4), "frame": self.ros.get("mapFrame", "map"), "source": "map localization (tf)"}

    def state(self) -> dict:
        now = time.monotonic()
        with self._lock:
            odom, odom_age = self._odom, now - self._odom_at
            scan, scan_age = self._scan, now - self._scan_at
            battery, estop = self._battery, self._estop
        faults = []
        if odom is None or odom_age > STALE_ODOMETRY_S:
            faults.append({"code": "odometry-stale", "message": "No odometry from the robot's controller."})
        pose = self._map_pose() if self._node is not None else None
        localized = pose is not None
        if pose is None and odom is not None:
            p = odom.pose.pose
            pose = {"x": round(p.position.x, 3), "y": round(p.position.y, 3), "yaw": round(_yaw(p.orientation), 4), "frame": "odom", "source": "odometry (not on the map)"}
        lidar = {"ok": False}
        if scan is not None and scan_age <= STALE_SCAN_S and len(scan.ranges):
            step = max(1, len(scan.ranges) // BEAMS)
            # Beam 0 of the report points straight ahead, like the built-in simulator's.
            order = sorted(range(0, len(scan.ranges), step), key=lambda index: (scan.angle_min + index * scan.angle_increment) % (2 * math.pi))
            ranges = [scan.ranges[index] if math.isfinite(scan.ranges[index]) else scan.range_max for index in order]
            nearest = min(range(len(ranges)), key=lambda index: ranges[index])
            lidar = {"ok": True, "beams": len(ranges), "maxRange": round(scan.range_max, 2), "minRange": round(ranges[nearest], 3), "minBearingDeg": round(360.0 * nearest / len(ranges), 1), "ranges": [round(value, 2) for value in ranges]}
        velocity = {"linear": round(odom.twist.twist.linear.x, 3), "angular": round(odom.twist.twist.angular.z, 3)} if odom is not None else {"linear": 0.0, "angular": 0.0}
        navigator_ready = bool(self._node is not None and self._navigator.server_is_ready())
        return {
            "pose": pose, "velocity": velocity,
            "battery": None if battery is None else {"percent": round(battery.percentage * 100.0, 1), "charging": battery.power_supply_status == 1},
            "estop": {"engaged": bool(estop), "source": "hardware topic" if self.topics.get("estop") else "not monitored"},
            "motorsEnabled": not bool(estop),
            "localized": localized,
            "faults": faults,
            "sensors": {"lidar": lidar, "odometry": {"ok": not faults, "travelled": round(self._travel, 2)}, **({"battery": {"ok": True, "percent": round(battery.percentage * 100.0, 1)}} if battery is not None else {})},
            "devices": {},
            "nav": {"goal": getattr(self, "_goal", None), "status": self._result.state},
            "ros": {"distro": os.environ.get("ROS_DISTRO", ""), "navigatorReady": navigator_ready, "simTime": bool(self.ros.get("useSimTime"))},
            **({"sim": {"kind": self.ros["simulation"].get("kind", "simulation")}} if self.ros.get("simulation") else {}),
        }

    # ---------------- operations ----------------
    def heartbeat(self) -> None:
        if self._node is not None:
            self._beat.publish(self._types["Empty"]())

    def navigate(self, goal: dict, max_speed: float, tolerance: float) -> None:
        if not self._navigator.server_is_ready():
            self._result = NavigationStatus("failed", "The robot's navigation stack (Nav2) isn't running.")
            return
        limit = self._types["SpeedLimit"]()
        limit.percentage = False
        limit.speed_limit = float(max_speed)
        self._speed.publish(limit)
        request = self._types["NavigateToPose"].Goal()
        request.pose.header.frame_id = self.ros.get("mapFrame", "map")
        request.pose.header.stamp = self._node.get_clock().now().to_msg()
        request.pose.pose.position.x = float(goal["x"])
        request.pose.pose.position.y = float(goal["y"])
        yaw = float(goal.get("yaw") or 0.0)
        request.pose.pose.orientation.z = math.sin(yaw / 2.0)
        request.pose.pose.orientation.w = math.cos(yaw / 2.0)
        self._goal = {"x": float(goal["x"]), "y": float(goal["y"])}
        self._goal_start = self._travel
        self._result = NavigationStatus("active", "", math.hypot(goal["x"] - (self._last_xy or (goal["x"], goal["y"]))[0], goal["y"] - (self._last_xy or (goal["x"], goal["y"]))[1]))
        future = self._navigator.send_goal_async(request, feedback_callback=self._on_feedback)
        future.add_done_callback(self._on_goal_response)

    def _on_feedback(self, message) -> None:
        if self._result.state == "active":
            self._result = NavigationStatus("active", "", float(message.feedback.distance_remaining), self._travel - self._goal_start)

    def _on_goal_response(self, future) -> None:
        handle = future.result()
        if not handle.accepted:
            self._result = NavigationStatus("failed", "Nav2 refused the goal.")
            return
        self._goal_handle = handle
        handle.get_result_async().add_done_callback(self._on_result)

    def _on_result(self, future) -> None:
        status = future.result().status  # action_msgs/GoalStatus: 4 succeeded, 5 canceled, 6 aborted
        travelled = self._travel - self._goal_start
        if status == 4:
            self._result = NavigationStatus("succeeded", "", 0.0, travelled)
        elif status == 5:
            self._result = NavigationStatus("cancelled", "Cancelled.", travelled=travelled)
        else:
            self._result = NavigationStatus("failed", "Nav2 aborted the goal: no path, or the robot is blocked.", travelled=travelled)
        self._goal_handle = None
        self._goal = None

    def navigation_status(self) -> NavigationStatus:
        return self._result

    def cancel_navigation(self) -> None:
        handle = self._goal_handle
        if handle is not None:
            handle.cancel_goal_async()

    def hold(self) -> None:
        self.cancel_navigation()
        if self._node is None:
            return
        zero = self._types["Twist"]()
        for _ in range(5):
            self._cmd.publish(zero)
            time.sleep(0.02)
