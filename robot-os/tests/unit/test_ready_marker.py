import json
import os
import subprocess
import sys
from pathlib import Path

from hannah_robot_os.common import now_ms
from hannah_robot_os.services.status_files import service_ready

ROBOT_ROOT = Path(__file__).resolve().parents[2]


def _env():
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ROBOT_ROOT / "src")
    return env


def _run(*args):
    cmd = [sys.executable, "-m", "hannah_robot_os", *args]
    return subprocess.run(cmd, cwd=str(ROBOT_ROOT), env=_env(), capture_output=True, text=True)


def _config(tmp_path: Path) -> Path:
    cfg = {
        "robot_id": "r1",
        "profile": "robotos-dev-x86_64",
        "data_dir": str(tmp_path / "data"),
        "required_services": ["safety-gateway"],
    }
    path = tmp_path / "config.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    return path


def _status(name: str, state: str, written_at_ms: int | None) -> dict:
    data = {"service": name, "health": {"services": [{"name": name, "state": state}]}}
    if written_at_ms is not None:
        data["written_at_ms"] = written_at_ms
    return data


def _write(status_dir: Path, name: str, data: dict) -> None:
    status_dir.mkdir(parents=True, exist_ok=True)
    (status_dir / f"{name}.json").write_text(json.dumps(data), encoding="utf-8")


def test_ready_marker_requires_fresh_ready_status(tmp_path: Path):
    cfg_path = _config(tmp_path)
    status_dir = tmp_path / "data" / "status"

    r = _run("ready", "--config", str(cfg_path))
    assert r.returncode == 1
    assert "HANNAH Robot OS READY" not in r.stdout

    _write(status_dir, "safety-gateway", _status("safety-gateway", "ready", now_ms()))
    r = _run("ready", "--config", str(cfg_path))
    assert r.returncode == 0, r.stdout
    assert "HANNAH Robot OS READY" in r.stdout


def test_ready_marker_refuses_file_left_by_stopped_service(tmp_path: Path):
    cfg_path = _config(tmp_path)
    status_dir = tmp_path / "data" / "status"
    # A real service run: it writes READY while ticking and STOPPED on exit.
    r = _run("service", "safety-gateway", "--config", str(cfg_path),
             "--status-dir", str(status_dir), "--interval", "0", "--max-ticks", "1")
    assert r.returncode == 0, r.stderr
    assert (status_dir / "safety-gateway.json").exists()

    r = _run("ready", "--config", str(cfg_path))
    assert r.returncode == 1
    assert "service state is stopped" in r.stdout


def test_service_ready_rejects_bad_files(tmp_path: Path):
    now = now_ms()
    cases = {
        "name only": {"service": "safety-gateway"},
        "faulted": _status("safety-gateway", "fault", now),
        "no write time": _status("safety-gateway", "ready", None),
        "stale": _status("safety-gateway", "ready", now - 60_000),
        "future": _status("safety-gateway", "ready", now + 60_000),
        "other service": _status("telemetry", "ready", now),
    }
    for label, data in cases.items():
        _write(tmp_path, "safety-gateway", data)
        ok, reason = service_ready(tmp_path, "safety-gateway", now=now)
        assert not ok, label
        assert reason

    (tmp_path / "safety-gateway.json").write_text("{not json", encoding="utf-8")
    assert service_ready(tmp_path, "safety-gateway", now=now) == (False, "unreadable status file")


def test_recovery_exit_refuses_stale_ready_status(tmp_path: Path):
    cfg_path = _config(tmp_path)
    status_dir = tmp_path / "data" / "status"
    state = tmp_path / "recovery.json"
    assert _run("recovery", "enter", "--state", str(state), "--reason", "test").returncode == 0

    _write(status_dir, "safety-gateway", _status("safety-gateway", "ready", now_ms() - 60_000))
    r = _run("recovery", "exit", "--state", str(state), "--config", str(cfg_path))
    assert r.returncode == 1

    _write(status_dir, "safety-gateway", _status("safety-gateway", "ready", now_ms()))
    r = _run("recovery", "exit", "--state", str(state), "--config", str(cfg_path))
    assert r.returncode == 0, r.stdout
