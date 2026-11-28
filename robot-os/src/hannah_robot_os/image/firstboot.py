"""First-boot setup for a HANNAH Robot OS disk image.

The image ships with no password for any account and no SSH host key. On the
first boot this module:

- reads an optional provisioning file the owner copied onto the boot partition
  (``hannah/provision.json`` on the EFI or Raspberry Pi firmware partition);
- picks the robot ID and hostname;
- installs SSH public keys for the ``hannah-admin`` account (keys only: a
  provisioning file that carries a password is refused);
- generates this robot's own SSH host key;
- writes the firewall rule that lets SSH in from the listed networks (none by
  default: the robot only makes outbound connections);
- stores the enrollment server and one-time token for the remote gateway;
- deletes the provisioning file, because it may carry the enrollment token.

The root filesystem is read-only, so everything goes under ``/var``. Nothing
here contacts the network; enrollment itself happens later, outbound, through
the remote gateway.
"""
from __future__ import annotations

import base64
import binascii
import ipaddress
import json
import os
import re
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SYSTEM_DIR = "/var/lib/hannah-system"
DATA_DIR = "/var/lib/hannah-robot-os"
ADMIN_HOME = "/var/home/hannah-admin"
ADMIN_USER = "hannah-admin"
SERVICE_USER = "hannah"
PROVISION_CANDIDATES = (
    "/efi/hannah/provision.json",
    "/boot/hannah/provision.json",
    "/boot/efi/hannah/provision.json",
    "/boot/firmware/hannah/provision.json",
)

ALLOWED_KEYS = {"hostname", "robot_id", "ssh_authorized_keys", "ssh_allow_from", "enrollment"}
PASSWORD_KEYS = {
    "password", "passwd", "root_password", "admin_password", "hashed_password",
    "plain_text_passwd", "chpasswd",
}
KEY_TYPES = (
    "ssh-ed25519",
    "sk-ssh-ed25519@openssh.com",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ecdsa-sha2-nistp256@openssh.com",
    "ssh-rsa",
)
HOSTNAME_RE = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")
ROBOT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class ProvisionError(ValueError):
    """The provisioning file can't be used as written."""


@dataclass
class Provision:
    hostname: str | None = None
    robot_id: str | None = None
    ssh_authorized_keys: list[str] = field(default_factory=list)
    ssh_allow_from: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = field(default_factory=list)
    enrollment: dict[str, str] | None = None


def _find_password_keys(data: Any, path: str = "") -> list[str]:
    found: list[str] = []
    if isinstance(data, dict):
        for key, value in data.items():
            where = f"{path}.{key}" if path else str(key)
            if str(key).lower() in PASSWORD_KEYS:
                found.append(where)
            found.extend(_find_password_keys(value, where))
    elif isinstance(data, list):
        for index, value in enumerate(data):
            found.extend(_find_password_keys(value, f"{path}[{index}]"))
    return found


def validate_hostname(name: str) -> str:
    name = str(name).strip().lower()
    if not HOSTNAME_RE.match(name):
        raise ProvisionError(f"hostname {name!r} must be 1-63 characters of a-z, 0-9 and '-', not starting or ending with '-'")
    return name


def validate_ssh_key(line: str) -> str:
    """Return the key line when it is a single public key with no options."""
    line = str(line).strip()
    if "\n" in line or "\r" in line:
        raise ProvisionError("an SSH key must be on one line")
    parts = line.split()
    if len(parts) < 2:
        raise ProvisionError("an SSH key needs a type and a base64 key")
    if parts[0] not in KEY_TYPES:
        raise ProvisionError(f"SSH key type {parts[0]!r} is not accepted (options before the key are not accepted either)")
    try:
        blob = base64.b64decode(parts[1], validate=True)
    except (binascii.Error, ValueError) as error:
        raise ProvisionError("SSH key is not valid base64") from error
    # The blob starts with the key type as an SSH string: 4-byte length, then the name.
    if len(blob) < 4:
        raise ProvisionError("SSH key is too short")
    length = int.from_bytes(blob[:4], "big")
    if blob[4:4 + length].decode("ascii", "replace") != parts[0]:
        raise ProvisionError("SSH key type does not match the key data")
    return line


