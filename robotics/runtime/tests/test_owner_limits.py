"""Limits an owner tightens on the server reach the robot and are obeyed there.

Before, a command carried only the linear speed: an owner's lower turning speed,
acceleration, joint speed or link timeout was saved and shown but never applied.
"""
import unittest

from .helpers import Bench

GOAL = {"x": 1.5, "y": -1.0, "tolerance": 0.25}


class OwnerLimits(unittest.TestCase):
    def test_a_lower_turning_speed_is_obeyed(self):
        bench = Bench()
        command = bench.command("navigate_to", GOAL, limits={"maxLinearSpeed": 0.5, "maxAngularSpeed": 0.3})
        bench.exchange(command)
        fastest = 0.0
        for _ in range(600):
            bench.run(0.05)
            fastest = max(fastest, abs(bench.sim.state()["velocity"]["angular"]))
            if bench.runtime._active is None:
                break
        self.assertIn("accepted", bench.statuses(command["missionId"]))
        self.assertLessEqual(fastest, 0.3 + 1e-6)
        self.assertGreater(fastest, 0.0, "the robot turned at all")
        # describe() still reports the robot's own limit, not the owner's.
        self.assertEqual(bench.sim.describe()["limits"]["maxAngularSpeed"], 1.6)

    def test_the_next_mission_goes_back_to_the_robots_own_limits(self):
        bench = Bench()
        bench.exchange(bench.command("navigate_to", GOAL, limits={"maxAngularSpeed": 0.3}))
        bench.run(1.0)
        self.assertEqual(bench.sim._tightened, {"maxAngularSpeed": 0.3})
        bench.exchange(bench.command("stop_motion"))
        bench.run(2.0)
        bench.exchange(bench.command("navigate_to", GOAL, limits={}))
        bench.run(1.0)
        self.assertEqual(bench.sim._tightened, {})

    def test_a_shorter_link_timeout_stops_the_robot_sooner(self):
        bench = Bench()
        command = bench.command("navigate_to", {"x": -3.0, "y": 2.5, "tolerance": 0.25}, limits={"linkTimeoutS": 2})
        bench.exchange(command)
        bench.run(1.0)
        self.assertEqual(bench.runtime.link_timeout, 2.0)
        bench.run(3.0, linked=False)
        self.assertIsNone(bench.runtime._active, "the robot kept driving past the owner's 2 s link timeout")
        # A command can shorten the watchdog, never lengthen it past the profile's own.
        bench.exchange(bench.command("navigate_to", GOAL, limits={"linkTimeoutS": 60}))
        bench.run(0.2)
        self.assertEqual(bench.runtime.link_timeout, 5.0)

    def test_a_robot_that_cannot_apply_a_tighter_limit_refuses_to_move(self):
        bench = Bench()
        bench.sim.tighten_limits = lambda limits: sorted(limits)  # a controller whose limits can't be changed
        tighter = bench.command("navigate_to", GOAL, limits={"maxAngularSpeed": 0.3})
        bench.exchange(tighter)
        bench.run(1.5)
        report = bench.reports(tighter["missionId"])[-1]
        self.assertEqual(report["status"], "rejected")
        self.assertIn("maxAngularSpeed", report["reason"])
        self.assertEqual(bench.sim.travelled, 0.0)
        # A limit no stricter than the robot's own needs nothing applied, so the mission runs.
        same = bench.command("navigate_to", GOAL, limits={"maxAngularSpeed": 1.6})
        bench.exchange(same)
        bench.run(1.5)
        self.assertIn("accepted", bench.statuses(same["missionId"]))


if __name__ == "__main__":
    unittest.main()


class DescriptorOnStart(unittest.TestCase):
    def test_the_first_exchange_after_a_start_carries_the_profile(self):
        from hannah_robot.runtime import Runtime
        bench = Bench()
        described = {"robotType": "mobile-base", "limits": {"linkTimeoutS": 5}}
        runtime = Runtime(bench.sim, bench.guard, bench.runtime.safety, link_timeout=5.0, clock=lambda: bench.now, descriptor=described)
        first = runtime.outbox()
        self.assertEqual(first["descriptor"], described)
        # A failed exchange sends it again; once the server answered, it isn't repeated.
        self.assertIn("descriptor", runtime.outbox())
        runtime.link_ok({"commands": []})
        self.assertNotIn("descriptor", runtime.outbox())
