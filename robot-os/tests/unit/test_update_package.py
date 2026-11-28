"""Signed update packages on the robot: Ed25519, the server's canonical form, compatibility, backups and the dispatcher."""
import base64
import copy
import json
from pathlib import Path

import pytest

from hannah_robot_os.common import AuditLog
from hannah_robot_os.config import SafetyLimits
from hannah_robot_os.network.command_guard import CommandGuard, sign_command
from hannah_robot_os.network.dispatcher import RobotOSCommandDispatcher
from hannah_robot_os.safety.gateway import SafetyGateway
from hannah_robot_os.updates import backup, ed25519
from hannah_robot_os.updates.package import PackageError, canonical, compatibility, load_trusted_keys, satisfies, verify_package
from hannah_robot_os.updates.state import UpdateState

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "signed_update_package.json").read_text(encoding="utf-8"))
FACTS = {"manufacturer": "Acme", "model": "Rover 2", "robotType": "differential-drive", "os": "HANNAH Robot OS 0.2.1", "rosDistro": "", "runtimeVersion": "0.1.0", "softwareVersion": "2.0.0", "firmwareVersion": "fw-3.1", "serialNumber": "AC-0042"}


def trusted(tmp_path: Path, revoked: bool = False) -> dict:
    path = tmp_path / "trusted-keys.json"
    path.write_text(json.dumps([{"owner": FIXTURE["owner"], "publicKey": FIXTURE["publicKey"], "revoked": revoked}]), encoding="utf-8")
    return load_trusted_keys(path)


def test_rfc8032_vector_1():
    secret = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    public = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
    signature = bytes.fromhex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")
    assert ed25519.public_key(secret) == public
    assert ed25519.sign(secret, b"") == signature
    assert ed25519.verify(public, b"", signature)
    assert not ed25519.verify(public, b"x", signature)
    assert not ed25519.verify(public, b"", signature[:-1] + bytes([signature[-1] ^ 1]))


def test_a_node_signature_verifies_here_byte_for_byte():
    manifest = FIXTURE["manifest"]
    key = ed25519.public_key_from_pem(FIXTURE["publicKey"])
    assert ed25519.key_id(key) == FIXTURE["keyId"] == manifest["signature"]["keyId"]
    body = canonical({k: v for k, v in manifest.items() if k != "signature"}).encode("utf-8")
    assert ed25519.verify(key, body, base64.b64decode(manifest["signature"]["value"]))
    assert "0.4" in canonical(manifest["config"]) and "→" in canonical(manifest["changelog"])


def test_verify_package_checks_key_publisher_and_hardware(tmp_path: Path):
    keys = trusted(tmp_path)
    manifest = FIXTURE["manifest"]
    assert verify_package(manifest, keys, FACTS)["version"] == "1.4.0"
    with pytest.raises(PackageError, match="doesn't trust"):
        verify_package(manifest, {}, FACTS)
    with pytest.raises(PackageError, match="revoked"):
        revoked_dir = tmp_path / "revoked"
        revoked_dir.mkdir()
        verify_package(manifest, trusted(revoked_dir, revoked=True), FACTS)
    tampered = copy.deepcopy(manifest)
    tampered["config"]["limits"]["maxLinearSpeed"] = 0.9
    with pytest.raises(PackageError, match="doesn't match"):
        verify_package(tampered, keys, FACTS)
    with pytest.raises(PackageError, match="other hardware"):
        verify_package(manifest, keys, {**FACTS, "model": "Rover 3"})
    with pytest.raises(PackageError, match="firmware"):
        verify_package(manifest, keys, {**FACTS, "firmwareVersion": "fw-2.0"})
    firmware = {**copy.deepcopy(manifest), "kind": "firmware"}
    with pytest.raises(PackageError, match="never staged"):
        verify_package(firmware, keys, FACTS)
    artifact_dir = tmp_path / "artifact"
    artifact_dir.mkdir()
    (artifact_dir / "nav.json").write_text(FIXTURE["artifact"]["content"], encoding="utf-8")
    verify_package(manifest, keys, FACTS, artifact_dir)
    (artifact_dir / "nav.json").write_text("evil", encoding="utf-8")
    with pytest.raises(PackageError, match="mismatch"):
        verify_package(manifest, keys, FACTS, artifact_dir)


