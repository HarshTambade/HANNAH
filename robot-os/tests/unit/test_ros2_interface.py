import sys
from pathlib import Path

PKG = Path(__file__).resolve().parents[2] / "ros2" / "hannah_robot_os_hardware"
sys.path.insert(0, str(PKG))

from hannah_robot_os_hardware.interface import HannahSystemInterface  # noqa: E402


class FakeManager:
    def __init__(self):
        self.sent = []
        self.stops = 0

    def status(self):
        return {"controller_id": "mc1", "enabled": True}

    def send_velocity(self, linear, angular):
        self.sent.append((linear, angular))

    def stop(self):
        self.stops += 1


def test_interface_lifecycle_and_command_validation():
    mgr = FakeManager()
    iface = HannahSystemInterface(client=mgr)
    assert iface.write({"type": "velocity", "linear_x_mps": 0.1}) is False  # not active
    assert iface.on_configure({"controller_id": "mc1", "limits": {"max_linear_speed_mps": 0.5, "max_angular_speed_rps": 1.0}}) is True
    assert iface.on_activate() is True
    assert iface.read()["enabled"] is True
    assert iface.write({"type": "velocity", "linear_x_mps": 2.0}) is False  # exceeds limit
    assert mgr.sent == []
    assert iface.write({"type": "velocity", "linear_x_mps": 0.2, "angular_z_rps": 0.1}) is True
    assert mgr.sent == [(0.2, 0.1)]
    assert iface.write({"type": "stop"}) is True
    assert mgr.stops == 1
    iface.on_deactivate()
    assert iface.active is False
    assert mgr.stops == 2
