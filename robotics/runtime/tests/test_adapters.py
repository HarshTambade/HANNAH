"""Unit tests: the hardware abstraction layer's contract, and the parts of the ROS 2 adapter that need no ROS.

Nothing here starts ROS 2, Gazebo or Nav2. The ROS 2 adapter's connection,
subscriptions and navigation calls are NOT covered by any test in this
repository; they have never been run.
"""
import importlib.util
import inspect
import os
import subprocess
import sys
import unittest

from hannah_robot.hal.base import NavigationStatus, RobotAdapter
from hannah_robot.hal.kinematic import KinematicSimAdapter
from hannah_robot.profile import ProfileError, build_adapter, descriptor, load_profile, local_safety
from hannah_robot.runtime import Runtime

from .helpers import Bench

HERE = os.path.dirname(os.path.abspath(__file__))
ROBOTICS = os.path.normpath(os.path.join(HERE, "..", ".."))
ROS_PROFILE = os.path.join(ROBOTICS, "ros2_ws", "src", "hannah_sim", "config", "hannah_profile.json")
SIM_PROFILE = os.path.join(ROBOTICS, "profiles", "sim-diffdrive.json")
HAS_ROS = importlib.util.find_spec("rclpy") is not None


class Contract(unittest.TestCase):
    def test_the_interface_has_no_way_to_command_an_actuator(self):
        names = {name for name, _ in inspect.getmembers(RobotAdapter, predicate=inspect.isfunction)}
        self.assertEqual(names, {"describe", "state", "start", "step", "close", "navigate", "navigation_status", "cancel_navigation", "hold", "heartbeat", "set_device", "acknowledge_fault"})
        for forbidden in ("velocity", "pwm", "torque", "effort", "wheel", "motor", "joint"):
            self.assertFalse(any(forbidden in name for name in names), forbidden)

    def test_both_adapters_implement_it(self):
        from hannah_robot.hal.ros2 import Ros2Adapter
        for adapter in (KinematicSimAdapter, Ros2Adapter):
            self.assertTrue(issubclass(adapter, RobotAdapter))
            self.assertFalse(getattr(adapter, "__abstractmethods__", None), adapter.__name__)

    def test_a_profile_decides_the_adapter_and_whether_it_is_a_simulation(self):
        sim = build_adapter(load_profile(SIM_PROFILE))
        self.assertEqual((sim.name, descriptor(load_profile(SIM_PROFILE), sim)["simulation"]["kind"]), ("kinematic", "hannah-kinematic"))
        ros = build_adapter(load_profile(ROS_PROFILE))
        described = descriptor(load_profile(ROS_PROFILE), ros)
        self.assertEqual((ros.name, described["simulation"]["kind"]), ("ros2", "gazebo-harmonic"))
        # Same room, same limits, whichever simulator runs it.
        self.assertEqual(described["places"], descriptor(load_profile(SIM_PROFILE), sim)["places"])
        self.assertEqual(described["limits"]["maxLinearSpeed"], 0.5)
        self.assertEqual(described["limits"]["workspace"]["polygon"][0], [-5.0, -4.0])
        # A robot arm, a camera or a raw actuator is not something this adapter claims.
        self.assertEqual(described["capabilities"], ["report_robot_state", "read_sensor", "stop_motion", "navigate_to", "return_to_dock", "inspect_area"])
        self.assertTrue(local_safety(ros).check("navigate_to", {"x": 3.1, "y": 1.9}, {"faults": [], "battery": None}).ok)
        self.assertIn("workspace", local_safety(ros).check("navigate_to", {"x": 30, "y": 0}, {"faults": []}).reason)

    def test_a_bad_profile_is_refused_with_the_reason(self):
        with self.assertRaisesRegex(ProfileError, "can't be read"):
            load_profile(os.path.join(HERE, "no-such-profile.json"))
        with self.assertRaisesRegex(ProfileError, "adapter must be"):
            path = os.path.join(HERE, "__bad_profile.json")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write('{"adapter": "teleport"}')
            try:
                load_profile(path)
            finally:
                os.remove(path)

    @unittest.skipIf(HAS_ROS, "ROS 2 is installed here; this checks the message for a computer without it")
    def test_the_ros2_adapter_says_plainly_that_it_needs_ros(self):
        ran = subprocess.run([sys.executable, "-m", "hannah_robot", "run", "--profile", ROS_PROFILE, "--state-dir", os.path.join(HERE, "__no_state")], cwd=os.path.join(ROBOTICS, "runtime"), capture_output=True, text=True, timeout=30)
        # Not enrolled comes first; with credentials it would stop at the missing ROS environment.
        self.assertEqual(ran.returncode, 2)
        self.assertIn("isn't enrolled yet", ran.stderr)
        os.rmdir(os.path.join(HERE, "__no_state"))

    def test_the_generated_gazebo_world_and_map_match_the_world_file(self):
        ran = subprocess.run([sys.executable, os.path.join(ROBOTICS, "tools", "build_world.py"), "--check"], capture_output=True, text=True, timeout=60)
        self.assertEqual(ran.returncode, 0, ran.stderr)


class FailingNavigation(unittest.TestCase):
    def test_an_adapter_that_cannot_take_a_goal_fails_the_mission_and_the_runtime_keeps_running(self):
        bench = Bench()

        def refuse(goal, max_speed, tolerance):
            raise ConnectionError("navigation stack is down")

        bench.sim.navigate = refuse
        command = bench.command("navigate_to", {"x": 3.1, "y": 1.9, "tolerance": 0.25})
        bench.exchange(command)
        bench.run(2.0)
        self.assertEqual(bench.statuses(command["missionId"]), ["accepted", "failed"])
        self.assertIn("didn't take the goal (ConnectionError)", bench.reports(command["missionId"])[-1]["reason"])
        self.assertEqual(bench.sim.travelled, 0.0)
        self.assertIsInstance(bench.runtime, Runtime)
        self.assertEqual(bench.state()["mode"], "docked")
        self.assertIsInstance(bench.sim.navigation_status(), NavigationStatus)


if __name__ == "__main__":
    unittest.main()
