"""Simulation tests: HANNAH's built-in planar arm simulator and the runtime driving it.

Not MoveIt 2, not Gazebo, not a physical arm.
"""
import json
import math
import os
import unittest

from hannah_robot.hal.arm import DT, ArmSimAdapter, forward
from hannah_robot.profile import local_safety
from hannah_robot.protocol import CommandGuard
from hannah_robot.runtime import Runtime

from .helpers import ROBOT_ID, SECRET, WORLD_PATH, Bench

BENCH = os.path.join(os.path.dirname(WORLD_PATH), "bench.json")


def arm():
    with open(BENCH, "r", encoding="utf-8") as handle:
        return ArmSimAdapter(json.load(handle), {"maxJointSpeed": 1.2, "linkTimeoutS": 5, "commandTtlS": 20})


def settle(sim, limit=30.0):
    waited, fastest, touched = 0.0, 0.0, ""
    while sim.arm_status().state == "active" and waited < limit:
        sim.advance(DT)
        waited += DT
        fastest = max(fastest, max(abs(speed) for speed in sim.speeds))
        touched = touched or sim._collides(sim.joints)
    return sim.arm_status(), fastest, touched


class Kinematics(unittest.TestCase):
    def test_inverse_kinematics_puts_the_tool_where_it_was_asked_inside_the_joint_limits(self):
        sim = arm()
        for x, y in [(0.6, 0.0), (0.55, 0.3), (0.25, -0.5), (0.3, 0.45), (0.1, 0.6)]:
            solutions = sim.solve(x, y)
            self.assertTrue(solutions, (x, y))
            for joints in solutions:
                tool = forward(sim.links, joints)[0][-1]
                self.assertAlmostEqual(tool[0], x, places=6)
                self.assertAlmostEqual(tool[1], y, places=6)
                for value, (low, high) in zip(joints, sim.joint_limits):
                    self.assertTrue(low <= value <= high)
                self.assertEqual(sim._collides(joints), "")
        self.assertEqual(sim.solve(1.5, 0.0), [], "out of reach")

    def test_reaches_every_pose_within_the_joint_speed_limit_and_never_touches_the_fixture(self):
        sim = arm()
        places = sim.describe()["places"]
        self.assertEqual(sorted(places), ["bin", "home", "inspection"])
        for name in ["inspection", "bin", "home", "bin", "inspection"]:
            sim.move_arm(places[name])
            status, fastest, touched = settle(sim)
            self.assertEqual(status.state, "succeeded", f"{name}: {status.reason}")
            self.assertLessEqual(fastest, 1.2 + 1e-6, name)
            self.assertEqual(touched, "", name)
            self.assertLess(math.hypot(sim.tool()[0] - places[name]["x"], sim.tool()[1] - places[name]["y"]), 1e-6)
            self.assertEqual(sim.speeds, [0.0, 0.0, 0.0])

    def test_refuses_what_it_cannot_do_safely_before_moving(self):
        sim = arm()
        start = list(sim.joints)
        for target, reason in [({"x": 0.55, "y": -0.26}, "touching a fixture"), ({"x": 2.0, "y": 0.0}, "outside the arm's workspace"), ({"x": 0.84, "y": 0.6}, "can't reach")]:
            sim.move_arm(target)
            self.assertEqual(sim.arm_status().state, "failed", target)
            self.assertIn(reason, sim.arm_status().reason)
        sim.advance(1.0)
        self.assertEqual(sim.joints, start, "a refused motion moves nothing")

    def test_emergency_stop_freezes_the_joints_and_nothing_resumes(self):
        sim = arm()
        sim.move_arm(sim.describe()["places"]["bin"])
        sim.advance(1.0)
        self.assertGreater(max(abs(speed) for speed in sim.speeds), 0.1)
        sim.press_estop(True)
        sim.advance(DT)
        frozen = list(sim.joints)
        self.assertEqual(sim.speeds, [0.0, 0.0, 0.0])
        self.assertIn("emergency stop", sim.arm_status().reason)
        sim.press_estop(False)
        sim.advance(3.0)
        self.assertEqual(sim.joints, frozen)

    def test_the_gripper_holds_only_what_is_really_between_its_fingers(self):
        sim = arm()
        sim.grasp("red block")   # the tool is nowhere near it
        status, _, _ = settle(sim)
        self.assertEqual(status.state, "failed")
        self.assertIn("closed on nothing", status.reason)
        self.assertIsNone(sim.holding)
        sim.release()
        settle(sim)
        sim.move_arm({"x": 0.55, "y": 0.3})
        settle(sim)
        sim.grasp("green block")
        self.assertIn("no such object", settle(sim)[0].reason)
        sim.release()
        settle(sim)
        sim.grasp("red block")
        self.assertEqual(settle(sim)[0].state, "succeeded")
        self.assertEqual(sim.state()["gripper"], {"open": False, "holding": "red block"})
        sim.grasp("blue block")
        self.assertIn("already holding red block", sim.arm_status().reason)

    def test_pick_and_place(self):
        sim = arm()
        sim.move_arm({"x": 0.55, "y": 0.3})
        settle(sim)
        sim.grasp("red block")
        settle(sim)
        sim.move_arm(sim.describe()["places"]["bin"])
        status, fastest, touched = settle(sim)
        self.assertEqual((status.state, touched), ("succeeded", ""))
        self.assertLessEqual(fastest, 1.2 + 1e-6)
        carried = next(item for item in sim.state()["scene"]["objects"] if item["id"] == "red block")
        self.assertTrue(carried["held"])
        sim.release()
        settle(sim)
        placed = next(item for item in sim.state()["scene"]["objects"] if item["id"] == "red block")
        self.assertEqual((placed["x"], placed["y"], placed["held"]), (0.25, -0.5, False))
        self.assertEqual(sim.state()["scene"]["source"], "the simulator's own scene (not a camera)")


