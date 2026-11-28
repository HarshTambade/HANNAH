"""Remote recovery on the robot: which services may be restarted, config reloads,
and the maintenance features sent to the parent HANNAH.

The robot's own rules are what count: a signed, approved command that names a
safety or motion service is still refused here.
"""
import json
from pathlib import Path

import pytest

from hannah_robot_os.common import AuditLog
from hannah_robot_os.config import RobotOSConfig, SafetyLimits
from hannah_robot_os.motors.base import ControllerStatus
from hannah_robot_os.network.command_guard import CommandGuard, sign_command
from hannah_robot_os.network.dispatcher import RobotOSCommandDispatcher
from hannah_robot_os.safety.gateway import SafetyGateway
from hannah_robot_os.services.maintenance_features import MaintenanceFeatureWindow
from hannah_robot_os.services.service_manager import CRITICAL_SERVICES, RESTARTABLE_SERVICES, ConfigReloader, SystemdServiceManager, check_restart
from hannah_robot_os.updates.state import UpdateState

SECRET = "test-secret"


class FakeRunner:
    def __init__(self, code=0):
        self.calls, self.code = [], code

    def __call__(self, argv):
        self.calls.append(list(argv))
        return self.code, "" if self.code == 0 else "Access denied"


def command(capability, params, n=1):
    cmd = {"id": f"rosc_{n}", "robotId": "robot-dev", "capability": capability, "params": params, "issuedAt": 1000, "expiresAt": 9000, "nonce": f"nonce-{n}"}
    cmd["signature"] = sign_command(SECRET, cmd)
    return cmd


def dispatcher(tmp_path, services=None, reloader=None, safety=None):
    audit = AuditLog()
    return RobotOSCommandDispatcher(
        robot_id="robot-dev",
        guard=CommandGuard(secret=SECRET, now=lambda: 2000, state_path=tmp_path / "guard.json"),
        safety=safety or SafetyGateway(audit=audit, limits=SafetyLimits()),
        update_state=UpdateState(), audit=audit, now=lambda: 2000,
        services=services, config_reloader=reloader,
    )


def test_the_lists_are_disjoint_and_name_the_motion_and_safety_services():
    assert not RESTARTABLE_SERVICES & CRITICAL_SERVICES
    assert {"safety-gateway", "motor-controller"} <= CRITICAL_SERVICES
    for name in CRITICAL_SERVICES:
        assert check_restart(name)[0] is False


@pytest.mark.parametrize("name", sorted(CRITICAL_SERVICES))
def test_a_signed_restart_of_a_safety_or_motion_service_is_refused_and_systemctl_never_runs(tmp_path, name):
    runner = FakeRunner()
    ack = dispatcher(tmp_path, services=SystemdServiceManager(runner=runner)).handle(command("service.restart", {"service": name})).payload
    assert ack["ok"] is False
    assert "never restarted" in ack["reason"]
    assert runner.calls == []


def test_a_non_critical_service_is_restarted_through_systemd(tmp_path):
    runner = FakeRunner()
    ack = dispatcher(tmp_path, services=SystemdServiceManager(runner=runner)).handle(command("service.restart", {"service": "telemetry"})).payload
    assert ack == {"commandId": "rosc_1", "ok": True, "reason": "applied"}
    assert runner.calls == [["systemctl", "restart", "--no-block", "hannah-telemetry.service"]]


def test_a_failed_restart_is_answered_as_failed(tmp_path):
    ack = dispatcher(tmp_path, services=SystemdServiceManager(runner=FakeRunner(code=4))).handle(command("service.restart", {"service": "ai-runtime"})).payload
    assert ack["ok"] is False and "systemctl exited 4" in ack["reason"]


def test_no_service_manager_means_refused_and_unknown_services_too(tmp_path):
    assert dispatcher(tmp_path).handle(command("service.restart", {"service": "telemetry"})).payload["reason"] == "no service manager on this robot"
    assert "unknown" in dispatcher(tmp_path, services=SystemdServiceManager(runner=FakeRunner())).handle(command("service.restart", {"service": "bash"}, n=2)).payload["reason"]


