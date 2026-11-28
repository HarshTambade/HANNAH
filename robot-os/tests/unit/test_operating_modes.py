"""Operating modes on Robot OS: the transition table, Safety Stop through the latched software stop, shared across services."""
from pathlib import Path

from hannah_robot_os.common import AuditLog, now_ms
from hannah_robot_os.config import SafetyLimits
from hannah_robot_os.motors.base import MotorCommand
from hannah_robot_os.safety import modes, shared
from hannah_robot_os.safety.gateway import SafetyGateway


def gateway():
    return SafetyGateway(audit=AuditLog(), limits=SafetyLimits())


def motion(source="nav", linear=0.1):
    return MotorCommand(command_id="c1", controller_id="base", linear_x_mps=linear, issued_at_ms=now_ms(), ttl_ms=500, source=source)


def test_the_table_matches_the_server_and_runtime():
    assert modes.TRANSITIONS["safety_stop"] == ("manual", "maintenance")
    assert modes.transition_refusal("manual", "mission")
    assert not modes.transition_refusal("supervised", "mission")


def test_each_mode_lets_through_only_its_sources():
    gw = gateway()
    assert gw.operating_mode == "supervised"
    assert gw.evaluate_motion(motion("nav")).allowed
    assert not gw.evaluate_motion(motion("teleop")).allowed
    assert gw.set_mode("manual", "asha").allowed
    assert not gw.evaluate_motion(motion("nav")).allowed
    assert gw.evaluate_motion(motion("teleop")).allowed
    assert gw.set_mode("maintenance", "asha").allowed
    assert gw.evaluate_motion(motion("teleop", 0.15)).allowed
    assert "jogging" in gw.evaluate_motion(motion("teleop", 0.4)).reason
    # Not straight from Maintenance to Mission Autonomy; and every change but into Safety Stop needs an operator.
    assert not gw.set_mode("mission", "asha").allowed
    assert gw.set_mode("manual", "").reason == "operator required"


def test_safety_stop_engages_the_latched_stop_and_is_left_only_after_release():
    gw = gateway()
    assert gw.set_mode("safety_stop").allowed
    assert gw.estop_active and gw.estop_latched
    assert not gw.evaluate_motion(motion("nav")).allowed
    assert not gw.set_mode("supervised", "asha").allowed, "never straight back to autonomy"
    assert gw.set_mode("manual", "asha").reason == "stop input still active"
    gw.set_estop(False)
    assert gw.set_mode("manual", "asha").allowed
    assert not gw.estop_latched
    events = [event.event for event in gw.audit.list()]
    assert "mode_changed" in events and "mode_refused" in events


def test_the_mode_is_shared_with_every_service_and_survives_a_restart(tmp_path: Path):
    writer, follower = gateway(), gateway()
    shared.submit(tmp_path, "mode", "", mode="safety_stop")
    handled = shared.drain(writer, tmp_path)
    assert handled[0]["ok"] and handled[0]["mode"] == "safety_stop"
    shared.publish(writer, tmp_path, now=1000)
    assert shared.mirror(follower, tmp_path, stale_after_ms=2000, now=1500) is False
    assert follower.operating_mode == "safety_stop"
    restarted = gateway()
    assert shared.restore(restarted, tmp_path) == "safety_stop"
    assert restarted.estop_active
    # A state file that can't be read is taken as Safety Stop.
    (tmp_path / shared.STATE_FILE).write_text("{broken", encoding="utf-8")
    assert shared.restore(gateway(), tmp_path) == "safety_stop"


def test_an_unknown_mode_from_the_state_file_is_safety_stop():
    gw = gateway()
    gw.mirror(estop_active=False, estop_latched=False, fault=None, operating_mode="turbo")
    assert gw.operating_mode == "safety_stop"
