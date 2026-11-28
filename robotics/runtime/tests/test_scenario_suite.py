"""Simulation tests: the scenario suite the sim-to-real pipeline runs, with profiles and overrides.

Everything here is HANNAH's built-in kinematic simulator, not Gazebo and not hardware.
"""
import io
import json
import os
import unittest
from contextlib import redirect_stdout

from hannah_robot.scenarios import DEFAULT_DIR, ScenarioConfigError, main, run_scenario, run_suite, sim_config

PROFILES = os.path.join(os.path.dirname(DEFAULT_DIR), "profiles")
VALID = os.path.join(DEFAULT_DIR, "valid-navigation.json")


class ScenarioConfigTests(unittest.TestCase):
    def test_profile_then_overrides(self):
        with open(os.path.join(PROFILES, "sim-diffdrive.json"), encoding="utf-8") as handle:
            profile = json.load(handle)
        config = sim_config(profile, {"limits": {"maxLinearSpeed": 0.3}, "robot": {"radius": 0.2}})
        self.assertEqual(config["limits"]["maxLinearSpeed"], 0.3)
        self.assertEqual(config["limits"]["maxAngularSpeed"], profile["limits"]["maxAngularSpeed"])
        self.assertEqual(config["robot"]["radius"], 0.2)
        self.assertEqual(config["simulation"]["odometryDrift"], profile["simulation"]["odometryDrift"])

    def test_unknown_or_unsafe_values_are_refused(self):
        for overrides in ({"limits": {"maxSpeed": 1}}, {"limits": {"maxLinearSpeed": -1}}, {"limits": {"maxLinearSpeed": 0}}, {"robot": {"radius": "big"}}, {"firmware": {}}, {"limits": {"maxLinearSpeed": True}}):
            with self.assertRaises(ScenarioConfigError, msg=overrides):
                sim_config(None, overrides)

    def test_an_arm_profile_is_refused(self):
        with open(os.path.join(PROFILES, "sim-arm.json"), encoding="utf-8") as handle:
            with self.assertRaises(ScenarioConfigError):
                sim_config(json.load(handle))


class ScenarioSuiteTests(unittest.TestCase):
    def test_metrics_follow_the_configuration(self):
        slow = run_scenario(VALID, sim_config(None, {"limits": {"maxLinearSpeed": 0.25}}))
        fast = run_scenario(VALID, sim_config(None, {"limits": {"maxLinearSpeed": 0.5}}))
        self.assertTrue(slow["passed"] and fast["passed"])
        self.assertLessEqual(slow["metrics"]["maxLinearSpeed"], 0.25 + 1e-9)
        self.assertGreater(fast["metrics"]["maxLinearSpeed"], 0.25)
        self.assertGreater(slow["simulatedSeconds"], fast["simulatedSeconds"])
        self.assertEqual(slow["metrics"]["trips"], 4)
        self.assertEqual(slow["metrics"]["tripsSucceeded"], 4)

    def test_suite_summary_says_it_is_simulation(self):
        report = run_suite([VALID, os.path.join(DEFAULT_DIR, "sensor-loss.json")], sim_config())
        self.assertFalse(report["physical"])
        self.assertEqual(report["simulator"], "hannah-kinematic")
        summary = report["summary"]
        self.assertEqual([summary["scenarios"], summary["scenariosPassed"], summary["trips"]], [2, 2, 6])
        # sensor-loss expects one failed trip: completion counts it, reliability doesn't.
        self.assertAlmostEqual(summary["missionCompletion"], 5 / 6, places=3)
        self.assertEqual(summary["navigationReliability"], 1.0)
        self.assertEqual(summary["errorsPerTrip"], 0.0)
        for key in ("wallMs", "cpuMs", "simulatedSeconds", "distanceM"):
            self.assertGreater(summary[key], 0)

    def test_the_same_configuration_gives_the_same_motion(self):
        first, second = run_suite([VALID], sim_config()), run_suite([VALID], sim_config())
        for key in ("missionCompletion", "distanceM", "maxLinearSpeed", "closestApproachM", "maxOdometryErrorM", "simulatedSeconds"):
            self.assertEqual(first["summary"][key], second["summary"][key], key)

    def test_json_command_line(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = main(["--json", "--overrides", json.dumps({"limits": {"maxLinearSpeed": 0.4}}), VALID])
        report = json.loads(out.getvalue())
        self.assertEqual(code, 0)
        self.assertTrue(report["ok"])
        self.assertEqual(report["config"]["limits"]["maxLinearSpeed"], 0.4)
        out = io.StringIO()
        with redirect_stdout(out):
            code = main(["--json", "--overrides", "[1]", VALID])
        self.assertEqual(code, 2)
        self.assertFalse(json.loads(out.getvalue())["ok"])


if __name__ == "__main__":
    unittest.main()
