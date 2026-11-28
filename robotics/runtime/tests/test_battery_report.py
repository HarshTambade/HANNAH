"""The ROS 2 adapter's battery report: measured fields only (no ROS needed)."""
import math
import unittest
from types import SimpleNamespace

from hannah_robot.hal.ros2 import battery_report


class BatteryReport(unittest.TestCase):
    def test_measured_voltage_current_and_temperature_are_passed_on(self):
        message = SimpleNamespace(percentage=0.8, power_supply_status=2, voltage=24.31, current=-3.2, temperature=31.0)
        self.assertEqual(battery_report(message), {"percent": 80.0, "charging": False, "voltageV": 24.31, "currentA": -3.2, "temperatureC": 31.0})

    def test_nan_means_not_measured_and_is_left_out(self):
        message = SimpleNamespace(percentage=0.5, power_supply_status=1, voltage=math.nan, current=math.nan, temperature=math.nan)
        self.assertEqual(battery_report(message), {"percent": 50.0, "charging": True})

    def test_no_message_is_no_report(self):
        self.assertIsNone(battery_report(None))


if __name__ == "__main__":
    unittest.main()
