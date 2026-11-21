"""Simulation and unit tests for pause and resume, sensors, perception and scenarios.

HANNAH's built-in kinematic simulator only. Not Gazebo, not hardware.
"""
import glob
import json
import math
import os
import unittest

from hannah_robot.hal.kinematic import DT
from hannah_robot.protocol import CommandGuard, fingerprint, sign_command
from hannah_robot.scenarios import DEFAULT_DIR, run_scenario

from .helpers import ROBOT_ID, SECRET, Bench, simulator, world

PLACES = world()["places"]
NOW = 1_800_000_000_000


def goal(name, **extra):
    return {"x": PLACES[name]["x"], "y": PLACES[name]["y"], "tolerance": 0.25, **extra}


class Identity(unittest.TestCase):
    def test_fingerprint_matches_the_server(self):
        # The same value is asserted in server/robotics.stage2.test.js against the server's code.
        self.assertEqual(fingerprint(SECRET), "F86E CC32 9E7A BDAB")


class PauseAndResumeCommands(unittest.TestCase):
    def setUp(self):
        self.guard = CommandGuard(SECRET, ROBOT_ID)
        payload = json.dumps({"v": 1, "type": "mission", "robotId": ROBOT_ID, "missionId": "ms_a", "seq": 1, "nonce": "n1", "capability": "navigate_to", "params": {}, "issuedAt": NOW, "expiresAt": NOW + 20_000})
        self.assertTrue(self.guard.check(payload, sign_command(SECRET, payload), NOW).ok)

    def signed(self, **body):
        payload = json.dumps({"v": 1, "robotId": ROBOT_ID, "missionId": "ms_a", **body})
        return payload, sign_command(SECRET, payload)

    def test_a_pause_needs_only_a_known_mission(self):
        self.assertTrue(self.guard.check(*self.signed(type="pause", issuedAt=NOW), NOW + 999_999).ok)
        self.assertEqual(self.guard.check(*self.signed(type="pause", missionId="ms_other"), NOW).reason, "unknown-mission")

    def test_a_resume_expires_and_works_once(self):
        resume = self.signed(type="resume", nonce="r1", issuedAt=NOW, expiresAt=NOW + 20_000)
        self.assertEqual(self.guard.check(*resume, NOW + 20_000).reason, "expired")
        first = self.guard.check(*resume, NOW + 1000)
        self.assertTrue(first.ok and not first.duplicate)
        again = self.guard.check(*resume, NOW + 2000)
        self.assertTrue(again.ok and again.duplicate, "a replayed resume is recognised, not acted on")
        self.assertEqual(self.guard.check(*self.signed(type="resume", issuedAt=NOW), NOW).reason, "malformed")
        payload, _ = self.signed(type="resume", nonce="r2", issuedAt=NOW, expiresAt=NOW + 20_000)
        self.assertEqual(self.guard.check(payload, "0" * 64, NOW).reason, "bad-signature")


