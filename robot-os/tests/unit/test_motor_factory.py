"""Driver selection from hardware profiles, profile validation, and the
motor-controller service following the safety state with real drivers."""
import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from motor_fakes import Clock, FakeDynamixelLine, FakeODriveAsciiLine, FakeODriveBus, FakeVescBus, FakeVescUart

from hannah_robot_os.common import AuditLog
from hannah_robot_os.config import RobotOSConfig, SafetyLimits
from hannah_robot_os.hardware.registry import HardwareRegistry
from hannah_robot_os.motors.drivers.base import TransportError
from hannah_robot_os.motors.drivers.buses import PySerialStream, PythonCanBus, SocketCanBus
from hannah_robot_os.motors.drivers.dynamixel import DynamixelDriver
from hannah_robot_os.motors.drivers.odrive import ODriveAsciiDriver, ODriveCanDriver
from hannah_robot_os.motors.drivers.vesc import VescCanDriver, VescUartDriver
from hannah_robot_os.motors.factory import FramedSerialDriver, build_controller, effective_limits
from hannah_robot_os.motors.sim import SimMotorController
from hannah_robot_os.motors.transport import SimMCUResponder
from hannah_robot_os.profiles.schema import validate_hardware_profile
from hannah_robot_os.services.motor_service import MotorService, ProfileError

ROBOT_ROOT = Path(__file__).resolve().parents[2]
PROFILES = sorted((ROBOT_ROOT / "config" / "hardware").glob("*.json"))
LIMITS = SafetyLimits()


def load(name):
    return json.loads((ROBOT_ROOT / "config" / "hardware" / name).read_text())


@pytest.mark.parametrize("path", PROFILES, ids=lambda p: p.name)
def test_shipped_profiles_validate(path):
    assert validate_hardware_profile(json.loads(path.read_text())) == []


def test_profile_validation_catches_driver_mistakes():
    profile = load("odrive-can-diffdrive.json")
    entry = profile["controllers"][0]
    bad = copy.deepcopy(profile)
    bad["controllers"][0]["transport"] = {"kind": "serial", "path": "/dev/ttyUSB0"}
    assert any("needs a can transport" in e for e in validate_hardware_profile(bad))
    bad = copy.deepcopy(profile)
    del bad["controllers"][0]["drive"]
    assert any(".drive is required" in e for e in validate_hardware_profile(bad))
    bad = copy.deepcopy(profile)
    bad["controllers"][0]["drive"]["wheel_radius_m"] = 0
    assert any("wheel_radius_m" in e for e in validate_hardware_profile(bad))
    bad = copy.deepcopy(profile)
    bad["controllers"][0]["options"] = {"left_node_id": 3, "right_node_id": 3}
    assert any("must differ" in e for e in validate_hardware_profile(bad))
    bad = copy.deepcopy(profile)
    bad["controllers"][0]["options"]["left_node_id"] = 0x3F  # broadcast
    assert any("left_node_id" in e for e in validate_hardware_profile(bad))
    bad = copy.deepcopy(profile)
    bad["controllers"][0]["transport"]["backend"] = "usb2can-magic"
    assert any("backend" in e for e in validate_hardware_profile(bad))
    assert entry["driver"] == "odrive_can"


def test_profile_validation_dynamixel_and_vesc_options():
    dxl = load("dynamixel-diffdrive.json")
    dxl["controllers"][0]["options"].update(left_id=253, bus_watchdog_ms=5000)
    errors = validate_hardware_profile(dxl)
    assert any("left_id" in e for e in errors) and any("bus_watchdog_ms" in e for e in errors)
    vesc = load("vesc-can-diffdrive.json")
    vesc["controllers"][0]["options"]["pole_pairs"] = 0
    assert any("pole_pairs" in e for e in validate_hardware_profile(vesc))


def test_effective_limits_take_the_stricter_value():
    cfg = SafetyLimits(max_linear_speed_mps=0.5, max_angular_speed_rps=1.5, command_ttl_ms=500, watchdog_timeout_ms=500)
    profile = {"limits": {"max_linear_speed_mps": 0.2, "max_angular_speed_rps": 9.0}, "safety": {"watchdog_timeout_ms": 300}}
    out = effective_limits(cfg, profile)
    assert (out.max_linear_speed_mps, out.max_angular_speed_rps, out.watchdog_timeout_ms) == (0.2, 1.5, 300)
    assert cfg.max_linear_speed_mps == 0.5  # not modified in place


