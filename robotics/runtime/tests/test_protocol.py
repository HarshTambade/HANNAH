"""Unit tests: signatures and the command guard. No robot, no simulator."""
import json
import os
import tempfile
import unittest

from hannah_robot.protocol import CommandGuard, sign_command, sign_request

from .helpers import ROBOT_ID, SECRET

NOW = 1_800_000_000_000


def command(seq=1, mission="ms_a", ttl=20_000, robot=ROBOT_ID, kind="mission", issued=NOW, nonce=None, secret=SECRET, **extra):
    body = {"v": 1, "type": kind, "robotId": robot, "missionId": mission, "seq": seq, "nonce": nonce or f"{seq:032x}", "capability": "navigate_to", "params": {"x": 1, "y": 1}, "issuedAt": issued, "expiresAt": issued + ttl, **extra}
    payload = json.dumps(body)
    return payload, sign_command(secret, payload)


class Signatures(unittest.TestCase):
    def test_match_the_server(self):
        # The same vectors are asserted in server/robotics.sim.test.js against the server's code.
        self.assertEqual(sign_request(SECRET, ROBOT_ID, "1000", "1", "POST", "/api/robots/device/sync", "{}"), "6d8d5e3439d517657856d31eecc8ed48af1134fedd4727db3e23170c8dd7ea75")
        self.assertEqual(sign_command(SECRET, '{"v":1}'), "76799387e9ba3acc2de09d3ddfbba7a3feb7c0b8f2d776656356d4f5f67a1a15")

    def test_request_and_command_keys_differ(self):
        self.assertNotEqual(sign_command(SECRET, "x"), sign_request(SECRET, ROBOT_ID, 1, 1, "POST", "/p", "x"))


class Guard(unittest.TestCase):
    def test_accepts_a_genuine_command_once(self):
        guard = CommandGuard(SECRET, ROBOT_ID)
        first = guard.check(*command(), NOW)
        self.assertTrue(first.ok and not first.duplicate)
        self.assertEqual(first.command["capability"], "navigate_to")
        again = guard.check(*command(), NOW + 1000)
        self.assertTrue(again.ok and again.duplicate, "a repeat delivery is recognised, not run again")

    def test_refuses_what_it_cannot_trust(self):
        guard = CommandGuard(SECRET, ROBOT_ID)
        payload, signature = command()
        self.assertEqual(guard.check(payload, "0" * 64, NOW).reason, "bad-signature")
        self.assertEqual(guard.check(payload.replace('"x": 1', '"x": 9'), signature, NOW).reason, "bad-signature")
        self.assertEqual(guard.check(*command(secret="AAAA" * 11), NOW).reason, "bad-signature")
        self.assertEqual(guard.check(*command(robot="rb_000000000000000002"), NOW).reason, "wrong-robot")
        self.assertEqual(guard.check(*command(kind="firmware"), NOW).reason, "unknown-type")
        self.assertEqual(guard.check(None, None, NOW).reason, "malformed")
        self.assertEqual(guard.check("not json", sign_command(SECRET, "not json"), NOW).reason, "malformed")
        v2 = json.dumps({"v": 2})
        self.assertEqual(guard.check(v2, sign_command(SECRET, v2), NOW).reason, "unsupported-version")
        self.assertEqual(guard.last_seq, 0, "nothing refused moved the sequence")

    def test_refuses_expired_future_and_replayed(self):
        guard = CommandGuard(SECRET, ROBOT_ID)
        self.assertEqual(guard.check(*command(), NOW + 20_000).reason, "expired")
        self.assertEqual(guard.check(*command(issued=NOW + 120_000), NOW).reason, "issued-in-the-future")
        self.assertTrue(guard.check(*command(seq=5, mission="ms_five"), NOW).ok)
        # A recorded older command, or a new mission reusing a sequence number or a nonce.
        self.assertEqual(guard.check(*command(seq=4, mission="ms_four"), NOW).reason, "replayed")
        self.assertEqual(guard.check(*command(seq=5, mission="ms_other"), NOW).reason, "replayed")
        self.assertEqual(guard.check(*command(seq=6, mission="ms_six", nonce=f"{5:032x}"), NOW).reason, "replayed")
        self.assertTrue(guard.check(*command(seq=6, mission="ms_six"), NOW).ok)

    def test_cancel_only_for_a_mission_it_knows(self):
        guard = CommandGuard(SECRET, ROBOT_ID)
        cancel = json.dumps({"v": 1, "type": "cancel", "robotId": ROBOT_ID, "missionId": "ms_a", "issuedAt": NOW})
        self.assertEqual(guard.check(cancel, sign_command(SECRET, cancel), NOW).reason, "unknown-mission")
        self.assertTrue(guard.check(*command(), NOW).ok)
        self.assertTrue(guard.check(cancel, sign_command(SECRET, cancel), NOW).ok)
        self.assertEqual(guard.check(cancel, "f" * 64, NOW).reason, "bad-signature")

    def test_sequence_survives_a_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "guard.json")
            self.assertTrue(CommandGuard(SECRET, ROBOT_ID, path).check(*command(seq=9, mission="ms_nine"), NOW).ok)
            restarted = CommandGuard(SECRET, ROBOT_ID, path)
            self.assertEqual(restarted.last_seq, 9)
            self.assertEqual(restarted.check(*command(seq=8, mission="ms_eight"), NOW).reason, "replayed")
            self.assertTrue(restarted.check(*command(seq=9, mission="ms_nine"), NOW).duplicate)
            # A damaged state file closes the window instead of reopening it.
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("{broken")
            self.assertEqual(CommandGuard(SECRET, ROBOT_ID, path).check(*command(seq=10, mission="ms_ten"), NOW).reason, "replayed")


