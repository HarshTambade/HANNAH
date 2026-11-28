import base64
import json
import stat

import pytest

from hannah_robot_os.image.firstboot import (
    ProvisionError,
    parse_provision,
    run_firstboot,
    ssh_firewall_rules,
    validate_ssh_key,
)


def _key(kind="ssh-ed25519"):
    name = kind.encode()
    blob = len(name).to_bytes(4, "big") + name + len(b"x" * 32).to_bytes(4, "big") + b"x" * 32
    return f"{kind} {base64.b64encode(blob).decode()} operator@laptop"


def _run(tmp_path, provision=None, **kw):
    if provision is not None:
        path = tmp_path / "efi" / "hannah" / "provision.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(provision))
    return run_firstboot(root=tmp_path, generate_host_key=False, chown=False, now=1_700_000_000, **kw)


def test_no_provision_file_keeps_ssh_closed_and_picks_a_hostname(tmp_path):
    report = _run(tmp_path)
    system = tmp_path / "var/lib/hannah-system"
    assert report["ok"] and report["ssh_keys"] == 0 and report["ssh_allow_from"] == []
    assert report["hostname"].startswith("hannah-")
    assert (system / "hostname").read_text().strip() == report["hostname"]
    assert (system / "ssh/authorized_keys/hannah-admin").read_text() == ""
    assert not (system / "firewall/20-ssh.nft").exists()
    assert (system / "firstboot.done").exists()


def test_provisioned_keys_firewall_and_enrollment(tmp_path):
    report = _run(tmp_path, {
        "hostname": "Rover-1",
        "robot_id": "rover-1",
        "ssh_authorized_keys": [_key()],
        "ssh_allow_from": ["192.168.10.0/24", "fd00::/64"],
        "enrollment": {"server": "https://hannah.example.com", "token": "one-time-token"},
    })
    system = tmp_path / "var/lib/hannah-system"
    assert report["hostname"] == "rover-1"
    assert report["provision_file_removed"] is True
    assert not (tmp_path / "efi/hannah/provision.json").exists(), "the file carrying the token is removed"
    assert (system / "ssh/authorized_keys/hannah-admin").read_text().startswith("ssh-ed25519 ")
    rules = (system / "firewall/20-ssh.nft").read_text()
    assert "ip saddr { 192.168.10.0/24 } tcp dport 22 accept" in rules
    assert "ip6 saddr { fd00::/64 } tcp dport 22 accept" in rules
    enrollment = tmp_path / "var/lib/hannah-robot-os/enrollment.json"
    assert json.loads(enrollment.read_text())["robot_id"] == "rover-1"
    assert stat.S_IMODE(enrollment.stat().st_mode) == 0o600
    marker = (system / "firstboot.done").read_text()
    assert "one-time-token" not in marker, "the done marker holds no secret"


def test_second_run_is_skipped(tmp_path):
    _run(tmp_path)
    assert _run(tmp_path)["skipped"]


@pytest.mark.parametrize("field", ["password", "root_password", "passwd"])
def test_passwords_are_refused(tmp_path, field):
    with pytest.raises(ProvisionError, match="passwords are not accepted"):
        _run(tmp_path, {field: "hunter2"})
    assert not (tmp_path / "var/lib/hannah-system/firstboot.done").exists()


def test_nested_password_is_refused():
    with pytest.raises(ProvisionError, match="enrollment.password"):
        parse_provision({"enrollment": {"server": "https://x", "token": "t", "password": "p"}})


def test_bad_inputs_are_refused():
    for data, message in [
        ({"hostname": "-bad"}, "hostname"),
        ({"ssh_allow_from": ["0.0.0.0/0"]}, "every address"),
        ({"ssh_allow_from": ["not-a-net"]}, "not a network"),
        ({"enrollment": {"server": "http://plain", "token": "t"}}, "https"),
        ({"surprise": 1}, "unknown provisioning fields"),
        ({"ssh_authorized_keys": ['command="rm -rf /" ' + _key()]}, "not accepted"),
    ]:
        with pytest.raises(ProvisionError, match=message):
            parse_provision(data)


def test_ssh_key_validation():
    assert validate_ssh_key(_key()).startswith("ssh-ed25519")
    with pytest.raises(ProvisionError):
        validate_ssh_key("ssh-ed25519 !!!notbase64")
    with pytest.raises(ProvisionError, match="does not match"):
        validate_ssh_key("ssh-rsa " + _key().split()[1])

