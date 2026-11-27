"""The safety gateway's state reaches the other service processes.

Before, every service held its own SafetyGateway in memory, so an emergency
stop seen by the safety-gateway service never reached the motor controller.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from hannah_robot_os.common import AuditLog, SafetyState
from hannah_robot_os.config import SafetyLimits
from hannah_robot_os.safety import shared
from hannah_robot_os.safety.gateway import SafetyGateway

ROBOT_ROOT = Path(__file__).resolve().parents[2]


def gateway():
    return SafetyGateway(audit=AuditLog(), limits=SafetyLimits())


def test_a_follower_mirrors_the_published_state(tmp_path: Path):
    writer, follower = gateway(), gateway()
    shared.publish(writer, tmp_path, now=1000)
    assert shared.mirror(follower, tmp_path, stale_after_ms=2000, now=1500) is True

    shared.submit(tmp_path, "engage")
    shared.drain(writer, tmp_path)
    shared.publish(writer, tmp_path, now=2000)
    assert shared.mirror(follower, tmp_path, stale_after_ms=2000, now=2100) is False
    assert follower.state == SafetyState.ESTOP

    # Released but latched: the follower still may not move until an operator resets.
    shared.submit(tmp_path, "release")
    shared.drain(writer, tmp_path)
    shared.publish(writer, tmp_path, now=3000)
    assert shared.mirror(follower, tmp_path, stale_after_ms=2000, now=3100) is False
    assert follower.estop_latched

    shared.submit(tmp_path, "reset", operator="operator-1")
    handled = shared.drain(writer, tmp_path)
    assert handled == [{"kind": "reset", "ok": True, "reason": "reset"}]
    shared.publish(writer, tmp_path, now=4000)
    assert shared.mirror(follower, tmp_path, stale_after_ms=2000, now=4100) is True
    assert follower.state == SafetyState.NORMAL


def test_a_missing_or_stale_state_stops_motion(tmp_path: Path):
    follower = gateway()
    assert shared.mirror(follower, tmp_path, stale_after_ms=2000, now=1000) is False
    assert follower.fault == shared.NOT_REPORTING
    shared.publish(gateway(), tmp_path, now=1000)
    assert shared.mirror(follower, tmp_path, stale_after_ms=2000, now=9000) is False, "a gateway that stopped writing is a fault"


def test_requests_are_validated(tmp_path: Path):
    for kind, operator in [("shutdown", ""), ("reset", "")]:
        try:
            shared.submit(tmp_path, kind, operator)
            assert False, kind
        except ValueError:
            pass


def _run(*args, timeout=30):
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ROBOT_ROOT / "src")
    return [sys.executable, "-m", "hannah_robot_os", *args], env


def _audit(status_file: Path):
    try:
        return json.loads(status_file.read_text(encoding="utf-8")).get("audit_tail", [])
    except (OSError, ValueError):
        return []


def _wait(predicate, seconds=8.0):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.1)
    return False


def test_an_estop_requested_from_the_cli_reaches_the_motor_controller_process(tmp_path: Path):
    status = tmp_path / "data" / "status"
    common = ["--status-dir", str(status), "--interval", "0.05", "--max-ticks", "400"]
    cmd, env = _run("service", "safety-gateway", *common)
    gateway_process = subprocess.Popen(cmd, cwd=str(ROBOT_ROOT), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    cmd, env = _run("service", "motor-controller", *common)
    motor_process = subprocess.Popen(cmd, cwd=str(ROBOT_ROOT), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    motor_status = status / "motor-controller.json"
    try:
        assert _wait(lambda: (tmp_path / "data" / "safety" / "state.json").exists()), "the gateway never published"
        cmd, env = _run("safety", "engage", "--safety-dir", str(tmp_path / "data" / "safety"))
        assert subprocess.run(cmd, cwd=str(ROBOT_ROOT), env=env, capture_output=True, text=True).returncode == 0

        def stopped_for_estop():
            return any(event["event"] == "mirrored" and event["data"].get("estop_active") for event in _audit(motor_status))
        assert _wait(stopped_for_estop), "the motor controller never saw the emergency stop"

        # The gateway goes away: its state goes stale and the motor controller treats that as a fault.
        gateway_process.terminate()
        gateway_process.wait(timeout=10)

        def faulted():
            return any(event["event"] == "mirrored" and event["data"].get("fault") == shared.NOT_REPORTING for event in _audit(motor_status))
        assert _wait(faulted, seconds=10), "a dead safety gateway went unnoticed"
    finally:
        for process in (gateway_process, motor_process):
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
