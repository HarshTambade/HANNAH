"""Simulation tests: the whole runtime driving HANNAH's built-in simulator on a hand-moved clock.

The test plays HANNAH's server (it signs commands and reads reports). No
network, no Gazebo, no hardware.
"""
import math
import unittest

from .helpers import Bench, world

PLACES = world()["places"]


def goal(name, **extra):
    return {"x": PLACES[name]["x"], "y": PLACES[name]["y"], "tolerance": 0.25, **extra}


class Missions(unittest.TestCase):
    def test_drives_to_a_goal_and_reports_only_what_happened(self):
        bench = Bench()
        command = bench.command("navigate_to", goal("shelves"))
        bench.exchange(command)
        bench.run(1.0)
        self.assertEqual(bench.statuses(command["missionId"]), ["accepted"])
        self.assertEqual(bench.state()["mode"], "navigating")
        self.assertEqual(bench.state()["mission"]["id"], command["missionId"])
        bench.run(60.0, until=lambda: bench.runtime._active is None)
        bench.run(1.5)
        self.assertEqual(bench.statuses(command["missionId"]), ["accepted", "succeeded"])
        self.assertTrue(any(report["status"] == "progress" and report["progress"]["distanceRemaining"] > 0 for report in bench.reports(command["missionId"])))
        final = bench.reports(command["missionId"])[-1]
        self.assertLess(math.hypot(final["result"]["final"]["x"] - PLACES["shelves"]["x"], final["result"]["final"]["y"] - PLACES["shelves"]["y"]), 0.25)
        self.assertGreater(final["result"]["travelled"], 3.0)
        # The simulator's ground truth agrees with what the robot reported.
        self.assertLess(math.hypot(bench.sim.x - PLACES["shelves"]["x"], bench.sim.y - PLACES["shelves"]["y"]), 0.25)
        state = bench.state()
        self.assertEqual(state["mode"], "idle")
        self.assertIsNone(state["mission"])
        self.assertEqual(state["velocity"], {"linear": 0.0, "angular": 0.0})
        # The state sent in the same exchange as the success report already shows the robot at the goal, standing still.
        with_success = next(body for body in bench.sent if any(report["status"] == "succeeded" for report in body["reports"]))
        self.assertEqual(with_success["state"]["velocity"]["linear"], 0.0)
        self.assertLess(math.hypot(with_success["state"]["pose"]["x"] - PLACES["shelves"]["x"], with_success["state"]["pose"]["y"] - PLACES["shelves"]["y"]), 0.25)

    def test_refuses_a_command_its_own_limits_do_not_allow(self):
        bench = Bench()
        for params, expected in [({"x": 30, "y": 0}, "outside this robot's workspace"), ({"x": -4.5, "y": 3.5}, "keep-out zone"), ({"x": -2.0, "y": 0.85}, "obstacle 'shelf_a'")]:
            command = bench.command("navigate_to", params)
            bench.exchange(command)
            bench.run(1.5)
            report = bench.reports(command["missionId"])[-1]
            self.assertEqual(report["status"], "rejected")
            self.assertIn(expected, report["reason"])
        unknown = bench.command("set_motor_pwm", {"left": 255, "right": 255})
        bench.exchange(unknown)
        bench.run(1.5)
        self.assertIn("doesn't offer 'set_motor_pwm'", bench.reports(unknown["missionId"])[-1]["reason"])
        self.assertEqual(bench.sim.travelled, 0.0)
        self.assertIn("command-rejected", bench.events())

    def test_never_runs_a_command_it_cannot_trust(self):
        bench = Bench()
        forged = bench.command("navigate_to", goal("door"), secret="AAAA" * 11)
        other = bench.command("navigate_to", goal("door"), robot="rb_000000000000000009")
        tampered = bench.command("navigate_to", goal("door"))
        tampered["payload"] = tampered["payload"].replace('"x": 4.3', '"x": -4.0')
        bench.exchange(forged, other, tampered, {"payload": 5, "sig": None}, "nonsense")
        bench.run(3.0)
        self.assertEqual(bench.reports(), [], "nothing is reported about a command that didn't prove its origin")
        self.assertEqual(bench.sim.travelled, 0.0)
        self.assertEqual(bench.events().count("command-refused"), 4)

    def test_never_runs_an_expired_or_replayed_command(self):
        bench = Bench()
        stale = bench.command("navigate_to", goal("door"), issued=bench.now - 60, ttl=20)
        bench.exchange(stale)
        bench.run(2.0)
        self.assertEqual(bench.statuses(stale["missionId"]), ["rejected"])
        self.assertIn("already expired", bench.reports(stale["missionId"])[0]["reason"])
        # A command held back until after it expired (a delayed network, or someone replaying it later).
        held = bench.command("navigate_to", goal("door"), ttl=3)
        bench.run(5.0)
        bench.exchange(held)
        bench.run(2.0)
        self.assertEqual(bench.statuses(held["missionId"]), ["rejected"])
        # An older sequence number than one already accepted.
        first = bench.command("set_supported_device_state", {"device": "beacon", "state": "on"}, seq=50)
        bench.exchange(first)
        bench.run(1.5)
        replay = bench.command("navigate_to", goal("door"), seq=49)
        bench.exchange(replay)
        bench.run(2.0)
        self.assertEqual(bench.reports(replay["missionId"]), [])
        self.assertEqual(bench.sim.travelled, 0.0)

    def test_a_repeated_delivery_is_acknowledged_and_not_run_twice(self):
        bench = Bench()
        command = bench.command("navigate_to", goal("shelves"))
        bench.exchange(command)
        bench.run(2.0)
        bench.exchange(command)
        bench.exchange(command)
        bench.run(60.0, until=lambda: bench.runtime._active is None)
        bench.run(1.5)
        statuses = bench.statuses(command["missionId"])
        self.assertEqual(statuses.count("succeeded"), 1)
        self.assertEqual(set(statuses), {"accepted", "succeeded"})
        travelled = bench.sim.travelled
        bench.exchange(command)   # delivered again after it finished
        bench.run(3.0)
        self.assertEqual(bench.sim.travelled, travelled, "the finished mission is not started again")
        self.assertEqual(bench.reports(command["missionId"])[-1]["status"], "succeeded")

    def test_only_one_motion_mission_at_a_time(self):
        bench = Bench()
        first = bench.command("navigate_to", goal("workbench"))
        bench.exchange(first)
        bench.run(2.0)
        second = bench.command("navigate_to", goal("door"))
        bench.exchange(second)
        bench.run(1.5)
        self.assertEqual(bench.statuses(second["missionId"]), ["rejected"])
        self.assertIn("another motion mission is running", bench.reports(second["missionId"])[0]["reason"])
        self.assertEqual(bench.runtime._active.id, first["missionId"])

    def test_visits_points_and_reports_what_it_saw_at_each(self):
        bench = Bench()
        command = bench.command("inspect_area", {"waypoints": [{"x": -2.5, "y": -2.5}, {"x": -3.8, "y": -0.5}], "tolerance": 0.3}, timeout=300)
        bench.exchange(command)
        bench.run(90.0, until=lambda: bench.runtime._active is None)
        bench.run(1.5)
        final = bench.reports(command["missionId"])[-1]
        self.assertEqual(final["status"], "succeeded")
        visited = final["result"]["visited"]
        self.assertEqual(len(visited), 2)
        for point, wanted in zip(visited, [(-2.5, -2.5), (-3.8, -0.5)]):
            self.assertTrue(point["reached"])
            self.assertLess(math.hypot(point["pose"]["x"] - wanted[0], point["pose"]["y"] - wanted[1]), 0.3)
            self.assertGreater(point["nearestObstacleM"], 0.0)

    def test_switches_a_listed_device_and_shows_it_in_the_same_report(self):
        bench = Bench()
        command = bench.command("set_supported_device_state", {"device": "beacon", "state": "on"})
        bench.exchange(command)
        bench.run(0.2)
        body = bench.exchange()
        self.assertEqual([report["status"] for report in body["reports"]], ["accepted", "succeeded"])
        self.assertEqual(body["state"]["devices"], {"beacon": "on"})
        drive = bench.command("set_supported_device_state", {"device": "drive", "state": "on"})
        bench.exchange(drive)
        bench.run(1.5)
        self.assertEqual(bench.statuses(drive["missionId"]), ["rejected"])


