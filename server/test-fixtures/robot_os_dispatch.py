"""Run one Robot OS signed command through the real Robot OS dispatcher (robot-os/src).

Used by server tests as the robot side of an update rollout: the server's
signed command goes in, the robot's own checks run (command signature,
Ed25519 package signature with the keys pinned here, compatibility with this
robot's facts, READY gate, health checks), and the ack it would send comes out.
Its update state, nonce store and answers persist in the state folder between
runs, as on a robot. This is not a simulator and touches no hardware.

    python3 robot_os_dispatch.py <state-dir>  < {"secret", "robotId", "command", "trustedKeys", "facts", "ready", "healthChecks"}
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "robot-os" / "src"))

from hannah_robot_os.common import AuditLog  # noqa: E402
from hannah_robot_os.config import SafetyLimits  # noqa: E402
from hannah_robot_os.network.command_guard import CommandGuard  # noqa: E402
from hannah_robot_os.network.dispatcher import RobotOSCommandDispatcher  # noqa: E402
from hannah_robot_os.safety.gateway import SafetyGateway  # noqa: E402
from hannah_robot_os.updates.package import load_trusted_keys  # noqa: E402
from hannah_robot_os.updates.state import UpdateState  # noqa: E402


def main() -> int:
    state_dir = Path(sys.argv[1])
    state_dir.mkdir(parents=True, exist_ok=True)
    request = json.loads(sys.stdin.read())
    keys_path = state_dir / "trusted-keys.json"
    keys_path.write_text(json.dumps(request["trustedKeys"]), encoding="utf-8")
    config = state_dir / "robot.json"
    if not config.exists():
        config.write_text(json.dumps({"maxLinearSpeed": 0.5}), encoding="utf-8")
    state_path = state_dir / "update-state.json"
    state = UpdateState.load(state_path)
    audit = AuditLog()
    dispatcher = RobotOSCommandDispatcher(
        robot_id=request["robotId"],
        guard=CommandGuard(secret=request["secret"], state_path=state_dir / "guard.json"),
        safety=SafetyGateway(audit=audit, limits=SafetyLimits()),
        update_state=state,
        audit=audit,
        health_snapshot=lambda: {"robot_ready": bool(request.get("ready", True))},
        results_path=state_dir / "results.json",
        trusted_keys=load_trusted_keys(keys_path),
        facts=request["facts"],
        backup_root=state_dir / "backups",
        backup_files=[config],
        validate_backup=lambda path: json.loads(path.read_text(encoding="utf-8")),
        health_checks={name: (lambda ok=ok: ok) for name, ok in (request.get("healthChecks") or {}).items()},
    )
    ack = dispatcher.handle(request["command"])
    state.save(state_path)
    print(json.dumps(ack.payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