def validate_enrollment(data: Any) -> dict[str, str]:
    if not isinstance(data, dict):
        raise ProvisionError("enrollment must be an object with server and token")
    unknown = set(data) - {"server", "token"}
    if unknown:
        raise ProvisionError(f"unknown enrollment fields: {', '.join(sorted(unknown))}")
    server = str(data.get("server", "")).strip()
    token = str(data.get("token", "")).strip()
    if not server.startswith("https://") or len(server) <= len("https://"):
        raise ProvisionError("enrollment.server must be an https:// address (the robot connects out to it)")
    if not token or len(token) > 512 or any(c.isspace() for c in token):
        raise ProvisionError("enrollment.token must be a non-empty token without spaces")
    return {"server": server, "token": token}


def parse_provision(data: Any) -> Provision:
    if not isinstance(data, dict):
        raise ProvisionError("provisioning file must be a JSON object")
    passwords = _find_password_keys(data)
    if passwords:
        raise ProvisionError(
            "passwords are not accepted; this image allows SSH keys only (found: " + ", ".join(passwords) + ")"
        )
    unknown = set(data) - ALLOWED_KEYS
    if unknown:
        raise ProvisionError(f"unknown provisioning fields: {', '.join(sorted(unknown))}")
    prov = Provision()
    if data.get("hostname") is not None:
        prov.hostname = validate_hostname(data["hostname"])
    if data.get("robot_id") is not None:
        robot_id = str(data["robot_id"]).strip()
        if not ROBOT_ID_RE.match(robot_id):
            raise ProvisionError("robot_id must be 1-64 characters of letters, digits, '.', '_' or '-'")
        prov.robot_id = robot_id
    keys = data.get("ssh_authorized_keys", [])
    if not isinstance(keys, list):
        raise ProvisionError("ssh_authorized_keys must be a list")
    prov.ssh_authorized_keys = [validate_ssh_key(k) for k in keys]
    nets = data.get("ssh_allow_from", [])
    if not isinstance(nets, list):
        raise ProvisionError("ssh_allow_from must be a list of networks such as 192.168.1.0/24")
    for net in nets:
        try:
            network = ipaddress.ip_network(str(net), strict=False)
        except ValueError as error:
            raise ProvisionError(f"ssh_allow_from: {net!r} is not a network") from error
        if network.prefixlen == 0:
            raise ProvisionError("ssh_allow_from: opening SSH to every address is not accepted")
        prov.ssh_allow_from.append(network)
    if data.get("enrollment") is not None:
        prov.enrollment = validate_enrollment(data["enrollment"])
    return prov


def ssh_firewall_rules(networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network]) -> str:
    """nftables rules added to the image's `inet hannah` table. Empty when SSH stays closed."""
    lines = ["# Written by hannah-firstboot. SSH is reachable only from these networks."]
    v4 = [str(n) for n in networks if n.version == 4]
    v6 = [str(n) for n in networks if n.version == 6]
    if v4:
        lines.append(f"add rule inet hannah input ip saddr {{ {', '.join(v4)} }} tcp dport 22 accept")
    if v6:
        lines.append(f"add rule inet hannah input ip6 saddr {{ {', '.join(v6)} }} tcp dport 22 accept")
    return "\n".join(lines) + "\n"


def _rooted(root: Path, absolute: str) -> Path:
    return root / absolute.lstrip("/")