class ArmBench(Bench):
    def __init__(self):
        self.now = 1_800_000_000.0
        self.sim = arm()
        self.guard = CommandGuard(SECRET, ROBOT_ID)
        self.runtime = Runtime(self.sim, self.guard, local_safety(self.sim), link_timeout=5.0, clock=lambda: self.now)
        self.seq = 0
        self.sent = []


class RuntimeWithAnArm(unittest.TestCase):
    def test_a_pick_and_place_as_three_signed_missions(self):
        bench = ArmBench()
        steps = [("move_robot_arm", {"x": 0.55, "y": 0.3}), ("grasp_object", {"object": "red block"}), ("move_robot_arm", {"x": 0.25, "y": -0.5}), ("release_object", {})]
        for capability, params in steps:
            command = bench.command(capability, params, timeout=60)
            bench.exchange(command)
            bench.run(0.3)
            if capability == "move_robot_arm":
                self.assertEqual(bench.state()["mode"], "manipulating")
            bench.run(20.0, until=lambda: bench.runtime._active is None)
            bench.run(1.2)
            self.assertEqual(bench.statuses(command["missionId"]), ["accepted", "succeeded"], capability)
        state = bench.state()
        self.assertEqual(state["gripper"], {"open": True, "holding": None})
        self.assertEqual([(item["x"], item["y"]) for item in state["scene"]["objects"] if item["id"] == "red block"], [(0.25, -0.5)])
        self.assertEqual(state["pose"]["source"], "joint encoders (forward kinematics)")

    def test_the_robots_own_checks_refuse_targets_outside_its_limits_and_an_empty_release(self):
        bench = ArmBench()
        for capability, params, reason in [
            ("move_robot_arm", {"x": 3.0, "y": 0.0}, "outside this robot's workspace"),
            ("move_robot_arm", {"x": -0.15, "y": 0.2}, "keep-out zone 'operator side'"),
            ("move_robot_arm", {"x": 0.55, "y": -0.26}, "obstacle 'fixture'"),
            ("release_object", {}, "isn't holding anything"),
            ("grasp_object", {}, "no object was named"),
            ("navigate_to", {"x": 0.3, "y": 0.3}, "doesn't offer 'navigate_to'"),
            ("set_joint_torque", {"joint": 1, "value": 9}, "doesn't offer"),
        ]:
            command = bench.command(capability, params)
            bench.exchange(command)
            bench.run(1.2)
            report = bench.reports(command["missionId"])[-1]
            self.assertEqual(report["status"], "rejected", capability)
            self.assertIn(reason, report["reason"])
        self.assertEqual(bench.sim.joints, bench.sim.home)

    def test_a_grasp_that_closes_on_nothing_is_a_failure_and_stop_freezes_a_moving_arm(self):
        bench = ArmBench()
        miss = bench.command("grasp_object", {"object": "blue block"})
        bench.exchange(miss)
        bench.run(3.0)
        self.assertEqual(bench.statuses(miss["missionId"]), ["accepted", "failed"])
        self.assertIn("closed on nothing", bench.reports(miss["missionId"])[-1]["reason"])
        move = bench.command("move_robot_arm", {"x": 0.25, "y": -0.5}, timeout=60)
        bench.exchange(move)
        bench.run(1.5)
        self.assertGreater(bench.state()["velocity"]["angular"], 0.1)
        stop = bench.command("stop_motion")
        bench.exchange(stop)
        bench.run(2.0)
        self.assertEqual(bench.statuses(move["missionId"]), ["accepted", "cancelled"])
        self.assertEqual(bench.statuses(stop["missionId"]), ["accepted", "succeeded"])
        self.assertEqual(bench.sim.speeds, [0.0, 0.0, 0.0])
        # A second arm motion can't start while one runs.
        first = bench.command("move_robot_arm", {"x": 0.6, "y": 0.0}, timeout=60)
        second = bench.command("move_robot_arm", {"x": 0.25, "y": -0.5})
        bench.exchange(first)
        bench.run(0.2)
        bench.exchange(second)
        bench.run(1.2)
        self.assertIn("another motion mission is running", bench.reports(second["missionId"])[-1]["reason"])


if __name__ == "__main__":
    unittest.main()