class PauseAndResume(unittest.TestCase):
    def moving(self):
        bench = Bench()
        command = bench.command("navigate_to", goal("door"), timeout=60)
        bench.exchange(command)
        bench.run(5.0)
        self.assertGreater(bench.sim.v, 0.3)
        return bench, command

    def test_pause_holds_and_resume_finishes_the_same_mission(self):
        bench, command = self.moving()
        bench.exchange(bench.pause(command["missionId"]))
        bench.run(3.0)
        self.assertEqual(bench.sim.v, 0.0)
        self.assertEqual(bench.state()["mode"], "paused")
        self.assertEqual(bench.statuses(command["missionId"]), ["accepted", "paused"])
        x = bench.sim.x
        # Paused longer than its whole time limit: the limit doesn't run while it is paused.
        bench.run(90.0)
        self.assertEqual(bench.sim.x, x)
        self.assertEqual(bench.state()["mission"]["id"], command["missionId"])
        bench.exchange(bench.resume(command["missionId"]))
        bench.run(2.0)
        self.assertGreater(bench.sim.v, 0.0)
        bench.run(60.0, until=lambda: bench.runtime._active is None)
        bench.run(1.5)
        self.assertEqual([status for status in bench.statuses(command["missionId"]) if status != "paused" or True][-2:], ["resumed", "succeeded"])
        self.assertLess(math.hypot(bench.sim.x - PLACES["door"]["x"], bench.sim.y - PLACES["door"]["y"]), 0.25)

    def test_a_replayed_resume_does_not_restart_a_mission_paused_again(self):
        bench, command = self.moving()
        bench.exchange(bench.pause(command["missionId"]))
        bench.run(2.0)
        resume = bench.resume(command["missionId"], nonce="once")
        bench.exchange(resume)
        bench.run(2.0)
        self.assertGreater(bench.sim.v, 0.0)
        bench.exchange(bench.pause(command["missionId"]))
        bench.run(3.0)
        self.assertEqual(bench.sim.v, 0.0)
        x = bench.sim.x
        bench.exchange(resume)   # the same signed resume, sent again
        bench.run(4.0)
        self.assertEqual(bench.sim.x, x, "the robot stays paused")
        self.assertEqual(bench.state()["mode"], "paused")

    def test_resume_is_refused_when_the_robot_is_no_longer_fit_to_move(self):
        bench, command = self.moving()
        bench.exchange(bench.pause(command["missionId"]))
        bench.run(2.0)
        bench.sim.sensor_faults = {"lidar"}
        bench.exchange(bench.resume(command["missionId"]))
        bench.run(2.0)
        report = bench.reports(command["missionId"])[-1]
        self.assertEqual(report["status"], "resume-refused")
        self.assertIn("lidar sensor isn't reporting", report["reason"])
        self.assertEqual(bench.sim.v, 0.0)
        self.assertEqual(bench.state()["mode"], "paused")

    def test_a_paused_mission_survives_a_lost_link_and_still_needs_a_resume(self):
        bench, command = self.moving()
        bench.exchange(bench.pause(command["missionId"]))
        bench.run(2.0)
        x = bench.sim.x
        bench.run(20.0, linked=False)
        self.assertEqual(bench.sim.x, x)
        self.assertEqual(bench.runtime._active.id, command["missionId"], "kept, not cancelled")
        # While the link is down a resume can't have come from HANNAH just now; it is refused.
        bench.runtime._inbox.append(bench.resume(command["missionId"]))
        bench.run(1.0, linked=False)
        self.assertEqual(bench.reports(command["missionId"])[-1]["status"], "resume-refused")
        bench.exchange()
        bench.run(1.0)
        bench.exchange(bench.resume(command["missionId"]))
        bench.run(2.0)
        self.assertGreater(bench.sim.v, 0.0)

    def test_cancel_and_stop_end_a_paused_mission(self):
        bench, command = self.moving()
        bench.exchange(bench.pause(command["missionId"]))
        bench.run(2.0)
        bench.exchange(bench.cancel(command["missionId"]))
        bench.run(1.5)
        self.assertEqual(bench.statuses(command["missionId"])[-1], "cancelled")
        self.assertEqual(bench.state()["mode"], "idle")


class Sensors(unittest.TestCase):
    def test_every_reading_says_when_it_was_measured_and_that_it_is_simulated(self):
        sim = simulator("home")
        sim.advance(1.0)
        sensors = sim.state()["sensors"]
        self.assertEqual(sorted(sensors), ["battery", "bumper", "camera", "environment", "imu", "lidar", "odometry"])
        for name, reading in sensors.items():
            self.assertTrue(reading["ok"], name)
            self.assertEqual(reading["source"], "simulated", name)
            self.assertGreater(reading["measuredAt"], 1_600_000_000_000, name)
        self.assertEqual((sensors["environment"]["temperatureC"], sensors["environment"]["humidityPercent"]), (22.5, 48.0))
        self.assertEqual({item["id"] for item in sim.describe()["sensors"]}, set(sensors))

    def test_a_sensor_that_stops_reporting_says_so_and_carries_no_value(self):
        sim = simulator("home")
        sim.sensor_faults = {"lidar", "environment", "battery"}
        sim.advance(1.0)
        state = sim.state()
        for name in ("lidar", "environment", "battery"):
            self.assertEqual(state["sensors"][name], {"ok": False, "problem": "not reporting", "source": "simulated"})
        self.assertIsNone(state["battery"])
        health = {item["id"]: item["ok"] for item in state["perception"]["sensorHealth"]}
        self.assertEqual(health, {"lidar": False, "odometry": True, "imu": True, "environment": False, "bumper": True, "battery": False, "camera": True})
        # With no range sensor, what is around the robot is unknown, not "nothing".
        self.assertFalse(state["perception"]["obstaclesKnown"])
        self.assertIsNone(state["perception"]["route"]["blocked"])
        self.assertEqual(state["perception"]["obstacles"], [])

    def test_it_does_not_drive_without_its_range_sensor(self):
        sim = simulator("home")
        sim.sensor_faults = {"lidar"}
        sim.navigate(sim.world["places"]["bedroom"], 0.5, 0.25)
        sim.advance(2.0)
        self.assertEqual(sim.navigation_status().state, "failed")
        self.assertIn("range sensor stopped reporting", sim.navigation_status().reason)
        self.assertEqual(sim.travelled, 0.0)

    def test_the_gyroscope_keeps_the_heading_that_the_wheels_alone_lose(self):
        def turn(faults):
            sim = simulator("home", odometryDrift=0.05)
            sim.sensor_faults = set(faults)
            for _ in range(int(20.0 / DT)):
                sim._drive(0.0, 1.0)
                sim.advance(DT)
            return abs(math.atan2(math.sin(sim.yaw - sim.odom_yaw), math.cos(sim.yaw - sim.odom_yaw))), sim.state()["pose"]["heading"]
        fused, label = turn([])
        wheels, wheels_label = turn(["imu"])
        self.assertLess(fused, 0.1)
        self.assertGreater(wheels, 5 * fused)
        self.assertEqual((label, wheels_label), ("wheels fused with the IMU", "wheels only (IMU not reporting)"))