def _write(path: Path, text: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def _chown(path: Path, user: str, enabled: bool) -> None:
    if not enabled:
        return
    import pwd  # not on every platform the tests run on

    entry = pwd.getpwnam(user)
    os.chown(path, entry.pw_uid, entry.pw_gid)


def find_provision(root: Path, candidates: tuple[str, ...] | list[str] = PROVISION_CANDIDATES) -> Path | None:
    for candidate in candidates:
        path = _rooted(root, candidate)
        if path.is_file():
            return path
    return None


def run_firstboot(
    root: Path | str = "/",
    provision_paths: tuple[str, ...] | list[str] = PROVISION_CANDIDATES,
    generate_host_key: bool = True,
    chown: bool = True,
    now: float | None = None,
) -> dict[str, Any]:
    root = Path(root)
    system_dir = _rooted(root, SYSTEM_DIR)
    marker = system_dir / "firstboot.done"
    if marker.exists():
        return {"ok": True, "skipped": "first boot already completed"}

    source = find_provision(root, provision_paths)
    prov = Provision()
    if source is not None:
        try:
            raw = json.loads(source.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise ProvisionError(f"{source}: not readable JSON ({error})") from error
        prov = parse_provision(raw)

    system_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(system_dir, 0o755)

    robot_id_path = system_dir / "robot-id"
    if prov.robot_id:
        robot_id = prov.robot_id
    elif robot_id_path.exists():
        robot_id = robot_id_path.read_text(encoding="utf-8").strip()
    else:
        robot_id = uuid.uuid4().hex
    _write(robot_id_path, robot_id + "\n", 0o644)

    suffix = re.sub(r"[^a-z0-9]", "", robot_id.lower())[:8]
    hostname = prov.hostname or validate_hostname(f"hannah-{suffix}" if suffix else "hannah-robot")
    _write(system_dir / "hostname", hostname + "\n", 0o644)

    keys_dir = system_dir / "ssh" / "authorized_keys"
    keys_dir.mkdir(parents=True, exist_ok=True)
    for directory in (system_dir / "ssh", keys_dir):
        os.chmod(directory, 0o755)
    keys_file = keys_dir / ADMIN_USER
    _write(keys_file, "".join(k + "\n" for k in prov.ssh_authorized_keys), 0o644)

    host_key = system_dir / "ssh" / "ssh_host_ed25519_key"
    if generate_host_key and not host_key.exists():
        subprocess.run(
            ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", f"hannah-robot-os {hostname}", "-f", str(host_key)],
            check=True,
        )

    firewall_file = system_dir / "firewall" / "20-ssh.nft"
    if prov.ssh_allow_from:
        _write(firewall_file, ssh_firewall_rules(prov.ssh_allow_from), 0o644)
    elif firewall_file.exists():
        firewall_file.unlink()

    enrolled = False
    if prov.enrollment:
        data_dir = _rooted(root, DATA_DIR)
        data_dir.mkdir(parents=True, exist_ok=True)
        enrollment_file = data_dir / "enrollment.json"
        _write(enrollment_file, json.dumps({**prov.enrollment, "robot_id": robot_id}, indent=2) + "\n", 0o600)
        _chown(enrollment_file, SERVICE_USER, chown)
        enrolled = True

    home = _rooted(root, ADMIN_HOME)
    home.mkdir(parents=True, exist_ok=True)
    os.chmod(home, 0o700)
    _chown(home, ADMIN_USER, chown)

    removed = None
    if source is not None:
        try:
            source.unlink()
            removed = True
        except OSError:
            removed = False

    report = {
        "ok": True,
        "completed_at": int(now if now is not None else time.time()),
        "robot_id": robot_id,
        "hostname": hostname,
        "provision_file": str(source) if source else None,
        "provision_file_removed": removed,
        "ssh_keys": len(prov.ssh_authorized_keys),
        "ssh_allow_from": [str(n) for n in prov.ssh_allow_from],
        "enrollment_stored": enrolled,
        "host_key": host_key.exists(),
    }
    _write(marker, json.dumps(report, indent=2) + "\n", 0o644)
    return report
