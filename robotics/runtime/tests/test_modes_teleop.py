"""Simulation tests: operating modes and manual control, enforced by the runtime itself.

The test plays HANNAH's server and signs the commands. The runtime drives
HANNAH's built-in kinematic simulator on a hand-moved clock. No network, no
Gazebo, no hardware: what a physical base does under manual control is not
tested here.
"""
import json
import os
import tempfile
import unittest

from hannah_robot import modes
from hannah_robot.profile import local_safety
from hannah_robot.protocol import CommandGuard
from hannah_robot.runtime import Runtime

from .helpers import ROBOT_ID, SECRET, Bench, simulator, world

PLACES = world()["places"]
GOAL = {"x": PLACES["shelves"]["x"], "y": PLACES["shelves"]["y"], "tolerance": 0.25}


def last_status(bench, mission):
    return [report for report in bench.reports(mission) if report["status"] != "progress"][-1]


class Modes(unittest.TestCase):
    def test_a_simulated_robot_starts_in_mission_autonomy_and_reports_its_mode(self):
        bench = Bench()
        bench.run(0.1)
        self.assertEqual(bench.state()["operatingMode"], {"mode": "mission", "seq": 0, "session": None})
        self.assertEqual(modes.default_mode(False), "supervised")

    def test_the_mode_it_holds_decides_what_it_takes_whatever_the_server_sends(self):
        bench = Bench()
        bench.exchange(bench.mode("manual"))
        bench.run(0.2)
        self.assertEqual(bench.state()["operatingMode"]["mode"], "manual")
        # A mission in Manual is refused by the robot, even signed and valid.
        command = bench.command("navigate_to", GOAL)
        bench.exchange(command)
        bench.run(0.5)
        self.assertEqual(last_status(bench, command["missionId"])["status"], "rejected")
        self.assertIn("Manual mode", last_status(bench, command["missionId"])["reason"])
        self.assertEqual(bench.sim.travelled, 0.0)
        # Stopping and a picture are always taken.
        stop = bench.command("stop_motion")
        bench.exchange(stop)
        bench.run(1.0)
        self.assertIn("accepted", bench.statuses(stop["missionId"]))

    def test_a_change_the_table_does_not_allow_is_refused_and_reported(self):
        bench = Bench()
        bench.exchange(bench.mode("manual"))
        bench.run(0.2)
        refused = bench.mode("mission")
        bench.exchange(refused)
        bench.run(0.2)
        state = bench.state()["operatingMode"]
        self.assertEqual(state["mode"], "manual")
        self.assertEqual(state["refusedSeq"], json.loads(refused["payload"])["modeSeq"])
        self.assertIn("can't change straight to mission", state["refusedReason"])
        self.assertIn("mode-refused", bench.events())
        # An older mode number is never taken again.
        bench.exchange(bench.mode("supervised", seq=1))
        bench.run(0.2)
        self.assertEqual(bench.state()["operatingMode"]["mode"], "manual")

    def test_a_mission_sent_for_another_mode_or_origin_is_refused(self):
        bench = Bench()
        mismatch = bench.command("navigate_to", GOAL)
        body = json.loads(mismatch["payload"])
        body["mode"] = "supervised"
        from hannah_robot.protocol import sign_command
        mismatch = {"payload": json.dumps(body), "sig": sign_command(SECRET, json.dumps(body)), "missionId": body["missionId"]}
        bench.exchange(mismatch)
        bench.run(0.5)
        self.assertIn("the server sent it for supervised and the robot is in mission", last_status(bench, mismatch["missionId"])["reason"])
        # Supervised: no plan steps. Assisted: only a person on the Robots screen.
        bench.exchange(bench.mode("supervised"))
        bench.run(0.2)
        for mode, origin, expected in (("supervised", "plan", "plans don't run"), ("assisted", "agent", "only a person")):
            if mode == "assisted":
                bench.exchange(bench.mode("assisted"))
                bench.run(0.2)
            command = bench.command("navigate_to", GOAL)
            body = json.loads(command["payload"])
            body.update({"mode": mode, "origin": origin})
            signed = {"payload": json.dumps(body), "sig": sign_command(SECRET, json.dumps(body)), "missionId": body["missionId"]}
            bench.exchange(signed)
            bench.run(0.5)
            self.assertIn(expected, last_status(bench, signed["missionId"])["reason"])
        person = bench.command("navigate_to", GOAL)
        body = json.loads(person["payload"])
        body.update({"mode": "assisted", "origin": "person"})
        signed = {"payload": json.dumps(body), "sig": sign_command(SECRET, json.dumps(body)), "missionId": body["missionId"]}
        bench.exchange(signed)
        bench.run(0.5)
        self.assertEqual(bench.statuses(signed["missionId"]), ["accepted"])

    def test_safety_stop_aborts_and_holds_and_is_left_only_to_manual_or_maintenance(self):
        bench = Bench()
        command = bench.command("navigate_to", GOAL)
        bench.exchange(command)
        bench.run(2.0)
        self.assertGreater(bench.sim.travelled, 0.05)
        bench.exchange(bench.mode("safety_stop"))
        bench.run(1.5)
        self.assertEqual(last_status(bench, command["missionId"])["status"], "cancelled")
        self.assertIn("Safety Stop", last_status(bench, command["missionId"])["reason"])
        self.assertAlmostEqual(bench.sim.v, 0.0, places=3)
        for target in ("mission", "supervised", "assisted"):
            bench.exchange(bench.mode(target))
            bench.run(0.1)
            self.assertEqual(bench.state()["operatingMode"]["mode"], "safety_stop", target)
        device = bench.command("set_supported_device_state", {"device": "beacon", "state": "on"})
        bench.exchange(device)
        bench.run(0.3)
        self.assertIn("Safety Stop", last_status(bench, device["missionId"])["reason"])
        bench.exchange(bench.mode("maintenance"))
        bench.run(0.1)
        self.assertEqual(bench.state()["operatingMode"]["mode"], "maintenance")

    def test_the_mode_survives_a_restart(self):
        folder = tempfile.mkdtemp()
        path = os.path.join(folder, "guard.json")
        bench = Bench()
        bench.guard = CommandGuard(SECRET, ROBOT_ID, path)
        bench.runtime = Runtime(bench.sim, bench.guard, local_safety(bench.sim), clock=lambda: bench.now)
        bench.exchange(bench.mode("safety_stop", seq=50))
        bench.run(0.2)
        again = Runtime(simulator(), CommandGuard(SECRET, ROBOT_ID, path), local_safety(simulator()), clock=lambda: bench.now)
        self.assertEqual(again.mode, "safety_stop")
        self.assertEqual(again.mode_seq, 50)
        # An unreadable file is taken as Safety Stop, never as the default.
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("{broken")
        broken = Runtime(simulator(), CommandGuard(SECRET, ROBOT_ID, path), local_safety(simulator()), clock=lambda: bench.now)
        self.assertEqual(broken.mode, "safety_stop")

    def test_the_profiles_areas_are_checked_by_the_robot(self):
        bench = Bench()
        command = bench.command("navigate_to", GOAL)
        body = json.loads(command["payload"])
        body["areas"] = {"keepIn": [{"name": "east half", "polygon": [[0, -4], [5, -4], [5, 4], [0, 4]]}], "keepOut": []}
        from hannah_robot.protocol import sign_command
        signed = {"payload": json.dumps(body), "sig": sign_command(SECRET, json.dumps(body)), "missionId": body["missionId"]}
        bench.exchange(signed)
        bench.run(0.5)
        self.assertIn("outside the operating area 'east half'", last_status(bench, signed["missionId"])["reason"])


