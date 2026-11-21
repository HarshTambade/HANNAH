"""Simulation tests: HANNAH's built-in kinematic simulator. Not Gazebo, not hardware."""
import math
import unittest

from hannah_robot.geometry import distance_to_rect
from hannah_robot.hal.kinematic import COMMAND_TIMEOUT, DT, LIDAR_BEAMS

from .helpers import simulator, world


def drive(sim, seconds, v=0.0, w=0.0):
    """Feed the base controller a velocity for a while, the way the navigator does."""
    for _ in range(int(seconds / DT)):
        sim._drive(v, w)
        sim.advance(DT)


def settle(sim, limit=120.0):
    waited = 0.0
    while sim.navigation_status().state == "active" and waited < limit:
        sim.advance(DT)
        waited += DT
    return sim.navigation_status()


class BaseController(unittest.TestCase):
    def test_enforces_speed_and_acceleration_whatever_it_is_asked(self):
        sim = simulator()
        speeds = []
        for _ in range(int(3.0 / DT)):
            sim._drive(50.0, 0.0)
            before = sim.v
            sim.advance(DT)
            speeds.append(sim.v)
            self.assertLessEqual(sim.v - before, 0.8 * DT + 1e-9, "acceleration limit")
        self.assertAlmostEqual(max(speeds), 0.5, places=6)
        drive(sim, 2.0, 0.0, 99.0)
        self.assertLessEqual(abs(sim.w), 1.6 + 1e-9)

    def test_stops_when_commands_stop_arriving(self):
        sim = simulator()
        drive(sim, 2.0, 0.4)
        self.assertGreater(sim.v, 0.3)
        sim.advance(COMMAND_TIMEOUT + 1.0)   # the navigator has gone quiet
        self.assertEqual(sim.v, 0.0)
        x = sim.x
        sim.advance(2.0)
        self.assertEqual(sim.x, x)

    def test_a_collision_stops_the_drive_and_latches_a_fault(self):
        sim = simulator()
        drive(sim, 1.0, 0.0, -1.6)   # turn towards the wall behind the dock
        drive(sim, 6.0, 0.5)
        state = sim.state()
        self.assertEqual(state["faults"][0]["code"], "collision")
        self.assertTrue(state["sensors"]["bumper"]["pressed"])
        self.assertFalse(state["motorsEnabled"])
        # The robot is never inside a wall or an obstacle.
        bounds = world()["bounds"]
        self.assertGreaterEqual(min(sim.x - bounds["minX"], sim.y - bounds["minY"]), sim.radius - 1e-6)
        drive(sim, 1.0, 0.5)
        self.assertEqual(sim.v, 0.0, "a latched fault keeps the drive off")

    def test_emergency_stop_cuts_the_drive_at_once_and_does_not_resume(self):
        sim = simulator()
        sim.navigate(world()["places"]["workbench"], 0.5, 0.25)
        sim.advance(4.0)
        self.assertGreater(sim.v, 0.3)
        sim.press_estop(True)
        sim.advance(DT)
        self.assertEqual((sim.v, sim.w), (0.0, 0.0))
        sim.advance(1.0)
        self.assertEqual(sim.navigation_status().state, "failed")
        self.assertIn("emergency stop", sim.navigation_status().reason)
        sim.press_estop(False)
        x = sim.x
        sim.advance(5.0)
        self.assertEqual(sim.x, x, "releasing the stop moves nothing by itself")