def test_an_engaged_estop_refuses_remote_recovery(tmp_path):
    audit = AuditLog()
    safety = SafetyGateway(audit=audit, limits=SafetyLimits())
    safety.estop_active = True
    runner = FakeRunner()
    ack = dispatcher(tmp_path, services=SystemdServiceManager(runner=runner), safety=safety).handle(command("service.restart", {"service": "telemetry"})).payload
    assert ack["ok"] is False and "estop" in ack["reason"]
    assert runner.calls == []


def write_config(path: Path, **changes):
    data = RobotOSConfig().to_dict()
    data.update(changes)
    path.write_text(json.dumps(data), encoding="utf-8")


def test_config_reload_validates_and_refuses_a_safety_change(tmp_path):
    path = tmp_path / "config.json"
    runner = FakeRunner()
    reloader = ConfigReloader(config_path=path, running=RobotOSConfig(), services=SystemdServiceManager(runner=runner), audit=AuditLog())
    path.write_text("{not json", encoding="utf-8")
    assert reloader.reload()[0] is False
    write_config(path, safety={**SafetyLimits().__dict__, "max_linear_speed_mps": 2.0})
    ok, reason = reloader.reload()
    assert ok is False and "commissioning" in reason
    assert runner.calls == [], "nothing restarted for an unsafe file"
    write_config(path, offline_allowed=False)
    ok, reason = dispatcher(tmp_path, reloader=reloader).handle(command("config.reload", {})).payload["ok"], None
    assert ok is True
    assert [call[-1] for call in runner.calls] == ["hannah-telemetry.service", "hannah-ai-runtime.service", "hannah-remote-gateway.service"]
    assert not any("motor" in call[-1] or "safety" in call[-1] for call in runner.calls)


def status(cid="drive", at=1000, left=0.0, right=0.0, vl=0.5, vr=0.5, details=None, fault=None):
    return ControllerStatus(controller_id=cid, connected=True, enabled=True, fault=fault, encoder_left=left, encoder_right=right, velocity_left_mps=vl, velocity_right_mps=vr, last_feedback_ms=at, details=details or {})


def test_maintenance_features_summarise_what_the_driver_reported_and_nothing_else():
    window = MaintenanceFeatureWindow(window_ms=1000)
    window.add(status(at=1000, left=0.0, right=0.0, details={"input_voltage_v": 24.0, "temp_fet_c": [40.0, 42.0]}), 1000)
    window.add(status(at=1100, left=0.05, right=0.02, details={"input_voltage_v": 23.6, "temp_fet_c": [41.0, 43.0]}), 1100)
    assert window.due(2000) and not window.due(1500)
    payload = window.close(2000)
    controllers = payload["controllers"]
    assert controllers["drive"]["input_voltage_v"]["n"] == 2
    assert controllers["drive"]["input_voltage_v"]["min"] == 23.6
    assert controllers["drive-left"]["temp_fet_c"]["mean"] == 40.5
    # Encoder speed: left 0.05 m / 0.1 s = 0.5 m/s, as reported (residual 0); right 0.2 m/s against 0.5 reported.
    assert controllers["drive-left"]["encoder_residual_mps"]["last"] == 0.0
    assert controllers["drive-right"]["encoder_residual_mps"]["last"] == 0.3
    assert "current_a" not in controllers["drive"], "a value the driver didn't report is absent, not zero"
    assert window.close(3000) is None, "a new, empty window"


def test_controller_faults_are_listed_but_link_faults_are_not():
    window = MaintenanceFeatureWindow()
    window.add(status(fault="motor over temperature"), 1000)
    window.add(status(cid="b", fault="transport: no response"), 1000)
    codes = window.close(2000)["fault_codes"]
    assert [item["fault"] for item in codes] == ["motor over temperature"]
