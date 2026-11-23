from hannah_robot_os.common import AuditLog, now_ms
from hannah_robot_os.config import SafetyLimits
from hannah_robot_os.motors.base import MotorCommand
from hannah_robot_os.motors.manager import MotorControllerManager
from hannah_robot_os.motors.sim import SimMotorController


def make_mgr():
    audit = AuditLog()
    limits = SafetyLimits(max_linear_speed_mps=1.0, max_angular_speed_rps=2.0, command_ttl_ms=500, watchdog_timeout_ms=500)
    mgr = MotorControllerManager(audit=audit, limits=limits)
    ctrl = SimMotorController(controller_id="c1")
    mgr.register_controller(ctrl)
    mgr.connect("c1")
    mgr.enable("c1", True)
    return mgr, ctrl, audit


def test_send_valid_command():
    mgr, ctrl, _ = make_mgr()
    cmd = MotorCommand(command_id="cmd1", controller_id="c1", linear_x_mps=0.2, angular_z_rps=0.1, issued_at_ms=now_ms(), ttl_ms=500, source="nav")
    st = mgr.send_command(cmd)
    assert st.connected and st.enabled
    assert st.velocity_left_mps is not None


def test_reject_expired_command():
    mgr, _, _ = make_mgr()
    cmd = MotorCommand(command_id="cmd2", controller_id="c1", linear_x_mps=0.2, issued_at_ms=now_ms() - 1000, ttl_ms=100, source="nav")
    try:
        mgr.send_command(cmd)
        assert False, "should have failed"
    except ValueError as e:
        assert "expired" in str(e)


def test_reject_excess_speed():
    mgr, _, _ = make_mgr()
    cmd = MotorCommand(command_id="cmd3", controller_id="c1", linear_x_mps=2.0, issued_at_ms=now_ms(), ttl_ms=500, source="nav")
    try:
        mgr.send_command(cmd)
        assert False, "should have failed"
    except ValueError as e:
        assert "exceeds limit" in str(e)


def test_reject_raw_ai_command():
    mgr, _, _ = make_mgr()
    cmd = MotorCommand(command_id="cmd4", controller_id="c1", linear_x_mps=0.1, issued_at_ms=now_ms(), ttl_ms=500, source="ai_raw")
    try:
        mgr.send_command(cmd)
        assert False, "should have failed"
    except ValueError as e:
        assert "raw AI" in str(e)


def test_estop_blocks_enable_and_command():
    mgr, ctrl, _ = make_mgr()
    ctrl.trigger_estop(True)
    try:
        mgr.enable("c1", True)
        assert False, "should fail"
    except RuntimeError:
        pass
    ctrl.trigger_estop(False)
    mgr.enable("c1", True)
    ctrl.trigger_estop(True)
    cmd = MotorCommand(command_id="cmd5", controller_id="c1", linear_x_mps=0.1, issued_at_ms=now_ms(), ttl_ms=500, source="nav")
    try:
        mgr.send_command(cmd)
        assert False, "should fail"
    except RuntimeError as e:
        assert "estop" in str(e)


def test_watchdog_timeout_stops_controller():
    mgr, ctrl, _ = make_mgr()
    cmd = MotorCommand(command_id="cmd6", controller_id="c1", linear_x_mps=0.2, issued_at_ms=now_ms(), ttl_ms=500, source="nav")
    mgr.send_command(cmd)
    st = mgr.watchdog_check("c1", now=now_ms() + 1000)
    assert st.velocity_left_mps == 0.0 or st.velocity_right_mps == 0.0
