"""Acceleration limits, the latched emergency stop and the watchdog stop."""
from hannah_robot_os.common import AuditLog, SafetyState, now_ms
from hannah_robot_os.config import SafetyLimits
from hannah_robot_os.motors.base import MotorCommand
from hannah_robot_os.motors.manager import MAX_RAMP_STEP_MS, MotorControllerManager, ramp_linear
from hannah_robot_os.motors.sim import SimMotorController
from hannah_robot_os.safety.gateway import SafetyGateway


def make_mgr(accel=1.0):
    audit = AuditLog()
    limits = SafetyLimits(max_linear_speed_mps=1.0, max_angular_speed_rps=2.0, max_acceleration_mps2=accel,
                          command_ttl_ms=500, watchdog_timeout_ms=500)
    mgr = MotorControllerManager(audit=audit, limits=limits)
    ctrl = SimMotorController(controller_id="c1")
    mgr.register_controller(ctrl)
    mgr.connect("c1")
    mgr.enable("c1", True)
    return mgr, ctrl, audit


def cmd(i, linear, t):
    return MotorCommand(command_id=f"m{i}", controller_id="c1", linear_x_mps=linear, issued_at_ms=t, ttl_ms=500, source="nav")


def test_ramp_function():
    assert ramp_linear(0.0, 0.5, 1.0, 100) == 0.1
    assert ramp_linear(0.1, 0.5, 1.0, 100) == 0.2
    assert ramp_linear(0.0, -0.5, 1.0, 100) == -0.1
    # a long pause earns no more than one step
    assert ramp_linear(0.0, 0.5, 1.0, 10_000) == 1.0 * MAX_RAMP_STEP_MS / 1000
    # slowing down and stopping are immediate
    assert ramp_linear(0.4, 0.0, 1.0, 1) == 0.0
    assert ramp_linear(0.4, 0.1, 1.0, 1) == 0.1
    assert ramp_linear(-0.4, 0.0, 1.0, 1) == 0.0
    # a reversal stops first
    assert ramp_linear(0.4, -0.4, 1.0, 100) == 0.0
    # zero means no limit configured
    assert ramp_linear(0.0, 0.5, 0.0, 100) == 0.5


def test_manager_ramps_speed_up_and_audits_it():
    mgr, ctrl, audit = make_mgr(accel=1.0)
    t = now_ms()
    mgr.send_command(cmd(1, 0.5, t), now=t)
    assert abs(ctrl._linear - 0.1) < 1e-9
    mgr.send_command(cmd(2, 0.5, t + 100), now=t + 100)
    assert abs(ctrl._linear - 0.2) < 1e-9
    ramped = [e for e in audit.list() if e.event == "command_ramped"]
    assert len(ramped) == 2
    assert ramped[0].data["requested_linear_x_mps"] == 0.5
    sent = [e for e in audit.list() if e.event == "command_sent"]
    assert abs(sent[-1].data["linear_x_mps"] - 0.2) < 1e-9

    # a stop command is applied at once
    mgr.send_command(cmd(3, 0.0, t + 110), now=t + 110)
    assert ctrl._linear == 0.0


def test_watchdog_stops_once_and_resets_ramp():
    mgr, ctrl, audit = make_mgr(accel=1.0)
    t = now_ms()
    mgr.send_command(cmd(1, 0.1, t), now=t)
    mgr.send_command(cmd(2, 0.2, t + 100), now=t + 100)
    assert abs(ctrl._linear - 0.2) < 1e-9

    mgr.watchdog_check("c1", now=t + 700)
    mgr.watchdog_check("c1", now=t + 800)
    mgr.watchdog_check("c1", now=t + 900)
    assert ctrl._linear == 0.0
    stops = [e for e in audit.list() if e.event == "watchdog_timeout_stop"]
    assert len(stops) == 1

    # after the watchdog stop, motion starts again from rest
    mgr.send_command(cmd(3, 0.5, t + 1000), now=t + 1000)
    assert abs(ctrl._linear - 0.1) < 1e-9


def gateway(latched=True):
    limits = SafetyLimits(max_linear_speed_mps=1.0, max_angular_speed_rps=1.0, command_ttl_ms=500, estop_latched=latched)
    return SafetyGateway(audit=AuditLog(), limits=limits)


def motion():
    return MotorCommand(command_id="g", controller_id="c1", linear_x_mps=0.1, issued_at_ms=now_ms(), ttl_ms=500, source="nav")


def test_latched_estop_needs_operator_reset():
    gw = gateway(latched=True)
    gw.set_estop(True)
    gw.set_estop(False)  # the button is released
    assert gw.state == SafetyState.ESTOP
    assert gw.estop_latched
    d = gw.evaluate_motion(motion())
    assert not d.allowed and "latched" in d.reason
    assert not gw.evaluate_admin_command("update.activate").allowed

    assert not gw.reset_estop("").allowed
    d = gw.reset_estop("operator-1")
    assert d.allowed
    assert gw.state == SafetyState.NORMAL
    assert gw.evaluate_motion(motion()).allowed
    assert any(e.event == "estop_reset" and e.data["operator"] == "operator-1" for e in gw.audit.list())


def test_reset_refused_while_estop_held():
    gw = gateway(latched=True)
    gw.set_estop(True)
    d = gw.reset_estop("operator-1")
    assert not d.allowed and "still active" in d.reason
    assert gw.state == SafetyState.ESTOP


def test_unlatched_estop_clears_on_release():
    gw = gateway(latched=False)
    gw.set_estop(True)
    gw.set_estop(False)
    assert gw.state == SafetyState.NORMAL
    assert gw.evaluate_motion(motion()).allowed


def test_fault_cleared_during_latch_stays_estop():
    gw = gateway(latched=True)
    gw.set_estop(True)
    gw.set_fault("encoder lost")
    gw.set_estop(False)
    gw.set_fault(None)
    assert gw.state == SafetyState.ESTOP
    gw.reset_estop("operator-1")
    assert gw.state == SafetyState.NORMAL
