"""Unit tests for `hannah_robot doctor`: the checks a robot's computer passes before the runtime is started."""
import json
import os
import tempfile
import unittest
import urllib.error

from hannah_robot.doctor import checks, report
from hannah_robot.profile import DEFAULT_PROFILE

from .helpers import ROBOT_ID, SECRET

NOW = 1_800_000_000.0


def answering(status=200, server_time=NOW):
    return lambda url, timeout: (status, server_time)


class Doctor(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="hannah-doctor-")
        os.chmod(self.dir, 0o700)

    def enrol(self, server="https://hannah.example", mode=0o600, **change):
        path = os.path.join(self.dir, "credentials.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"server": server, "robotId": ROBOT_ID, "secret": SECRET, **change}, handle)
        os.chmod(path, mode)

    def run_checks(self, profile=DEFAULT_PROFILE, **options):
        found = checks(profile, self.dir, fetch=options.pop("fetch", answering()), clock=lambda: NOW, **options)
        return {item["id"]: item for item in found}, found

    def test_an_enrolled_simulated_robot_with_a_reachable_server_is_ready(self):
        self.enrol()
        by_id, found = self.run_checks()
        self.assertTrue(all(item["ok"] is True for item in found), found)
        self.assertIn("A SIMULATION (hannah-kinematic). Nothing physical will move.", by_id["kind"]["message"])
        self.assertIn("Fingerprint F86E CC32 9E7A BDAB", by_id["credentials"]["message"])
        self.assertIn("maxLinearSpeed 0.5", by_id["limits"]["message"])
        text = report(found)
        self.assertIn("Ready to start.", text)
        self.assertIn("nothing was moved and no signed request was made", text)
        self.assertNotIn(SECRET, text, "the secret is never printed")

    def test_a_robot_that_is_not_enrolled_says_how_to_enrol(self):
        by_id, found = self.run_checks()
        self.assertIs(by_id["credentials"]["ok"], False)
        self.assertIn("isn't enrolled", by_id["credentials"]["message"])
        self.assertNotIn("server", by_id, "there is no server to check yet")
        self.assertIn("1 problem to fix", report(found))

    def test_a_secret_other_users_can_read_is_a_problem_with_its_fix(self):
        self.enrol(mode=0o644)
        by_id, _ = self.run_checks()
        self.assertIs(by_id["credentials"]["ok"], False)
        self.assertIn("readable by other users (mode 644). Run: chmod 600", by_id["credentials"]["message"])
        os.chmod(self.dir, 0o755)
        by_id, _ = self.run_checks()
        self.assertIsNone(by_id["state-dir"]["ok"])

    def test_a_clock_too_far_from_the_servers_is_a_problem_and_a_drifting_one_a_warning(self):
        self.enrol()
        by_id, _ = self.run_checks(fetch=answering(server_time=NOW - 125))
        self.assertIs(by_id["clock"]["ok"], False)
        self.assertIn("125 s from the server's. Signed requests are refused beyond 60 s", by_id["clock"]["message"])
        by_id, found = self.run_checks(fetch=answering(server_time=NOW + 30))
        self.assertIsNone(by_id["clock"]["ok"])
        self.assertIn("Ready to start, with 1 warning.", report(found))
        by_id, _ = self.run_checks(fetch=answering(server_time=None))
        self.assertIsNone(by_id["clock"]["ok"])

    def test_a_server_that_does_not_answer_is_a_problem_and_says_the_robot_stays_put(self):
        self.enrol()

        def down(url, timeout):
            raise urllib.error.URLError("connection refused")
        by_id, _ = self.run_checks(fetch=down)
        self.assertIs(by_id["server"]["ok"], False)
        self.assertIn("couldn't be reached (connection refused)", by_id["server"]["message"])
        self.assertIn("nothing moves without the server", by_id["server"]["message"])
        by_id, _ = self.run_checks(fetch=answering(status=503))
        self.assertIs(by_id["server"]["ok"], False)

    def test_an_unencrypted_link_to_another_computer_is_refused_unless_allowed(self):
        self.enrol(server="http://192.168.1.20:3001")
        by_id, _ = self.run_checks()
        self.assertIs(by_id["server-address"]["ok"], False)
        self.assertIn("Refusing an unencrypted link", by_id["server-address"]["message"])
        by_id, _ = self.run_checks(allow_insecure=True)
        self.assertIs(by_id["server-address"]["ok"], True)

    def test_a_broken_profile_or_incomplete_credentials_are_named(self):
        bad = os.path.join(self.dir, "bad.json")
        with open(bad, "w", encoding="utf-8") as handle:
            handle.write("{ not json")
        by_id, _ = self.run_checks(profile=bad)
        self.assertIs(by_id["profile"]["ok"], False)
        self.assertNotIn("limits", by_id)
        self.enrol(secret="")
        by_id, _ = self.run_checks()
        self.assertIn("is incomplete. Enroll again", by_id["credentials"]["message"])

    def test_the_ros_adapter_without_ros_says_what_to_source(self):
        profile = os.path.join(os.path.dirname(DEFAULT_PROFILE), "..", "ros2_ws", "src", "hannah_sim", "config", "hannah_profile.json")
        import importlib.util
        if importlib.util.find_spec("rclpy") is not None:
            self.skipTest("ROS 2 is installed here")
        by_id, _ = self.run_checks(profile=os.path.normpath(profile))
        self.assertIs(by_id["ros"]["ok"], False)
        self.assertIn("source /opt/ros/jazzy/setup.bash", by_id["ros"]["message"])


if __name__ == "__main__":
    unittest.main()
