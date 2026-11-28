"""Driver behaviour behind MotorControllerManager, over fake transports.

Every driver gets the same checks: the manager's ramp reaches the wire, a
too-fast request is clamped, estop/watchdog/transport errors stop the motors,
and a reconnect clears the fault but leaves the controller disabled.
"""
import math

import pytest

from motor_fakes import Clock, FakeDynamixelLine, FakeODriveAsciiLine, FakeODriveBus, FakeVescBus, FakeVescUart

from hannah_robot_os.common import AuditLog
from hannah_robot_os.config import SafetyLimits
from hannah_robot_os.motors.base import MotorCommand
from hannah_robot_os.motors.drivers import dynamixel as dxl
from hannah_robot_os.motors.drivers.base import DriveGeometry, TransportError, clamp_to_limits
from hannah_robot_os.motors.drivers.dynamixel import DynamixelDriver
from hannah_robot_os.motors.drivers.odrive import ODriveAsciiDriver, ODriveCanDriver
from hannah_robot_os.motors.drivers.vesc import VescCanDriver, VescUartDriver
from hannah_robot_os.motors.manager import MotorControllerManager

LIMITS = SafetyLimits(max_linear_speed_mps=0.5, max_angular_speed_rps=1.5, max_acceleration_mps2=0.8, command_ttl_ms=500, watchdog_timeout_ms=500)
GEOMETRY = DriveGeometry(wheel_separation_m=0.4, wheel_radius_m=0.05)
MAX_TPS = 0.5 / (2 * math.pi * 0.05)  # wheel speed limit in motor turns/s


def make(kind):
    clock = Clock()
    if kind == "odrive_can":
        fake = FakeODriveBus()
        drv = ODriveCanDriver("drive", fake, LIMITS, GEOMETRY, clock=clock)
    elif kind == "odrive_ascii":
        fake = FakeODriveAsciiLine()
        drv = ODriveAsciiDriver("drive", fake, LIMITS, GEOMETRY, clock=clock)
    elif kind == "dynamixel":
        fake = FakeDynamixelLine()
        drv = DynamixelDriver("drive", fake, LIMITS, GEOMETRY, clock=clock)
    elif kind == "vesc_can":
        fake = FakeVescBus()
        drv = VescCanDriver("drive", fake, LIMITS, GEOMETRY, clock=clock)
    elif kind == "vesc_uart":
        fake = FakeVescUart()
        drv = VescUartDriver("drive", fake, LIMITS, GEOMETRY, right_can_id=1, clock=clock)
    else:
        raise AssertionError(kind)
    audit = AuditLog()
    mgr = MotorControllerManager(audit=audit, limits=LIMITS)
    mgr.register_controller(drv)
    mgr.connect("drive")
    mgr.enable("drive", True)
    return mgr, drv, fake, audit


KINDS = ["odrive_can", "odrive_ascii", "dynamixel", "vesc_can", "vesc_uart"]
# Integer protocols (Dynamixel 0.229 rpm, VESC 1 ERPM) round toward zero.
TOL = {"odrive_can": 1e-5, "odrive_ascii": 1e-5, "dynamixel": 0.229 / 60, "vesc_can": 1 / 420, "vesc_uart": 1 / 420}


def cmd(linear, angular=0.0, at=1_000_000, cid="c"):
    return MotorCommand(command_id=cid, controller_id="drive", linear_x_mps=linear, angular_z_rps=angular, issued_at_ms=at, ttl_ms=500, source="nav")


@pytest.mark.parametrize("kind", KINDS)
def test_ramped_command_reaches_the_wire(kind):
    mgr, drv, fake, audit = make(kind)
    mgr.send_command(cmd(0.4), now=1_000_000)  # first step from rest: 0.8 m/s^2 * 100 ms = 0.08 m/s
    expected = 0.08 / (2 * math.pi * 0.05)
    left, right = fake.last_vel()
    assert abs(left - expected) <= TOL[kind] and abs(right - expected) <= TOL[kind]
    assert any(e.event == "command_ramped" for e in audit.list())
    st = mgr.status("drive")
    assert st.connected and st.enabled and st.fault is None
    assert abs(st.velocity_left_mps - 0.08) < 0.01