def test_ranges_match_the_server():
    assert satisfies("0.2.0", ">=0.1.0 <0.3.0") and not satisfies("0.3.0", ">=0.1.0 <0.3.0")
    assert satisfies("1.4.2", "^1.2.0") and not satisfies("2.0.0", "^1.2.0")
    assert satisfies("0.3.9", "^0.3.1") and not satisfies("0.4.0", "^0.3.1")
    assert not satisfies("1.3.0-rc.1", "^1.2.0") and satisfies("1.3.0-rc.2", ">=1.3.0-rc.1")
    assert satisfies("5.0.0", "<1.0.0 || >=5.0.0") and satisfies("9.9.9", "*") and not satisfies("bad", "*")
    assert compatibility(FIXTURE["manifest"], {**FACTS, "os": "Ubuntu 24.04"})


def test_backup_restore_validates_and_refuses_other_hardware(tmp_path: Path):
    config = tmp_path / "robot.json"
    config.write_text('{"max_speed": 0.5}', encoding="utf-8")
    backup.take(tmp_path / "backups", "bk1", [config], FACTS, now=lambda: 1)
    config.write_text('{"max_speed": 0.9}', encoding="utf-8")
    with pytest.raises(backup.BackupError, match="hardware changed"):
        backup.restore(tmp_path / "backups", "bk1", {**FACTS, "serialNumber": "AC-0099"})
    with pytest.raises(backup.BackupError, match="doesn't validate"):
        backup.restore(tmp_path / "backups", "bk1", FACTS, validate=lambda path: (_ for _ in ()).throw(ValueError("speed over limit")))
    assert json.loads(config.read_text())["max_speed"] == 0.9, "a refused restore leaves the current file alone"
    backup.restore(tmp_path / "backups", "bk1", FACTS, validate=lambda path: json.loads(path.read_text()))
    assert json.loads(config.read_text())["max_speed"] == 0.5
    stored = next((tmp_path / "backups" / "bk1").glob("00-*"))
    stored.write_text("tampered", encoding="utf-8")
    with pytest.raises(backup.BackupError, match="changed or is missing"):
        backup.restore(tmp_path / "backups", "bk1", FACTS)


SECRET = "robot-secret-for-tests"


def command(capability: str, params: dict, n: int) -> dict:
    cmd = {"id": f"rosc_{n}", "robotId": "rb_1", "capability": capability, "params": params, "issuedAt": 1000 + n, "expiresAt": 999_999, "nonce": f"nonce-{n}"}
    cmd["signature"] = sign_command(SECRET, cmd)
    return cmd


def make(tmp_path: Path, ready: bool = True, **extra) -> RobotOSCommandDispatcher:
    audit = AuditLog()
    safety = SafetyGateway(audit=audit, limits=SafetyLimits())
    return RobotOSCommandDispatcher(robot_id="rb_1", guard=CommandGuard(secret=SECRET, now=lambda: 2000), safety=safety, update_state=UpdateState(), audit=audit, now=lambda: 2000, health_snapshot=lambda: {"robot_ready": ready}, **extra)


