from hannah_robot_os.common import AuditLog, SafetyState, now_ms
from hannah_robot_os.config import SafetyLimits
from hannah_robot_os.motors.base import MotorCommand
from hannah_robot_os.safety.gateway import SafetyGateway


def make_gateway():
    return SafetyGateway(audit=AuditLog(), limits=SafetyLimits(max_linear_speed_mps=1.0, max_angular_speed_rps=1.0, command_ttl_ms=500))


def test_allows_valid_motion():
    gw = make_gateway()
    cmd = MotorCommand(command_id="c1", controller_id="m1", linear_x_mps=0.3, issued_at_ms=now_ms(), ttl_ms=500, source="nav")
    d = gw.evaluate_motion(cmd)
    assert d.allowed
    assert d.state == SafetyState.NORMAL


def test_denies_estop():
    gw = make_gateway()
    gw.set_estop(True)
    cmd = MotorCommand(command_id="c2", controller_id="m1", linear_x_mps=0.0, issued_at_ms=now_ms(), ttl_ms=500, source="nav")
    d = gw.evaluate_motion(cmd)
    assert not d.allowed
    assert d.state == SafetyState.ESTOP


def test_denies_expired():
    gw = make_gateway()
    cmd = MotorCommand(command_id="c3", controller_id="m1", linear_x_mps=0.1, issued_at_ms=now_ms() - 2000, ttl_ms=100, source="nav")
    d = gw.evaluate_motion(cmd)
    assert not d.allowed
    assert "expired" in d.reason


def test_denies_raw_ai():
    gw = make_gateway()
    cmd = MotorCommand(command_id="c4", controller_id="m1", linear_x_mps=0.1, issued_at_ms=now_ms(), ttl_ms=500, source="ai_raw")
    d = gw.evaluate_motion(cmd)
    assert not d.allowed
    assert "raw AI" in d.reason


def test_denies_unhealthy_required_sensors():
    gw = make_gateway()
    gw.set_required_sensors_ok(False)
    cmd = MotorCommand(command_id="c5", controller_id="m1", linear_x_mps=0.1, issued_at_ms=now_ms(), ttl_ms=500, source="nav")
    d = gw.evaluate_motion(cmd)
    assert not d.allowed
    assert "sensors" in d.reason