class Sensors(unittest.TestCase):
    def test_range_sensor_measures_the_room(self):
        sim = simulator()
        state = sim.state()
        ranges = state["sensors"]["lidar"]["ranges"]
        self.assertEqual(len(ranges), LIDAR_BEAMS)
        # At the dock (-4.3, -3.3) facing +x: 0.7 m to the wall behind, 0.7 m to the wall on the right.
        self.assertAlmostEqual(ranges[LIDAR_BEAMS // 2], 0.7, places=2)
        self.assertAlmostEqual(ranges[3 * LIDAR_BEAMS // 4], 0.7, places=2)
        # Straight ahead is the divider at x = -0.8.
        self.assertAlmostEqual(ranges[0], 3.5, places=2)

    def test_odometry_drifts_from_the_truth_and_says_so(self):
        sim = simulator(odometryDrift=0.05)
        drive(sim, 6.0, 0.5)
        state = sim.state()
        self.assertEqual(state["pose"]["source"], "odometry")
        self.assertGreater(state["sim"]["odometryError"], 0.05)
        self.assertAlmostEqual(state["sim"]["odometryError"], math.hypot(sim.x - sim.odom_x, sim.y - sim.odom_y), places=3)

    def test_battery_drains_while_driving_and_charges_in_the_dock(self):
        sim = simulator(startBatteryPercent=50)
        sim.navigate(world()["places"]["shelves"], 0.5, 0.25)
        settle(sim)
        away = sim.battery
        self.assertLess(away, 50)
        self.assertFalse(sim.state()["battery"]["charging"])
        sim.navigate(world()["dock"], 0.5, 0.25)
        self.assertEqual(settle(sim).state, "succeeded")
        sim.advance(20.0)
        self.assertTrue(sim.state()["battery"]["charging"])
        self.assertGreater(sim.battery, away)


class Navigation(unittest.TestCase):
    def test_reaches_every_named_place_without_touching_anything(self):
        sim = simulator()
        obstacles = world()["obstacles"]
        for name, place in world()["places"].items():
            sim.navigate(place, 0.5, 0.25)
            closest = math.inf
            waited = 0.0
            while sim.navigation_status().state == "active" and waited < 120:
                sim.advance(DT)
                waited += DT
                closest = min(closest, min(distance_to_rect(sim.x, sim.y, rect) for rect in obstacles))
            status = sim.navigation_status()
            self.assertEqual(status.state, "succeeded", f"{name}: {status.reason}")
            self.assertLess(math.hypot(sim.x - place["x"], sim.y - place["y"]), 0.25, f"{name}: the true position is at the goal")
            self.assertEqual((sim.v, sim.w), (0.0, 0.0))
            self.assertGreaterEqual(closest, sim.radius, f"{name}: never closer to an obstacle than the robot's radius")
        self.assertEqual(sim.state()["faults"], [])

    def test_turns_to_the_requested_heading(self):
        sim = simulator()
        sim.navigate({"x": -2.5, "y": -2.5, "yaw": 1.5708}, 0.5, 0.25)
        self.assertEqual(settle(sim).state, "succeeded")
        self.assertAlmostEqual(sim.yaw, 1.5708, delta=0.12)

    def test_respects_a_lower_speed_for_one_goal(self):
        sim = simulator()
        sim.navigate(world()["places"]["shelves"], 0.2, 0.25)
        fastest = 0.0
        while sim.navigation_status().state == "active":
            sim.advance(DT)
            fastest = max(fastest, sim.v)
        self.assertLessEqual(fastest, 0.2 + 1e-9)
        self.assertEqual(sim.navigation_status().state, "succeeded")

    def test_cancel_stops_where_it_is(self):
        sim = simulator()
        sim.navigate(world()["places"]["door"], 0.5, 0.25)
        sim.advance(5.0)
        sim.cancel_navigation()
        sim.advance(2.0)
        self.assertEqual(sim.navigation_status().state, "cancelled")
        self.assertEqual(sim.v, 0.0)
        self.assertGreater(math.hypot(sim.x - world()["places"]["door"]["x"], sim.y - world()["places"]["door"]["y"]), 2.0)

    def test_goes_around_an_obstacle_that_is_not_on_its_map(self):
        sim = simulator()
        # A pallet left in the open floor between the dock side and the shelves.
        sim.place_obstacle({"name": "pallet", "x": -3.2, "y": -1.4, "w": 1.2, "h": 0.6})
        sim.navigate(world()["places"]["shelves"], 0.5, 0.25)
        closest = math.inf
        while sim.navigation_status().state == "active":
            sim.advance(DT)
            closest = min(closest, distance_to_rect(sim.x, sim.y, sim.dynamic[0]))
        self.assertEqual(sim.navigation_status().state, "succeeded", sim.navigation_status().reason)
        self.assertGreaterEqual(closest, sim.radius)
        self.assertEqual(sim.state()["faults"], [])
        self.assertGreater(len(sim.state()["map"]["discovered"]), 0, "the range sensor put it on the map")

    def test_gives_up_honestly_when_the_way_is_closed(self):
        sim = simulator()
        # Close the only gap past the divider and the wall-to-wall line across the room.
        sim.place_obstacle({"name": "barrier", "x": -0.9, "y": -1.9, "w": 0.4, "h": 6.0})
        sim.navigate(world()["places"]["loading bay"], 0.5, 0.25)
        status = settle(sim, 200.0)
        self.assertEqual(status.state, "failed")
        self.assertRegex(status.reason, "No path to the goal|Blocked")
        sim.advance(2.0)   # it brakes at its own deceleration limit
        self.assertEqual(sim.v, 0.0)
        self.assertEqual(sim.state()["faults"], [], "it stopped before touching the barrier")

    def test_a_goal_inside_an_obstacle_fails_at_once(self):
        sim = simulator()
        sim.navigate({"x": -2.0, "y": 0.85}, 0.5, 0.25)
        sim.advance(1.0)
        self.assertEqual(sim.navigation_status().state, "failed")
        self.assertEqual(sim.travelled, 0.0)

    def test_maps_what_it_sees(self):
        sim = simulator()
        first = sim.state()["map"]["coveragePercent"]
        sim.navigate(world()["places"]["workbench"], 0.5, 0.25)
        settle(sim)
        self.assertGreater(sim.state()["map"]["coveragePercent"], first + 20)


if __name__ == "__main__":
    unittest.main()
