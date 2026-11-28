"""A signed command is bound to one robot and to a short life."""
from hannah_robot_os.common import AuditLog
from hannah_robot_os.config import SafetyLimits
from hannah_robot_os.network.command_guard import CommandGuard, sign_command
from hannah_robot_os.network.dispatcher import RobotOSCommandDispatcher
from hannah_robot_os.safety.gateway import SafetyGateway
from hannah_robot_os.updates.state import UpdateState


def _command(robot_id: str = "robot-a", issued: int = 1000, expires: int = 9000, nonce: str = "n-1") -> dict:
    command = {"id": "c1", "robotId": robot_id, "capability": "diagnostics.run", "issuedAt": issued, "expiresAt": expires, "nonce": nonce, "params": {}}
    command["signature"] = sign_command("shared-secret", command)
    return command


def test_guard_refuses_a_command_for_another_robot_even_with_a_valid_signature():
    guard = CommandGuard(secret="shared-secret", now=lambda: 2000, robot_id="robot-b")
    assert guard.verify(_command("robot-a")) == (False, "command for another robot")
    assert guard.verify(_command("robot-b", nonce="n-2"))[0] is True


def test_guard_refuses_a_command_that_claims_a_long_life():
    guard = CommandGuard(secret="shared-secret", now=lambda: 2000)
    assert guard.verify(_command(expires=1000 + 60 * 60_000)) == (False, "command lifetime too long")


def test_dispatcher_refuses_another_robots_command_without_using_its_nonce():
    audit = AuditLog()
    guard = CommandGuard(secret="shared-secret", now=lambda: 2000)
    dispatcher = RobotOSCommandDispatcher(robot_id="robot-b", guard=guard, safety=SafetyGateway(audit=audit, limits=SafetyLimits()), update_state=UpdateState(), audit=audit, now=lambda: 2000)
    ack = dispatcher.handle(_command("robot-a"))
    assert ack.payload == {"commandId": "c1", "ok": False, "reason": "command for another robot"}
    # The nonce wasn't consumed: robot-a's own guard would still take it.
    assert CommandGuard(secret="shared-secret", now=lambda: 2000).verify(_command("robot-a"))[0] is True