@pytest.mark.parametrize("name,cls", [
    ("odrive-can-diffdrive.json", ODriveCanDriver),
    ("odrive-usb-diffdrive.json", ODriveAsciiDriver),
    ("dynamixel-diffdrive.json", DynamixelDriver),
    ("vesc-can-diffdrive.json", VescCanDriver),
    ("sim-diffdrive.json", SimMotorController),
])
def test_build_controller_picks_driver_from_profile(name, cls):
    entry = load(name)["controllers"][0]
    ctrl = build_controller(entry, LIMITS, can_bus_factory=lambda t: FakeODriveBus(), stream_factory=lambda t: FakeDynamixelLine())
    assert isinstance(ctrl, cls)


def test_build_controller_options_reach_the_driver():
    entry = load("dynamixel-diffdrive.json")["controllers"][0]
    ctrl = build_controller(entry, LIMITS, stream_factory=lambda t: FakeDynamixelLine())
    assert (ctrl.left_id, ctrl.right_id, ctrl.bus_watchdog_ms) == (1, 2, 100)
    assert ctrl.geometry.invert_right and ctrl.geometry.max_wheel_speed_mps == 0.2
    vesc_uart = {"controller_id": "d", "kind": "motor_controller", "driver": "vesc_uart", "interface": "serial",
                 "transport": {"kind": "serial", "path": "/dev/null"}, "drive": {"wheel_separation_m": 0.4, "wheel_radius_m": 0.1},
                 "options": {"left_can_id": None, "right_can_id": 9, "pole_pairs": 14}}
    ctrl = build_controller(vesc_uart, LIMITS, stream_factory=lambda t: FakeVescUart())
    assert isinstance(ctrl, VescUartDriver) and (ctrl.left_can_id, ctrl.right_can_id, ctrl.pole_pairs) == (None, 9, 14)


def test_unknown_driver_is_refused():
    with pytest.raises(ValueError, match="unknown motor driver"):
        build_controller({"controller_id": "x", "driver": "warp_drive"}, LIMITS)


def test_optional_libraries_are_optional():
    # Run where pyserial and python-can can't be imported, whatever is installed here.
    code = (
        "import sys; sys.modules['serial'] = None; sys.modules['can'] = None\n"
        "from hannah_robot_os.motors import factory\n"
        "from hannah_robot_os.motors.drivers.buses import PySerialStream, PythonCanBus\n"
        "from hannah_robot_os.motors.drivers.base import TransportError\n"
        "for link in (PySerialStream('/dev/null'), PythonCanBus('socketcan', 'can0')):\n"
        "    try:\n        link.open()\n    except TransportError as e:\n        print(e)\n"
    )
    env = {**os.environ, "PYTHONPATH": str(ROBOT_ROOT / "src")}
    out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    assert "pyserial is not installed" in out.stdout and "python-can is not installed" in out.stdout


def test_socketcan_without_interface_is_a_transport_error():
    with pytest.raises(TransportError):
        SocketCanBus("hannah-test-none0").open()


def test_framed_serial_driver_clamps_and_estops():
    sim = SimMotorController(controller_id="mcu")
    sim.connect()
    responder = SimMCUResponder(sim)

    class Line(FakeODriveAsciiLine):
        def handle(self, data):
            return responder.handle(data)

    line = Line()
    drv = FramedSerialDriver("mcu", line, SafetyLimits(max_linear_speed_mps=0.3, max_angular_speed_rps=1.0))
    drv.connect()
    drv.enable(True)
    drv.send_velocity(5.0, -9.0)
    st = sim.status()
    assert abs((st.velocity_left_mps + st.velocity_right_mps) / 2 - 0.3) < 1e-9
    drv.set_estop(True)
    assert sim.status().velocity_left_mps == 0.0 and not sim.status().enabled
    with pytest.raises(RuntimeError, match="estop"):
        drv.enable(True)
    line.fail = True
    drv.set_estop(False)
    with pytest.raises(Exception):
        drv.enable(True)
    assert drv.status().fault


# ---- the service -----------------------------------------------------------

def _service(tmp_path, profile_name="odrive-can-diffdrive.json", fake=None):
    fake = fake or FakeODriveBus()
    profile = tmp_path / "profile.json"
    profile.write_text(json.dumps(load(profile_name)))
    audit = AuditLog()
    clock = Clock(step=0)
    svc = MotorService(audit=audit, cfg=RobotOSConfig(), hw=HardwareRegistry(audit=audit), profile_path=str(profile), clock=clock,
                       build_kwargs={"can_bus_factory": lambda t: fake, "stream_factory": lambda t: fake, "clock": Clock()})
    svc.setup()
    return svc, fake, audit, clock


