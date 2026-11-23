import json
import subprocess
import sys
from pathlib import Path


def test_ready_marker_requires_service_status(tmp_path: Path):
    repo_root = Path(__file__).resolve().parents[3]
    robot_root = repo_root / "robot-os"
    cfg = {
        "robot_id": "r1", "profile": "robotos-dev-x86_64",
        "data_dir": str(tmp_path / "data"),
        "required_services": ["safety-gateway"],
    }
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps(cfg), encoding="utf-8")
    env = dict(**__import__("os").environ)
    env["PYTHONPATH"] = str(robot_root / "src")
    cmd = [sys.executable, "-m", "hannah_robot_os", "ready", "--config", str(cfg_path)]

    r1 = subprocess.run(cmd, cwd=str(robot_root), env=env, capture_output=True, text=True)
    assert r1.returncode == 1
    assert "HANNAH Robot OS READY" not in r1.stdout

    status_dir = tmp_path / "data" / "status"
    status_dir.mkdir(parents=True)
    (status_dir / "safety-gateway.json").write_text(json.dumps({"service": "safety-gateway"}), encoding="utf-8")
    r2 = subprocess.run(cmd, cwd=str(robot_root), env=env, capture_output=True, text=True)
    assert r2.returncode == 0
    assert "HANNAH Robot OS READY" in r2.stdout
