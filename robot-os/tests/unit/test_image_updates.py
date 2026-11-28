import json
import os
import subprocess
import sys
from pathlib import Path

from hannah_robot_os.common import now_ms
from hannah_robot_os.updates import boot
from hannah_robot_os.updates.state import UpdateState

ROBOT_ROOT = Path(__file__).resolve().parents[2]


def test_first_boot_records_the_running_version():
    state = UpdateState()
    assert boot.confirm(state, "0.2.0", "b1", robot_ready=True) == "recorded"
    assert state.current_version == "0.2.0" and state.last_good_version == "0.2.0"


def test_promote_after_booting_the_new_version():
    state = UpdateState(current_version="0.2.0", last_good_version="0.2.0")
    boot.stage(state, "0.3.0", "boot-1")
    assert boot.confirm(state, "0.2.0", "boot-1", robot_ready=True) == "pending", "same boot: not rebooted yet"
    assert boot.confirm(state, "0.3.0", "boot-2", robot_ready=True) == "promoted"
    assert state.current_version == "0.3.0" and state.last_good_version == "0.2.0"
    assert state.current_slot == "b" and state.pending_version is None


def test_fallback_to_the_old_version_is_recorded_as_rollback():
    state = UpdateState(current_version="0.2.0", last_good_version="0.2.0")
    boot.stage(state, "0.3.0", "boot-1")
    assert boot.confirm(state, "0.2.0", "boot-2", robot_ready=True) == "rolled-back"
    assert state.status == "rolled_back" and state.current_version == "0.2.0"


def test_not_ready_changes_nothing():
    state = UpdateState(current_version="0.2.0")
    boot.stage(state, "0.3.0", "boot-1")
    assert boot.confirm(state, "0.3.0", "boot-2", robot_ready=False) == "not-ready"
    assert state.pending_version == "0.3.0"


def test_stage_refuses_the_running_version():
    state = UpdateState(current_version="0.2.0")
    try:
        boot.stage(state, "0.2.0", None)
        assert False
    except ValueError:
        pass


def test_gate_requires_an_engaged_fresh_software_stop(tmp_path):
    assert boot.gate(tmp_path, 2000)[0] is False
    state = {"estop_active": False, "estop_latched": False, "fault": None, "state": "ok", "written_at_ms": now_ms()}
    (tmp_path / "state.json").write_text(json.dumps(state))
    ok, reason = boot.gate(tmp_path, 2000)
    assert not ok and "engage" in reason
    (tmp_path / "state.json").write_text(json.dumps({**state, "estop_active": True}))
    assert boot.gate(tmp_path, 2000)[0] is True
    (tmp_path / "state.json").write_text(json.dumps({**state, "estop_active": True, "written_at_ms": now_ms() - 60_000}))
    assert boot.gate(tmp_path, 2000)[0] is False


def test_os_release_version(tmp_path):
    p = tmp_path / "os-release"
    p.write_text('NAME="HANNAH Robot OS"\nVERSION_ID=0.1\nIMAGE_VERSION="0.1.0"\n')
    assert boot.read_os_release_version(p) == "0.1.0"
    assert boot.read_os_release_version(tmp_path / "missing") is None


def test_cli_stage_and_status(tmp_path):
    env = dict(os.environ, PYTHONPATH=str(ROBOT_ROOT / "src"))
    boot_id = tmp_path / "boot_id"
    boot_id.write_text("abc\n")
    state = tmp_path / "update.json"

    def run(*args):
        return subprocess.run([sys.executable, "-m", "hannah_robot_os", "update", *args, "--state", str(state),
                               "--boot-id-file", str(boot_id)], env=env, capture_output=True, text=True)

    staged = run("stage", "--version", "0.9.0")
    assert staged.returncode == 0, staged.stdout + staged.stderr
    assert json.loads(run("status").stdout)["staged_boot_id"] == "abc"
