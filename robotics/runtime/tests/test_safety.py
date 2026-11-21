"""Unit tests: the robot-side safety checks, against a profile's limits. No simulator runs."""
import unittest

from hannah_robot.profile import local_safety
from hannah_robot.safety import LocalSafety

from .helpers import simulator


def ready(**change):
    state = {"estop": {"engaged": False}, "motorsEnabled": True, "localized": True, "faults": [], "battery": {"percent": 80}}
    state.update(change)
    return state


class RobotSideSafety(unittest.TestCase):
    def setUp(self):
        self.safety = local_safety(simulator())

    def test_allows_a_goal_inside_the_limits(self):
        decision = self.safety.check("navigate_to", {"x": 3.1, "y": 1.9, "yaw": 1.57, "tolerance": 0.25, "maxSpeed": 0.3, "place": "workbench"}, ready())
        self.assertTrue(decision.ok, decision.reason)
        self.assertEqual(decision.params, {"x": 3.1, "y": 1.9, "tolerance": 0.25, "yaw": 1.57})
        self.assertEqual(decision.max_speed, 0.3)

    def test_a_command_can_lower_the_speed_and_never_raise_it(self):
        self.assertEqual(self.safety.check("navigate_to", {"x": 1, "y": 1, "maxSpeed": 4.0}, ready()).max_speed, 0.5)
        self.assertEqual(self.safety.check("navigate_to", {"x": 1, "y": 1}, ready(), {"maxLinearSpeed": 9.0}).max_speed, 0.5)
        self.assertEqual(self.safety.check("navigate_to", {"x": 1, "y": 1}, ready(), {"maxLinearSpeed": 0.2}).max_speed, 0.2)
        self.assertFalse(self.safety.check("navigate_to", {"x": 1, "y": 1, "maxSpeed": -1}, ready()).ok)

    def test_refuses_goals_outside_the_workspace_in_keep_out_or_in_an_obstacle(self):
        self.assertIn("outside this robot's workspace", self.safety.check("navigate_to", {"x": 9, "y": 0}, ready()).reason)
        self.assertIn("keep-out zone 'charging cabinet'", self.safety.check("navigate_to", {"x": -4.5, "y": 3.5}, ready()).reason)
        self.assertIn("obstacle 'shelf_a'", self.safety.check("navigate_to", {"x": -2.0, "y": 0.8}, ready()).reason)
        self.assertIn("no valid position", self.safety.check("navigate_to", {"x": "1", "y": 1}, ready()).reason)
        self.assertIn("point 2", self.safety.check("inspect_area", {"waypoints": [{"x": 1, "y": 1}, {"x": 40, "y": 0}]}, ready()).reason)
        self.assertIn("1 to 12 points", self.safety.check("inspect_area", {"waypoints": []}, ready()).reason)

    def test_refuses_when_the_robot_is_not_fit_to_move(self):
        goal = {"x": 1, "y": 1}
        self.assertIn("emergency stop", self.safety.check("navigate_to", goal, ready(estop={"engaged": True})).reason)
        self.assertIn("motors are disabled", self.safety.check("navigate_to", goal, ready(motorsEnabled=False)).reason)
        self.assertIn("active fault (collision)", self.safety.check("navigate_to", goal, ready(faults=[{"code": "collision"}])).reason)
        self.assertIn("isn't localized", self.safety.check("navigate_to", goal, ready(localized=False)).reason)
        self.assertIn("battery 9% is below the 15% minimum", self.safety.check("navigate_to", goal, ready(battery={"percent": 9})).reason)
        self.assertIn("another motion mission", self.safety.check("navigate_to", goal, ready(), busy=True).reason)
        # Going home on a low battery is allowed; the dock is the robot's own, not the command's.
        home = self.safety.check("return_to_dock", {"x": 3, "y": 3}, ready(battery={"percent": 9}))
        self.assertTrue(home.ok)
        self.assertEqual((home.params["x"], home.params["y"]), (-4.3, -3.3))

    def test_stop_is_always_accepted(self):
        broken = ready(estop={"engaged": True}, motorsEnabled=False, faults=[{"code": "collision"}], battery={"percent": 0})
        self.assertTrue(self.safety.check("stop_motion", {}, broken, busy=True).ok)

    def test_there_is_no_way_to_command_an_actuator(self):
        for capability in ("set_velocity", "set_motor_pwm", "cmd_vel", "move_robot_arm", "report_robot_state"):
            self.assertFalse(self.safety.check(capability, {"left": 255, "right": 255}, ready()).ok, capability)
        self.assertFalse(self.safety.check("set_supported_device_state", {"device": "drive", "state": "on"}, ready()).ok)
        self.assertTrue(self.safety.check("set_supported_device_state", {"device": "beacon", "state": "on"}, ready()).ok)

    def test_a_robot_without_limits_does_not_move(self):
        bare = LocalSafety({}, ["navigate_to"], {}, 0.2)
        self.assertIn("no speed limit", bare.check("navigate_to", {"x": 1, "y": 1}, ready()).reason)
        no_fence = LocalSafety({"maxLinearSpeed": 0.5}, ["navigate_to"], {}, 0.2)
        self.assertIn("no workspace", no_fence.check("navigate_to", {"x": 1, "y": 1}, ready()).reason)


if __name__ == "__main__":
    unittest.main()