class Perception(unittest.TestCase):
    def test_reports_what_the_range_sensor_detects_with_provenance(self):
        sim = simulator("home")
        sim.place_obstacle({"name": "bag", "x": -0.3, "y": -1.9, "w": 0.6, "h": 0.4})
        sim.advance(1.0)
        seen = sim.state()["perception"]
        self.assertEqual((seen["sensor"], seen["source"]), ("lidar", "simulated range sensor"))
        self.assertTrue(seen["obstaclesKnown"])
        unmapped = [item for item in seen["obstacles"] if item["kind"] == "object not on the map"]
        self.assertEqual(len(unmapped), 1)
        bag = unmapped[0]
        # The robot is at (0, -3.3) facing up the corridor; the bag's near face is 1.4 m ahead.
        self.assertAlmostEqual(bag["distanceM"], 1.4, delta=0.1)
        self.assertLess(abs(bag["bearingDeg"]), 15)
        self.assertAlmostEqual(bag["x"], 0.0, delta=0.3)
        self.assertEqual(bag["sensor"], "lidar")
        self.assertTrue(0.5 < bag["confidence"] < 1.0)
        self.assertGreaterEqual(bag["returns"], 2)
        self.assertTrue(any(item["kind"] == "mapped obstacle" for item in seen["obstacles"]))
        # And it is recorded as a change from the map.
        self.assertEqual(len(seen["changes"]), 1)
        self.assertEqual(seen["changes"][0]["sensor"], "lidar")
        self.assertEqual(seen["route"], {"blocked": False, "reason": "No route is being followed."})

    def test_says_when_the_route_is_blocked_and_forgets_an_object_that_is_gone(self):
        sim = simulator("home")
        sim.navigate(sim.world["places"]["hallway"], 0.5, 0.25)
        sim.advance(1.5)
        # Someone steps into the corridor, wall to wall, right in front of the moving robot.
        sim.place_obstacle({"name": "person", "x": -0.9, "y": sim.y + 0.7, "w": 1.8, "h": 0.3})
        blocked = False
        for _ in range(int(4.0 / DT)):
            sim.advance(DT)
            blocked = blocked or sim.state()["perception"]["route"]["blocked"] is True
        self.assertTrue(blocked)
        self.assertEqual(sim.state()["faults"], [], "it stopped short")
        self.assertGreater(len(sim.state()["perception"]["changes"]), 0)
        sim.clear_obstacles()
        sim.advance(1.0)
        self.assertEqual(sim.state()["perception"]["changes"], [], "the map is cleared when the sensor sees past where it was")
        self.assertEqual([item for item in sim.state()["perception"]["obstacles"] if item["kind"] == "object not on the map"], [])


class Scenarios(unittest.TestCase):
    def test_every_scenario_passes(self):
        paths = sorted(glob.glob(os.path.join(DEFAULT_DIR, "*.json")))
        self.assertGreaterEqual(len(paths), 5)
        for path in paths:
            result = run_scenario(path)
            self.assertTrue(result["passed"], f"{result['name']}: {result['problems']}")
            self.assertEqual(result["simulator"], "hannah-kinematic")
            if result["closestApproachM"] is not None:
                self.assertGreaterEqual(result["closestApproachM"], 0.18, f"{result['name']}: never closer than the robot's radius")

    def test_a_scenario_gives_the_same_result_every_run(self):
        path = os.path.join(DEFAULT_DIR, "unexpected-object.json")
        self.assertEqual(run_scenario(path)["log"], run_scenario(path)["log"])

    def test_a_scenario_that_does_not_hold_is_reported_as_failed(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "__impossible.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"name": "impossible", "world": os.path.join(os.path.dirname(DEFAULT_DIR), "worlds", "home.json"), "steps": [{"obstacle": {"x": -1.5, "y": 1.3, "w": 1.0, "h": 1.2}}, {"navigate": "kitchen", "expect": "succeeded"}]}, handle)
        try:
            result = run_scenario(path)
        finally:
            os.remove(path)
        self.assertFalse(result["passed"])
        self.assertIn("expected succeeded, got failed", result["problems"][0])


if __name__ == "__main__":
    unittest.main()
