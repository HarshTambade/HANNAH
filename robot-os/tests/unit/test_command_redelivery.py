"""A Robot OS command delivered twice, or after a restart, runs once and gets one answer."""
import json
from pathlib import Path

from hannah_robot_os.common import AuditLog
from hannah_robot_os.config import SafetyLimits
from hannah_robot_os.network.command_guard import CommandGuard, sign_command
from hannah_robot_os.network.dispatcher import RobotOSCommandDispatcher
from hannah_robot_os.safety.gateway import SafetyGateway
from hannah_robot_os.updates.state import UpdateState

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "signed_command.json"


def dispatcher(data, tmp_path, state=None):
    audit = AuditLog()
    return RobotOSCommandDispatcher(
        robot_id="robot-dev",
        guard=CommandGuard(secret=data["secret"], now=lambda: 2000, state_path=tmp_path / "guard.json"),
        safety=SafetyGateway(audit=audit, limits=SafetyLimits()),
        update_state=state or UpdateState(),
        audit=audit,
        now=lambda: 2000,
        results_path=tmp_path / "results.json",
    )


def test_a_repeated_delivery_gets_the_first_answer_not_a_failure(tmp_path: Path):
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    d = dispatcher(data, tmp_path)
    assert d.handle(dict(data["command"])).payload["ok"] is True
    again = d.handle(dict(data["command"])).payload
    assert again["ok"] is True, "a lost ack used to turn into 'replayed command' and a failed command"
    assert again["reason"] == "applied"
    assert len(d._applied) == 1


def test_after_a_restart_the_same_command_does_not_run_again(tmp_path: Path):
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    state = UpdateState()
    assert dispatcher(data, tmp_path, state).handle(dict(data["command"])).payload["ok"] is True
    restarted = dispatcher(data, tmp_path, UpdateState())
    answer = restarted.handle(dict(data["command"])).payload
    assert answer["ok"] is True
    assert restarted._applied == [], "it ran a second time after the restart"


def test_text_utf8_cannot_encode_is_refused_not_a_crash(tmp_path: Path):
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    command = dict(data["command"])
    command["params"] = {"reason": "cut mid emoji \ud83d"}
    command["signature"] = "0" * 64
    ack = dispatcher(data, tmp_path).handle(command).payload
    assert ack["ok"] is False
    assert ack["reason"] == "malformed command"
    command["issuedAt"] = "not a number"
    assert dispatcher(data, tmp_path).handle(command).payload["reason"] == "malformed command"