def test_dispatcher_stages_only_a_verified_package_then_checks_health(tmp_path: Path):
    config = tmp_path / "robot.json"
    config.write_text('{"max_speed": 0.5}', encoding="utf-8")
    d = make(tmp_path, trusted_keys=trusted(tmp_path), facts=FACTS, backup_root=tmp_path / "backups", backup_files=[config], validate_backup=lambda path: json.loads(path.read_text()))
    refused = d.handle(command("update.stage", {"version": "1.4.0"}, 1)).payload
    assert refused["ok"] is False and "signed update package is required" in refused["reason"]
    wrong = d.handle(command("update.stage", {"manifest": {**FIXTURE["manifest"], "version": "1.5.0"}}, 2)).payload
    assert wrong["ok"] is False and "package refused" in wrong["reason"]
    staged = d.handle(command("update.stage", {"version": "1.4.0", "manifest": FIXTURE["manifest"], "backup": {"id": "bk_1"}}, 3)).payload
    assert staged["ok"] is True, staged
    assert staged["backup"] == {"id": "bk_1", "files": 1}
    assert staged["update"]["pendingVersion"] == "1.4.0"
    unknown = d.handle(command("update.activate", {"version": "1.4.0", "healthChecks": ["robot-ready", "nav-smoke"]}, 4)).payload
    assert unknown["ok"] is False and "nav-smoke" in unknown["reason"]
    assert unknown["health"]["checks"][1] == {"id": "nav-smoke", "ok": False, "detail": "this robot has no such health check"}
    config.write_text('{"max_speed": 0.9}', encoding="utf-8")
    rolled = d.handle(command("update.rollback", {"reason": "health check failed", "backup": {"id": "bk_1"}}, 5)).payload
    assert rolled["ok"] is True, rolled
    assert json.loads(config.read_text())["max_speed"] == 0.5
    assert rolled["update"]["status"] == "rolled_back"


def test_dispatcher_activation_reports_passing_health(tmp_path: Path):
    d = make(tmp_path, trusted_keys=trusted(tmp_path), facts=FACTS, health_checks={"nav-smoke": lambda: True})
    assert d.handle(command("update.stage", {"manifest": FIXTURE["manifest"]}, 1)).payload["ok"] is True
    active = d.handle(command("update.activate", {"version": "1.4.0", "healthChecks": ["robot-ready", "nav-smoke"]}, 2)).payload
    assert active["ok"] is True
    assert [item["ok"] for item in active["health"]["checks"]] == [True, True]
    assert active["update"]["currentVersion"] == "1.4.0"
    not_ready = make(tmp_path, ready=False, trusted_keys=trusted(tmp_path), facts=FACTS)
    assert not_ready.handle(command("update.stage", {"manifest": FIXTURE["manifest"]}, 3)).payload["ok"] is True
    assert "not ready" in not_ready.handle(command("update.activate", {"version": "1.4.0"}, 4)).payload["reason"]


def test_cli_verify_package_and_report(tmp_path: Path, capsys, monkeypatch):
    from hannah_robot_os.__main__ import main

    (tmp_path / "manifest.json").write_text(json.dumps(FIXTURE["manifest"]), encoding="utf-8")
    (tmp_path / "keys.json").write_text(json.dumps([{"owner": FIXTURE["owner"], "publicKey": FIXTURE["publicKey"]}]), encoding="utf-8")
    (tmp_path / "facts.json").write_text(json.dumps(FACTS), encoding="utf-8")
    verify = ["hannah-robot-os", "update", "verify-package", "--state", str(tmp_path / "state.json"), "--manifest", str(tmp_path / "manifest.json"), "--trusted-keys", str(tmp_path / "keys.json"), "--facts", str(tmp_path / "facts.json")]
    monkeypatch.setattr("sys.argv", verify)
    assert main() == 0
    assert json.loads(capsys.readouterr().out)["publisher"] == "Acme Robotics"
    (tmp_path / "facts.json").write_text(json.dumps({**FACTS, "model": "Other"}), encoding="utf-8")
    assert main() == 1
    assert "other hardware" in json.loads(capsys.readouterr().out)["error"]
    monkeypatch.setattr("sys.argv", ["hannah-robot-os", "update", "report", "--state", str(tmp_path / "state.json"), "--status-dir", str(tmp_path / "status")])
    assert main() == 0
    report = json.loads(capsys.readouterr().out)
    assert report["type"] == "update_status"
    assert report["checks"][0] == {"id": "robot-ready", "ok": False, "detail": "READY gate not passed"}
