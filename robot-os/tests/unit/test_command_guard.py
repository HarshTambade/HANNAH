import json
from pathlib import Path

from hannah_robot_os.common import AuditLog, SafetyState
from hannah_robot_os.network.command_guard import CommandGuard, command_message, sign_command
from hannah_robot_os.network.dispatcher import RobotOSCommandDispatcher
from hannah_robot_os.safety.gateway import SafetyGateway
from hannah_robot_os.updates.state import UpdateState

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "signed_command.json"


def test_javascript_signature_is_accepted():
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    guard = CommandGuard(secret=data["secret"], now=lambda: 2000)
    ok, reason = guard.verify(dict(data["command"]))
    assert ok, reason
    assert guard.verify(dict(data["command"]))[1] == "replayed command"


def test_tampered_params_rejected():
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    cmd = dict(data["command"])
    cmd["params"] = {"version": "0.3.0"}
    guard = CommandGuard(secret=data["secret"], now=lambda: 2000)
    assert guard.verify(cmd)[1] == "bad signature"


def test_dispatcher_applies_stage_and_acks():
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    audit = AuditLog()
    safety = SafetyGateway(audit=audit, limits=__import__("hannah_robot_os.config", fromlist=["SafetyLimits"]).SafetyLimits())
    state = UpdateState()
    dispatcher = RobotOSCommandDispatcher(
        robot_id="robot-dev",
        guard=CommandGuard(secret=data["secret"], now=lambda: 2000),
        safety=safety,
        update_state=state,
        audit=audit,
        now=lambda: 2000,
    )
    ack = dispatcher.handle(dict(data["command"]))
    assert ack.kind == "command_ack"
    assert ack.payload["ok"] is True
    assert state.pending_version == "0.2.0"
    assert state.status == "staged"


def test_dispatcher_refuses_when_estop_active():
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    audit = AuditLog()
    safety = SafetyGateway(audit=audit, limits=__import__("hannah_robot_os.config", fromlist=["SafetyLimits"]).SafetyLimits())
    safety.set_estop(True)
    assert safety.state == SafetyState.ESTOP
    dispatcher = RobotOSCommandDispatcher(
        robot_id="robot-dev",
        guard=CommandGuard(secret=data["secret"], now=lambda: 2000),
        safety=safety,
        update_state=UpdateState(),
        audit=audit,
        now=lambda: 2000,
    )
    ack = dispatcher.handle(dict(data["command"]))
    assert ack.payload["ok"] is False
    assert "estop" in ack.payload["reason"]


def test_activation_requires_local_ready_gate():
    audit = AuditLog()
    safety = SafetyGateway(audit=audit, limits=__import__("hannah_robot_os.config", fromlist=["SafetyLimits"]).SafetyLimits())
    state = UpdateState()
    state.stage("0.2.0")
    cmd = {"id": "c_activate", "robotId": "robot-dev", "capability": "update.activate", "issuedAt": 1000, "expiresAt": 9000, "nonce": "n-activate", "params": {"version": "0.2.0"}}
    cmd["signature"] = sign_command("secret", cmd)

    def dispatcher(health):
        return RobotOSCommandDispatcher(
            robot_id="robot-dev",
            guard=CommandGuard(secret="secret", now=lambda: 2000),
            safety=safety,
            update_state=state,
            audit=audit,
            now=lambda: 2000,
            health_snapshot=lambda: health,
        )

    refused = dispatcher({"robot_ready": False}).handle(dict(cmd))
    assert refused.payload["ok"] is False
    assert "not ready" in refused.payload["reason"]
    assert state.status == "staged"

    accepted = dispatcher({"robot_ready": True}).handle(dict(cmd))
    assert accepted.payload["ok"] is True
    assert state.current_version == "0.2.0"
    assert state.status == "healthy"


def test_command_message_and_sign_roundtrip():
    cmd = {"id": "c1", "robotId": "r1", "capability": "update.rollback", "issuedAt": 1, "expiresAt": 9, "nonce": "n", "params": {"reason": "bad"}}
    sig = sign_command("s", cmd)
    assert len(sig) == 64
    assert "r1" in command_message(cmd)
