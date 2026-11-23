import json
import subprocess
import sys
from pathlib import Path


def test_service_command_writes_status(tmp_path: Path):
    cmd = [
        sys.executable, "-m", "hannah_robot_os", "service", "safety-gateway",
        "--status-dir", str(tmp_path),
        "--interval", "0.01",
        "--max-ticks", "2",
    ]
    env = dict(**__import__("os").environ)
    repo_root = Path(__file__).resolve().parents[3]
    robot_os_root = repo_root / "robot-os"
    env["PYTHONPATH"] = str(robot_os_root / "src")
    r = subprocess.run(cmd, cwd=str(robot_os_root), env=env, capture_output=True, text=True, timeout=20)
    assert r.returncode == 0, r.stderr + r.stdout
    status = json.loads((tmp_path / "safety-gateway.json").read_text(encoding="utf-8"))
    assert status["service"] == "safety-gateway"
    states = [s["state"] for s in status["health"]["services"] if s["name"] == "safety-gateway"]
    assert "stopped" in states or "ready" in states