@pytest.mark.parametrize("kind", KINDS)
def test_driver_clamps_even_when_called_directly(kind):
    _, drv, fake, _ = make(kind)
    drv.send_velocity(10.0, 50.0)  # far over every limit, bypassing the manager
    left, right = fake.last_vel()
    assert abs(left) <= MAX_TPS + 1e-6 and abs(right) <= MAX_TPS + 1e-6
    assert drv.status().details["clamped_commands"] == 1


@pytest.mark.parametrize("kind", KINDS)
def test_watchdog_timeout_sends_zero(kind):
    mgr, drv, fake, audit = make(kind)
    mgr.send_command(cmd(0.4), now=1_000_000)
    assert fake.last_vel() != (0.0, 0.0)
    mgr.watchdog_check("drive", now=1_000_000 + 1000)
    assert fake.last_vel() == (0.0, 0.0)
    assert any(e.event == "watchdog_timeout_stop" for e in audit.list())


@pytest.mark.parametrize("kind", KINDS)
def test_estop_stops_disengages_and_blocks(kind):
    mgr, drv, fake, _ = make(kind)
    mgr.send_command(cmd(0.4), now=1_000_000)
    drv.set_estop(True)
    assert fake.last_vel() == (0.0, 0.0)
    st = mgr.status("drive")
    assert st.estop_active and not st.enabled
    with pytest.raises(RuntimeError, match="estop"):
        mgr.send_command(cmd(0.1, at=1_000_050), now=1_000_050)
    with pytest.raises(RuntimeError, match="estop"):
        mgr.enable("drive", True)
    drv.set_estop(False)
    assert not mgr.status("drive").enabled  # releasing never re-enables
    mgr.enable("drive", True)
    mgr.send_command(cmd(0.05, at=1_000_100), now=1_000_100)
    assert fake.last_vel() != (0.0, 0.0)


@pytest.mark.parametrize("kind", KINDS)
def test_transport_error_faults_and_stops(kind):
    mgr, drv, fake, _ = make(kind)
    mgr.send_command(cmd(0.4), now=1_000_000)
    fake.fail = True
    with pytest.raises(RuntimeError, match="transport|failed"):
        mgr.send_command(cmd(0.4, at=1_000_050), now=1_000_050)
    st = mgr.status("drive")
    assert st.fault and "transport" in st.fault and not st.enabled
    mgr.watchdog_check("drive", now=1_000_060)  # stop() must not raise
    with pytest.raises(RuntimeError, match="fault"):
        mgr.enable("drive", True)


@pytest.mark.parametrize("kind", KINDS)
def test_reconnect_after_transport_error(kind):
    mgr, drv, fake, _ = make(kind)
    fake.fail = True
    with pytest.raises(RuntimeError):
        drv.send_velocity(0.1, 0.0)
    with pytest.raises(TransportError):
        mgr.connect("drive")  # still unplugged
    fake.fail = False
    st = mgr.connect("drive")
    assert st.connected and st.fault is None and not st.enabled
    assert st.details["reconnects"] == 1
    mgr.enable("drive", True)
    mgr.send_command(cmd(0.05), now=1_000_000)
    assert fake.last_vel() != (0.0, 0.0)


@pytest.mark.parametrize("kind", KINDS)
def test_silent_controller_is_a_fault(kind):
    mgr, drv, fake, _ = make(kind)
    fake.silent = True
    if kind in ("odrive_can", "vesc_can"):
        drv.clock.t += 1000  # cyclic frames stop; heartbeat/status goes stale
    st = mgr.status("drive")
    assert st.fault and not st.enabled


@pytest.mark.parametrize("kind", KINDS)
def test_disconnect_stops(kind):
    mgr, drv, fake, _ = make(kind)
    mgr.send_command(cmd(0.4), now=1_000_000)
    drv.disconnect()
    assert fake.last_vel() == (0.0, 0.0)
    assert not drv.status().connected


def test_clamp_keeps_turn_ratio():
    left, right, clamped = clamp_to_limits(0.5, 1.5, LIMITS, GEOMETRY)
    assert clamped and max(abs(left), abs(right)) <= 0.5 + 1e-9
    assert abs((right - left) / (right + left) - (0.3 / 0.5)) < 1e-9  # same arc as asked
    with pytest.raises(ValueError):
        clamp_to_limits(float("nan"), 0.0, LIMITS, GEOMETRY)