class ManualControl(unittest.TestCase):
    def manual(self, **kwargs):
        bench = Bench()
        bench.exchange(bench.mode("manual", session="to_1", **kwargs))
        bench.run(0.1)
        return bench

    def drive(self, bench, seconds, linear, angular=0.0, every=0.1, session="to_1"):
        """An operator holding a key: a fresh command every `every` seconds."""
        elapsed = 0.0
        while elapsed < seconds:
            bench.seq_teleop = getattr(bench, "seq_teleop", 0) + 1
            bench.runtime.link_ok({"commands": [bench.teleop(session, bench.seq_teleop, linear, angular)]})
            for _ in range(int(round(every / 0.05))):
                bench.now += 0.05
                bench.runtime.tick(0.05)
            elapsed += every

    def test_it_moves_only_while_fresh_operator_commands_arrive_and_holds_on_the_deadman(self):
        bench = self.manual(deadman_ms=300)
        self.assertEqual(bench.state()["operatingMode"]["session"], "to_1")
        start = (bench.sim.x, bench.sim.y)
        self.drive(bench, 1.5, 0.3)
        moved = bench.sim.travelled
        self.assertGreater(moved, 0.15, "it drove while the operator held the key")
        applied = bench.state()["teleop"]
        self.assertEqual(applied["session"], "to_1")
        self.assertFalse(applied["holding"])
        # The operator lets go: no new command. Within the deadman time plus the ramp-down, it stands still.
        bench.run(1.0, linked=True)
        self.assertAlmostEqual(bench.sim.v, 0.0, places=3)
        self.assertTrue(bench.state()["teleop"]["holding"])
        self.assertIn("deadman", bench.state()["teleop"]["reason"])
        self.assertIn("teleop-deadman", bench.events())
        self.assertNotEqual(start, (bench.sim.x, bench.sim.y))

    def test_speeds_are_clamped_and_stale_or_foreign_commands_never_move_it(self):
        bench = self.manual(max_linear=0.2)
        self.drive(bench, 2.0, 5.0, 9.0)
        self.assertLessEqual(abs(bench.sim.v), 0.2 + 1e-6)
        self.assertLessEqual(bench.state()["teleop"]["linear"], 0.2)
        bench.run(1.0)
        before = bench.sim.travelled
        # Expired, replayed, another session's: dropped.
        expired = bench.teleop("to_1", 500, 0.3, ttl_ms=400)
        bench.now += 1.0
        bench.runtime.link_ok({"commands": [expired, bench.teleop("to_1", 3, 0.3), bench.teleop("to_other", 900, 0.3)]})
        bench.run(1.0, linked=False)
        self.assertAlmostEqual(bench.sim.travelled, before, places=3)

    def test_maintenance_jogs_slowly(self):
        bench = Bench()
        bench.exchange(bench.mode("manual"))
        bench.run(0.1)
        bench.exchange(bench.mode("maintenance", session="to_m"))
        bench.run(0.1)
        self.drive(bench, 2.0, 0.5, session="to_m")
        self.assertLessEqual(abs(bench.sim.v), modes.MAINTENANCE_SPEED["linear"] + 1e-6)

    def test_manual_and_autonomous_commands_never_mix(self):
        bench = self.manual()
        command = bench.command("navigate_to", GOAL)
        body = json.loads(command["payload"])
        body["mode"] = "manual"
        from hannah_robot.protocol import sign_command
        signed = {"payload": json.dumps(body), "sig": sign_command(SECRET, json.dumps(body)), "missionId": body["missionId"]}
        bench.exchange(signed)
        bench.run(0.3)
        self.assertEqual(last_status(bench, signed["missionId"])["status"], "rejected")
        # And no manual command is taken while an autonomous mission runs (Assisted: a person's mission).
        bench = Bench()
        bench.exchange(bench.mode("manual"), bench.mode("assisted", session="to_a"))
        bench.run(0.1)
        self.assertEqual(bench.state()["operatingMode"], {"mode": "assisted", "seq": bench.seq, "session": "to_a"})
        mission = bench.command("navigate_to", GOAL)
        body = json.loads(mission["payload"])
        body.update({"mode": "assisted", "origin": "person"})
        mission = {"payload": json.dumps(body), "sig": sign_command(SECRET, json.dumps(body)), "missionId": body["missionId"]}
        bench.exchange(mission)
        bench.run(0.3)
        self.assertEqual(last_status(bench, mission["missionId"])["reason"], "Refused by the robot's operating mode: an operator holds manual control.")

    def test_connection_loss_ends_manual_control_on_the_robot(self):
        bench = self.manual()
        self.drive(bench, 1.0, 0.3)
        self.assertGreater(bench.sim.travelled, 0.05)
        # The link goes silent (no exchange, no command): it holds, then drops the session by itself.
        bench.run(3.0, linked=False)
        self.assertAlmostEqual(bench.sim.v, 0.0, places=3)
        self.assertIsNone(bench.state()["operatingMode"]["session"])
        self.assertNotIn("teleop", bench.state())
        self.assertIn("teleop-ended", bench.events())
        # A command for the old session that arrives later is ignored.
        before = bench.sim.travelled
        bench.runtime.link_ok({"commands": [bench.teleop("to_1", 10_000, 0.3)]})
        bench.run(1.0, linked=False)
        self.assertAlmostEqual(bench.sim.travelled, before, places=3)

    def test_withdrawing_the_session_holds_the_robot(self):
        bench = self.manual()
        self.drive(bench, 0.6, 0.3)
        bench.exchange(bench.mode("manual"))  # a newer mode number without a session
        bench.run(0.8)
        self.assertAlmostEqual(bench.sim.v, 0.0, places=3)
        self.assertIsNone(bench.state()["operatingMode"]["session"])

    def test_the_emergency_stop_and_the_operating_area_override_the_operator(self):
        bench = self.manual(areas={"keepIn": [{"name": "dock corner", "polygon": [[-5, -4], [-3.5, -4], [-3.5, -2.5], [-5, -2.5]]}], "keepOut": []})
        # Facing +x from the dock at (-4.3, -3.3): driving forward leaves the corner after about 0.8 m.
        self.drive(bench, 6.0, 0.3)
        self.assertLess(bench.sim.x, -3.5 + 0.05, "it stopped at the edge of its operating area")
        self.assertIn("operating area", bench.state()["teleop"]["reason"])
        bench.sim.press_estop(True)
        bench.run(0.2)
        self.drive(bench, 0.5, -0.2)
        self.assertEqual(bench.state()["teleop"]["reason"], "the emergency stop is engaged")
        self.assertAlmostEqual(bench.sim.v, 0.0, places=3)


if __name__ == "__main__":
    unittest.main()