class Stopping(unittest.TestCase):
    def moving(self, place="door"):
        bench = Bench()
        command = bench.command("navigate_to", goal(place))
        bench.exchange(command)
        bench.run(5.0)
        self.assertGreater(bench.sim.v, 0.3)
        return bench, command

    def test_cancel_stops_the_robot_where_it_is(self):
        bench, command = self.moving()
        bench.exchange(bench.cancel(command["missionId"]))
        bench.run(3.0)
        self.assertEqual(bench.statuses(command["missionId"]), ["accepted", "cancelled"])
        self.assertEqual(bench.sim.v, 0.0)
        self.assertEqual(bench.state()["mode"], "idle")
        x = bench.sim.x
        bench.run(5.0)
        self.assertEqual(bench.sim.x, x)
        # Cancelling again, or cancelling something unknown, changes nothing.
        bench.exchange(bench.cancel(command["missionId"]), bench.cancel("ms_never"))
        bench.run(1.5)
        self.assertEqual(bench.statuses(command["missionId"]).count("cancelled") >= 1, True)

    def test_stop_cancels_the_mission_and_is_confirmed_by_measured_speed(self):
        bench, command = self.moving()
        stop = bench.command("stop_motion", {"reason": "person in the aisle"})
        bench.exchange(stop)
        bench.run(0.1)
        self.assertEqual(bench.state()["mode"], "stopping")
        self.assertEqual(bench.statuses(stop["missionId"]), ["accepted"], "not reported stopped while it is still braking")
        bench.run(3.0)
        self.assertEqual(bench.statuses(command["missionId"]), ["accepted", "cancelled"])
        self.assertEqual(bench.statuses(stop["missionId"]), ["accepted", "succeeded"])
        self.assertEqual(bench.reports(stop["missionId"])[-1]["result"], {"stopped": True, "speed": 0.0})
        self.assertEqual(bench.sim.v, 0.0)
        # A stop when nothing is moving is still answered.
        again = bench.command("stop_motion")
        bench.exchange(again)
        bench.run(1.5)
        self.assertEqual(bench.statuses(again["missionId"]), ["accepted", "succeeded"])

    def test_a_mission_that_runs_out_of_time_is_stopped(self):
        bench = Bench()
        command = bench.command("navigate_to", goal("loading bay"), timeout=4)
        bench.exchange(command)
        bench.run(8.0)
        self.assertEqual(bench.statuses(command["missionId"]), ["accepted", "timed-out"])
        self.assertEqual(bench.sim.v, 0.0)
        self.assertGreater(math.hypot(bench.sim.x - PLACES["loading bay"]["x"], bench.sim.y - PLACES["loading bay"]["y"]), 1.0)

    def test_losing_the_link_stops_the_robot_and_nothing_resumes(self):
        bench, command = self.moving()
        bench.run(4.5, linked=False)
        self.assertGreater(bench.sim.v, 0.3, "inside the link timeout it keeps going")
        bench.run(2.5, linked=False)
        self.assertEqual(bench.sim.v, 0.0)
        self.assertEqual(bench.state()["mode"], "holding")
        self.assertFalse(bench.state()["link"]["ok"])
        self.assertEqual(bench.statuses(command["missionId"]), ["accepted", "cancelled"])
        self.assertIn("link to HANNAH was lost for more than 5 s; the robot stopped by itself", bench.reports(command["missionId"])[-1]["reason"])
        x = bench.sim.x
        bench.run(20.0, linked=False)
        self.assertEqual(bench.sim.x, x)
        # The link returns: the report is delivered, and the robot stays where it is.
        delivered = bench.exchange()
        self.assertIn("cancelled", [report["status"] for report in delivered["reports"]])
        bench.run(5.0)
        self.assertEqual(bench.sim.x, x)
        self.assertEqual(bench.state()["mode"], "idle")
        self.assertEqual([name for name in bench.events() if name.startswith("link-")], ["link-lost", "link-restored"])
        # A new command is what moves it again.
        fresh = bench.command("navigate_to", goal("door"))
        bench.exchange(fresh)
        bench.run(3.0)
        self.assertGreater(bench.sim.v, 0.0)

    def test_reports_survive_a_failed_exchange(self):
        bench, command = self.moving()
        bench.runtime.link_ok({"commands": [bench.cancel(command["missionId"])]})
        bench.run(0.2, linked=False)
        body = bench.runtime.outbox()
        self.assertEqual([report["status"] for report in body["reports"]], ["cancelled"])
        bench.runtime.requeue(body)   # the request failed
        self.assertEqual(bench.runtime.outbox()["reports"][: len(body["reports"])], body["reports"])

    def test_the_emergency_stop_aborts_the_mission_and_blocks_new_ones_until_released(self):
        bench, command = self.moving()
        bench.sim.press_estop(True)
        bench.run(0.1)
        self.assertEqual(bench.sim.v, 0.0)
        self.assertEqual(bench.state()["mode"], "estopped")
        bench.run(1.5)
        self.assertEqual(bench.statuses(command["missionId"]), ["accepted", "failed"])
        self.assertIn("emergency stop was engaged", bench.reports(command["missionId"])[-1]["reason"])
        blocked = bench.command("navigate_to", goal("door"))
        bench.exchange(blocked)
        bench.run(1.5)
        self.assertIn("emergency stop is engaged", bench.reports(blocked["missionId"])[-1]["reason"])
        bench.sim.press_estop(False)
        x = bench.sim.x
        bench.run(5.0)
        self.assertEqual(bench.sim.x, x, "releasing the emergency stop doesn't restart the mission")
        self.assertEqual(bench.state()["mode"], "idle")
        self.assertEqual([name for name in bench.events() if name.startswith("estop-")], ["estop-engaged", "estop-released"])

    def test_a_fault_aborts_the_mission(self):
        bench, command = self.moving()
        bench.sim._fault("motor-driver", "Left motor driver over-temperature.")
        bench.run(1.5)
        self.assertEqual(bench.sim.v, 0.0)
        self.assertEqual(bench.statuses(command["missionId"]), ["accepted", "failed"])
        self.assertIn("Left motor driver over-temperature", bench.reports(command["missionId"])[-1]["reason"])
        self.assertEqual(bench.state()["mode"], "fault")
        self.assertIn("fault", bench.events())

    def test_a_robot_the_server_no_longer_accepts_holds_and_takes_no_missions(self):
        bench, command = self.moving()
        bench.runtime.link_refused("revoked")
        bench.run(7.0, linked=False)
        self.assertEqual(bench.sim.v, 0.0)
        late = bench.command("navigate_to", goal("door"))
        bench.runtime._inbox.append(late)
        bench.run(1.0, linked=False)
        self.assertIn("credentials were refused", bench.reports(late["missionId"])[-1]["reason"])


if __name__ == "__main__":
    unittest.main()