def test_service_without_profile_uses_the_simulator():
    audit = AuditLog()
    svc = MotorService(audit=audit, cfg=RobotOSConfig(), hw=HardwareRegistry(audit=audit))
    motors = svc.setup()
    assert isinstance(svc.controllers[0], SimMotorController)
    assert motors.status("sim-motor-1").enabled


def test_service_rejects_an_invalid_profile(tmp_path):
    profile = load("odrive-can-diffdrive.json")
    del profile["controllers"][0]["drive"]
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(profile))
    audit = AuditLog()
    with pytest.raises(ProfileError):
        MotorService(audit=audit, cfg=RobotOSConfig(), hw=HardwareRegistry(audit=audit), profile_path=str(path)).setup()


def test_service_estop_then_reset_with_a_real_driver(tmp_path):
    svc, fake, audit, _ = _service(tmp_path)
    assert svc.motors.status("drive").enabled
    svc.tick(safe=False, reason="estop")
    st = svc.motors.status("drive")
    assert st.estop_active and not st.enabled and fake.estops == 2
    svc.tick(safe=False, reason="estop")
    assert not svc.motors.status("drive").enabled  # stays down while unsafe
    svc.tick(safe=True)
    st = svc.motors.status("drive")
    assert st.enabled and not st.estop_active and fake.last_vel() == (0.0, 0.0)
    assert any(e.event == "controller_reenabled" for e in audit.list())


def test_service_reconnects_after_a_transport_error(tmp_path):
    svc, fake, audit, clock = _service(tmp_path)
    fake.fail = True
    svc.tick(safe=True)
    assert svc.motors.status("drive").fault
    clock.t += 500
    svc.tick(safe=True)  # too soon to retry, and still unplugged
    fake.fail = False
    clock.t += 2000
    svc.tick(safe=True)
    st = svc.motors.status("drive")
    assert st.connected and st.enabled and st.fault is None
    assert any(e.event == "controller_reconnecting" for e in audit.list())


def test_service_does_not_reconnect_while_unsafe(tmp_path):
    svc, fake, audit, clock = _service(tmp_path)
    fake.fail = True
    svc.tick(safe=True)
    fake.fail = False
    clock.t += 5000
    svc.tick(safe=False)
    assert svc.motors.status("drive").fault and not any(e.event == "controller_reconnecting" for e in audit.list())


def _run_cli(*args, timeout=60):
    env = {**os.environ, "PYTHONPATH": str(ROBOT_ROOT / "src")}
    return subprocess.run([sys.executable, "-m", "hannah_robot_os", *args], cwd=str(ROBOT_ROOT), env=env, capture_output=True, text=True, timeout=timeout)


def test_cli_validate_profile_on_shipped_driver_profiles():
    for name in ("odrive-can-diffdrive.json", "dynamixel-diffdrive.json"):
        assert _run_cli("validate-profile", f"config/hardware/{name}").returncode == 0


def test_cli_service_refuses_an_invalid_profile(tmp_path):
    profile = load("dynamixel-diffdrive.json")
    profile["controllers"][0]["transport"]["kind"] = "can"
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(profile))
    out = _run_cli("service", "motor-controller", "--profile", str(path), "--status-dir", str(tmp_path / "status"), "--max-ticks", "1")
    assert out.returncode == 2 and "needs a serial transport" in out.stdout


def test_cli_service_with_missing_device_keeps_running_stopped(tmp_path):
    profile = load("dynamixel-diffdrive.json")
    profile["controllers"][0]["transport"]["path"] = str(tmp_path / "no-such-tty")
    path = tmp_path / "dxl.json"
    path.write_text(json.dumps(profile))
    status = tmp_path / "status"
    out = _run_cli("service", "motor-controller", "--profile", str(path), "--status-dir", str(status), "--interval", "0.01", "--max-ticks", "3")
    assert out.returncode == 0, out.stderr
    events = [e["event"] for e in json.loads((status / "motor-controller.json").read_text())["audit_tail"]]
    assert "controller_unavailable" in events


def test_service_never_retries_a_controller_fault(tmp_path):
    svc, fake, audit, clock = _service(tmp_path)
    fake.error[0] = 0x800  # e.g. overcurrent, reported in the heartbeat
    svc.tick(safe=True)
    fault = svc.motors.status("drive").fault
    assert fault.startswith("controller:")
    fake.error[0] = 0  # even if it went away, nothing clears it automatically
    for _ in range(3):
        clock.t += 5000
        svc.tick(safe=True)
    st = svc.motors.status("drive")
    assert st.fault == fault and not st.enabled
    events = [e.event for e in audit.list()]
    assert events.count("controller_fault_needs_operator") == 1 and "controller_reconnecting" not in events