class ModesAndManualControl(unittest.TestCase):
    def test_modes_only_go_forward_and_manual_commands_expire_on_the_servers_clock(self):
        guard = CommandGuard(SECRET, ROBOT_ID)

        def signed(body):
            text = json.dumps(body)
            return text, sign_command(SECRET, text)

        def mode(seq, name="manual"):
            return signed({"v": 1, "type": "mode", "robotId": ROBOT_ID, "mode": name, "modeSeq": seq})

        def teleop(seq, expires, session="to_1"):
            return signed({"v": 1, "type": "teleop", "robotId": ROBOT_ID, "session": session, "seq": seq, "linear": 0.1, "angular": 0, "expiresAt": expires})

        self.assertTrue(guard.check(*mode(10), NOW).ok)
        guard.remember_mode("manual", 10)
        self.assertTrue(guard.check(*mode(10), NOW).duplicate)
        self.assertEqual(guard.check(*mode(9, "mission"), NOW).reason, "replayed")
        self.assertEqual(guard.check(*signed({"v": 1, "type": "mode", "robotId": ROBOT_ID, "mode": "manual", "modeSeq": "11"}), NOW).reason, "malformed")
        self.assertTrue(guard.check(*teleop(1, NOW + 400), NOW).ok)
        self.assertEqual(guard.check(*teleop(1, NOW + 400), NOW).reason, "replayed")
        self.assertEqual(guard.check(*teleop(2, NOW + 400), NOW, server_now_ms=NOW + 500).reason, "expired", "judged on the server's clock")
        self.assertTrue(guard.check(*teleop(3, NOW + 400), NOW + 5000, server_now_ms=NOW + 100).ok, "a robot clock ahead of the server's doesn't expire a fresh command")
        self.assertEqual(guard.check(*signed({"v": 1, "type": "teleop", "robotId": "rb_000000000000000009", "session": "to_1", "seq": 9, "expiresAt": NOW + 400}), NOW).reason, "wrong-robot")


if __name__ == "__main__":
    unittest.main()