def test_nan_command_stops_instead_of_sending():
    _, drv, fake, _ = make("odrive_can")
    drv.send_velocity(0.1, 0.0)
    with pytest.raises(ValueError):
        drv.send_velocity(float("inf"), 0.0)
    assert fake.last_vel() == (0.0, 0.0)


# ---- driver-specific -------------------------------------------------------

def test_odrive_can_configures_velocity_mode_and_limit():
    _, drv, fake, _ = make("odrive_can")
    assert all(abs(v - MAX_TPS) < 1e-4 for v in fake.vel_limit.values())
    assert all(s == 8 for s in fake.state.values())  # closed loop after enable


def test_odrive_can_axis_error_is_fault():
    mgr, drv, fake, _ = make("odrive_can")
    fake.error[1] = 0x40
    st = mgr.status("drive")
    assert "axis error 0x00000040" in st.fault
    assert fake.estops >= 1


def test_odrive_can_axis_leaving_closed_loop_is_fault():
    mgr, drv, fake, _ = make("odrive_can")
    fake.state[0] = 1  # the ODrive disarmed itself
    assert "left closed loop" in mgr.status("drive").fault


def test_odrive_can_estop_uses_estop_message():
    _, drv, fake, _ = make("odrive_can")
    drv.set_estop(True)
    assert fake.estops == 2  # one Estop frame per node


def test_odrive_can_connect_needs_heartbeats():
    fake = FakeODriveBus()
    fake.silent = True
    drv = ODriveCanDriver("drive", fake, LIMITS, GEOMETRY, clock=Clock())
    with pytest.raises(TransportError, match="no heartbeat"):
        drv.connect()


def test_odrive_ascii_sets_vel_limit_and_checks_errors():
    mgr, drv, fake, _ = make("odrive_ascii")
    assert abs(float(fake.props["axis0.controller.config.vel_limit"]) - MAX_TPS) < 1e-4
    assert fake.props["axis1.controller.config.control_mode"] == "2"
    fake.errors[0] = 2
    assert "active_errors" in mgr.status("drive").fault


def test_dynamixel_configures_velocity_mode_and_watchdog():
    fake = FakeDynamixelLine()
    drv = DynamixelDriver("drive", fake, LIMITS, GEOMETRY, bus_watchdog_ms=100, clock=Clock())
    drv.connect()
    for i in (1, 2):
        assert fake.mem[i][dxl.ADDR_OPERATING_MODE] == dxl.OPERATING_MODE_VELOCITY
        assert fake.reg(i, dxl.ADDR_VELOCITY_LIMIT, 4) == dxl.velocity_to_raw(MAX_TPS)
        assert fake.mem[i][dxl.ADDR_BUS_WATCHDOG] == 5  # 100 ms / 20 ms
    drv.enable(True)
    assert fake.mem[1][dxl.ADDR_TORQUE_ENABLE] == 1


def test_dynamixel_estop_turns_torque_off():
    _, drv, fake, _ = make("dynamixel")
    drv.send_velocity(0.2, 0.0)
    drv.set_estop(True)
    assert fake.mem[1][dxl.ADDR_TORQUE_ENABLE] == 0 and fake.mem[2][dxl.ADDR_TORQUE_ENABLE] == 0


def test_dynamixel_hardware_alert_is_fault():
    mgr, drv, fake, _ = make("dynamixel")
    fake.hardware_error[2] = 0x04
    st = mgr.status("drive")
    assert "overheating" in st.fault and not st.enabled


def test_dynamixel_invert_right_wheel():
    fake = FakeDynamixelLine()
    geo = DriveGeometry(wheel_separation_m=0.4, wheel_radius_m=0.05, invert_right=True)
    drv = DynamixelDriver("drive", fake, LIMITS, geo, clock=Clock())
    drv.connect()
    drv.enable(True)
    drv.send_velocity(0.1, 0.0)
    assert fake.goal(1) > 0 and fake.goal(2) == -fake.goal(1)
    st = drv.status()
    assert st.velocity_left_mps > 0 and st.velocity_right_mps > 0


def test_vesc_uart_fault_code_is_fault():
    mgr, drv, fake, _ = make("vesc_uart")
    fake.fault[1] = 6
    assert "motor over temperature" in mgr.status("drive").fault


def test_vesc_disengage_is_zero_current():
    _, drv, fake, _ = make("vesc_can")
    drv.send_velocity(0.2, 0.0)
    drv.set_estop(True)
    assert fake.current == {0: 0.0, 1: 0.0}
