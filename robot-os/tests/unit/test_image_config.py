"""Static checks of the disk image configuration (images/mkosi, systemd units,
udev rules, firewall, SSH, journald, branding) and build.sh --dry-run.

These run anywhere, macOS included. They do not build or boot an image: that
happens only in .github/workflows/robot-os-image-ci.yml on a Linux runner.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from hannah_robot_os.image import firstboot

ROBOT = Path(__file__).resolve().parents[2]
REPO = ROBOT.parent
MKOSI = ROBOT / "images" / "mkosi"
COMMON = MKOSI / "common"
EXTRA = COMMON / "mkosi.extra"
UNITS = ROBOT / "systemd"
POSTINST = (COMMON / "mkosi.postinst.chroot").read_text()
PROFILES = json.loads((ROBOT / "image-profiles" / "profiles.json").read_text())["profiles"]


def parse_ini(path: Path) -> list[tuple[str, str, str]]:
    """(section, key, value) for every setting. Repeated keys are kept; indented lines continue a value."""
    out: list[tuple[str, str, str]] = []
    section = None
    for number, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if raw[:1].isspace() and out:
            s, k, v = out[-1]
            out[-1] = (s, k, (v + " " + line).strip())
            continue
        m = re.fullmatch(r"\[([A-Za-z][A-Za-z -]*)\]", line)
        if m:
            section = m.group(1)
            continue
        assert section, f"{path}:{number}: setting outside a section"
        assert "=" in line, f"{path}:{number}: not key=value: {line!r}"
        key, _, value = line.partition("=")
        assert re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", key.strip()), f"{path}:{number}: bad key {key!r}"
        out.append((section, key.strip(), value.strip()))
    return out


def values(settings, section, key):
    return [v for s, k, v in settings if s == section and k == key]


# --- mkosi configuration ---------------------------------------------------

MKOSI_KEYS = {
    "Distribution": {"Distribution", "Release", "Repositories", "Architecture", "Mirror"},
    "Output": {"ImageId", "Format", "ManifestFormat", "ImageVersion", "OutputDirectory", "Seed"},
    "Content": {"WithDocs", "Locale", "Timezone", "Keymap", "Autologin", "KernelCommandLine", "Packages",
                "Bootable", "Bootloader", "UnifiedKernelImages"},
}
GENERATED_SCALARS = {("Distribution", "Architecture"), ("Distribution", "Mirror"), ("Output", "ImageVersion"),
                     ("Output", "OutputDirectory"), ("Output", "Seed")}
LIST_KEYS = {"Packages", "KernelCommandLine", "Repositories"}


def mkosi_files(board):
    return [COMMON / "mkosi.conf", *sorted((MKOSI / "boards" / board / "mkosi.conf.d").glob("*.conf"))]


@pytest.mark.parametrize("board", ["uefi", "rpi"])
def test_mkosi_settings_are_known_and_assigned_once(board):
    seen = set(GENERATED_SCALARS)
    for path in mkosi_files(board):
        for section, key, _ in parse_ini(path):
            assert key in MKOSI_KEYS.get(section, set()), f"{path.name}: unexpected [{section}] {key}="
            if key not in LIST_KEYS:
                assert (section, key) not in seen, f"{path.name}: {key}= is also set elsewhere (assign scalars once)"
                seen.add((section, key))


def test_mkosi_base_is_hardened_and_passwordless():
    s = parse_ini(COMMON / "mkosi.conf")
    assert values(s, "Distribution", "Distribution") == ["debian"]
    assert values(s, "Distribution", "Release") == ["trixie"]
    assert values(s, "Output", "Format") == ["disk"]
    assert values(s, "Content", "Autologin") == ["no"]
    assert not any(k in {"RootPassword", "Password"} for _, k, _ in s), "no account may get a password"
    cmdline = " ".join(values(s, "Content", "KernelCommandLine")).split()
    assert "ro" in cmdline and "systemd.firstboot=no" in cmdline
    packages = " ".join(values(s, "Content", "Packages")).split()
    for required in ["systemd", "udev", "nftables", "openssh-server", "python3", "can-utils", "plymouth", "sudo", "iproute2"]:
        assert required in packages
    assert not any(p.startswith("linux-image") for p in packages), "the kernel is chosen per build (standard or rt)"


def test_boards():
    uefi = parse_ini(MKOSI / "boards/uefi/mkosi.conf.d/50-board.conf")
    assert values(uefi, "Content", "Bootable") == ["yes"]
    assert values(uefi, "Content", "Bootloader") == ["systemd-boot"]
    rpi = parse_ini(MKOSI / "boards/rpi/mkosi.conf.d/50-board.conf")
    assert values(rpi, "Content", "Bootable") == ["no"]
    assert "raspi-firmware" in " ".join(values(rpi, "Content", "Packages")).split()


# --- partitions ------------------------------------------------------------

REPART_KEYS = {"Type", "Label", "Format", "CopyFiles", "ExcludeFiles", "SizeMinBytes", "SizeMaxBytes"}


@pytest.mark.parametrize("board", ["uefi", "rpi"])
def test_partition_layout_is_ab_with_separate_var(board):
    parts = []
    for path in sorted((MKOSI / "boards" / board / "mkosi.repart").glob("*.conf")):
        s = parse_ini(path)
        assert {sec for sec, _, _ in s} == {"Partition"}
        assert {k for _, k, _ in s} <= REPART_KEYS, path.name
        parts.append({k: values(s, "Partition", k) for k in REPART_KEYS})
    types = [p["Type"][0] for p in parts]
    assert types == ["esp", "root", "root", "linux-generic"]
    root_a, root_b, var = parts[1], parts[2], parts[3]
    assert root_a["Label"] == ["hannah-robot-os_@IMAGE_VERSION@"]
    assert root_a["Format"] == ["ext4"] and root_a["CopyFiles"] == ["/"]
    assert "/var/" in root_a["ExcludeFiles"], "/var lives on its own partition"
    assert root_b["Label"] == ["_empty"] and not root_b["Format"] and not root_b["CopyFiles"]
    assert root_a["SizeMinBytes"] == root_b["SizeMinBytes"] == root_a["SizeMaxBytes"] == root_b["SizeMaxBytes"]
    assert var["Label"] == ["hannah-var"] and var["CopyFiles"] == ["/var:/"]
    # /etc/fstab, written by the postinst script, mounts these by label.
    assert "PARTLABEL=hannah-var /var ext4" in POSTINST
    assert 'ROOT_SPEC="PARTLABEL=hannah-robot-os_${HANNAH_IMAGE_VERSION}"' in POSTINST
    assert "${ROOT_SPEC} / ext4 ro," in POSTINST


def test_sysupdate_transfers_match_the_partition_labels_and_verify_signatures():
    for path in sorted((MKOSI / "sysupdate").glob("*.transfer.in")):
        s = parse_ini(path)
        assert values(s, "Transfer", "Verify") == ["yes"], f"{path.name}: updates must be signature-checked"
        assert values(s, "Source", "Type") == ["url-file"]
        assert values(s, "Source", "Path") == ["@UPDATE_URL@"]
    root = parse_ini(MKOSI / "sysupdate/10-root.transfer.in")
    assert values(root, "Target", "MatchPattern") == ["hannah-robot-os_@v"]
    assert values(root, "Target", "MatchPartitionType") == ["root"]
    uki = parse_ini(MKOSI / "sysupdate/20-uki.transfer.in")
    assert values(uki, "Target", "TriesLeft") == ["3"], "boot counting gives the fallback"


# --- systemd units ---------------------------------------------------------

UNIT_KEYS = {
    "Unit": {"Description", "Documentation", "After", "Before", "Wants", "Requires", "Conflicts",
             "ConditionPathExists", "ConditionDirectoryNotEmpty", "RequiresMountsFor"},
    "Service": {"Type", "User", "Group", "SupplementaryGroups", "WorkingDirectory", "Environment", "ExecStart",
                "Restart", "RestartSec", "RemainAfterExit", "StandardOutput", "TimeoutStartSec", "NoNewPrivileges",
                "PrivateTmp", "ProtectSystem", "ProtectHome", "ReadWritePaths", "DeviceAllow"},
    "Timer": {"OnBootSec", "OnUnitActiveSec", "RandomizedDelaySec", "Persistent"},
    "Install": {"WantedBy", "RequiredBy"},
}
ROOT_SERVICES = {"hannah-firstboot.service", "hannah-hostname.service", "hannah-update.service"}
DISTRO_UNITS = {"multi-user.target", "timers.target", "boot-complete.target", "network-online.target",
                "network.target", "network-pre.target", "local-fs.target", "systemd-tmpfiles-setup.service",
                "nftables.service", "ssh.service", "systemd-networkd.service", "systemd-resolved.service",
                "systemd-timesyncd.service"}


def all_units():
    files = sorted(UNITS.iterdir())
    files += sorted((EXTRA / "usr/lib/systemd/system").glob("*.d/*.conf"))
    return files


def tmpfiles_dirs():
    dirs = set()
    for line in (EXTRA / "usr/lib/tmpfiles.d/hannah-robot-os.conf").read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            fields = line.split()
            if fields[0] == "d":
                dirs.add(fields[1])
    return dirs


@pytest.mark.parametrize("path", all_units(), ids=lambda p: p.name if p.parent == UNITS else f"{p.parent.name}/{p.name}")
def test_unit_files_lint(path):
    s = parse_ini(path)
    for section, key, value in s:
        assert key in UNIT_KEYS.get(section, set()), f"{path.name}: unexpected [{section}] {key}="
    if path.parent != UNITS:
        return  # drop-in
    sections = {sec for sec, _, _ in s}
    if path.suffix == ".service":
        assert "Service" in sections
        execs = values(s, "Service", "ExecStart")
        assert len(execs) == 1 and execs[0].startswith("/"), "one ExecStart with an absolute path"
        assert values(s, "Service", "Type")[0] in {"simple", "oneshot", "exec", "notify"}
        user = values(s, "Service", "User")
        if path.name in ROOT_SERVICES:
            assert not user
        else:
            assert user == ["hannah"] and values(s, "Service", "Group") == ["hannah"], "least privilege: the hannah user"
            assert values(s, "Service", "NoNewPrivileges") == ["true"]
            assert values(s, "Service", "ProtectSystem") == ["strict"]
            assert values(s, "Service", "ProtectHome") == ["true"]
        for rw in " ".join(values(s, "Service", "ReadWritePaths")).split():
            assert rw in tmpfiles_dirs(), f"{rw} must be created by tmpfiles.d, or the unit fails to start"
        for allow in values(s, "Service", "DeviceAllow"):
            assert re.fullmatch(r"(/dev/[^\s*?]+|char-[\w-]+|block-[\w-]+) [rwm]+", allow), f"bad DeviceAllow {allow!r} (no globs)"
    if path.suffix == ".timer":
        assert "Timer" in sections
    for target in values(s, "Install", "WantedBy") + values(s, "Install", "RequiredBy"):
        assert target in DISTRO_UNITS or (UNITS / target).exists(), target


def test_target_wants_existing_units():
    s = parse_ini(UNITS / "hannah-robot-os.target")
    for unit in " ".join(values(s, "Unit", "Wants")).split():
        assert (UNITS / unit).exists(), unit


def test_every_installable_unit_is_enabled_in_the_image():
    enable = re.search(r"systemctl enable \\\n(.*?)\n\S", POSTINST, re.S)
    assert enable, "postinst must enable units"
    enabled = set(enable.group(1).replace("\\", " ").split())
    for unit in UNITS.iterdir():
        if values(parse_ini(unit), "Install", "WantedBy") or values(parse_ini(unit), "Install", "RequiredBy"):
            assert unit.name in enabled, f"{unit.name} has [Install] but the image doesn't enable it"
    for unit in enabled:
        assert (UNITS / unit).exists() or unit in DISTRO_UNITS, unit


def test_unit_executables_ship_in_the_image():
    for unit in UNITS.iterdir():
        for cmd in values(parse_ini(unit), "Service", "ExecStart"):
            binary = cmd.split()[0]
            if binary.startswith(("/usr/libexec/hannah/", "/usr/sbin/hannah-", "/usr/bin/hannah-")):
                shipped = EXTRA / binary.lstrip("/")
                assert shipped.exists() and os.access(shipped, os.X_OK), f"{binary} must be in mkosi.extra and executable"


def test_ros2_runtime_is_skipped_without_ros():
    s = parse_ini(UNITS / "hannah-ros2-runtime.service")
    assert "/opt/ros/jazzy/setup.bash" in values(s, "Unit", "ConditionPathExists")


# --- device access ---------------------------------------------------------

UDEV_TOKEN = re.compile(r'\s*([A-Z_]+(?:\{[^}]+\})?)\s*(==|!=|\+=|-=|:=|=)\s*"([^"]*)"\s*(?:,|$)')
UDEV_KEYS = {"ACTION", "SUBSYSTEM", "DRIVER", "KERNEL", "ATTR", "ATTRS", "ENV", "GROUP", "MODE", "SYMLINK", "TAG", "OWNER"}


def udev_rules():
    rules = []
    path = EXTRA / "usr/lib/udev/rules.d/70-hannah-motor-controllers.rules"
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        assert not line.endswith("\\"), "keep each rule on one line"
        tokens, pos = [], 0
        while pos < len(line):
            m = UDEV_TOKEN.match(line, pos)
            assert m, f"line {number}: can't parse near {line[pos:]!r}"
            tokens.append(m.groups())
            pos = m.end()
        rules.append(tokens)
    return rules


def test_udev_rules_syntax_and_least_privilege():
    rules = udev_rules()
    assert rules
    for tokens in rules:
        keys = {re.sub(r"\{.*", "", k) for k, _, _ in tokens}
        assert keys <= UDEV_KEYS, keys - UDEV_KEYS
        assert any(op in {"==", "!="} for _, op, _ in tokens), "every rule matches something"
        assert any(op in {"=", "+=", ":="} for _, op, _ in tokens), "every rule assigns something"
        for key, op, value in tokens:
            if key == "MODE":
                assert re.fullmatch(r"0[0-7]{2}0", value), "never world-accessible"
            if key == "GROUP":
                assert value == "dialout"
            if key == "SYMLINK":
                assert value.startswith("hannah/")
            if op == "==" and key.startswith(("ATTR{", "ATTRS{")) and "id" in key:
                assert re.fullmatch(r"[0-9a-f]{4}", value)


@pytest.mark.parametrize("name,vid,pid", [("odrive", "1209", "0d32"), ("dynamixel", "0403", "6014"), ("vesc", "0483", "5740")])
def test_stable_names_for_motor_controllers(name, vid, pid):
    rules = udev_rules()
    matching = [t for t in rules if ("ATTRS{idVendor}", "==", vid) in t and ("ATTRS{idProduct}", "==", pid) in t]
    symlinks = {v for t in matching for k, _, v in t if k == "SYMLINK"}
    assert f"hannah/{name}" in symlinks and f"hannah/{name}-$env{{ID_SERIAL_SHORT}}" in symlinks


def test_service_user_can_reach_serial_controllers():
    assert "--groups dialout" in POSTINST and "--shell /usr/sbin/nologin" in POSTINST
    s = parse_ini(UNITS / "hannah-motor-controller.service")
    assert values(s, "Service", "SupplementaryGroups") == ["dialout"]
    assert {"char-ttyUSB rw", "char-ttyACM rw"} <= set(values(s, "Service", "DeviceAllow"))


def test_socketcan():
    modules = (EXTRA / "usr/lib/modules-load.d/hannah-can.conf").read_text().split()
    assert {"can", "can_raw"} <= set(modules)
    net = parse_ini(EXTRA / "usr/lib/systemd/network/80-hannah-can.network")
    assert values(net, "Match", "Type") == ["can"]
    assert int(values(net, "CAN", "BitRate")[0]) in {125000, 250000, 500000, 1000000}


# --- hardening -------------------------------------------------------------

def test_tmpfiles_syntax():
    for line in (EXTRA / "usr/lib/tmpfiles.d/hannah-robot-os.conf").read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        fields = line.split(None, 6)
        assert fields[0] in {"d", "f"} and fields[1].startswith("/")
        assert re.fullmatch(r"0[0-7]{3}", fields[2]) and fields[3] in {"root", "hannah"} and fields[4] in {"root", "hannah"}


def test_ssh_keys_only():
    conf = dict(line.split(None, 1) for line in (EXTRA / "etc/ssh/sshd_config.d/50-hannah.conf").read_text().splitlines()
                if line.strip() and not line.startswith("#"))
    assert conf["PasswordAuthentication"] == "no"
    assert conf["KbdInteractiveAuthentication"] == "no"
    assert conf["PermitRootLogin"] == "no"
    assert conf["AllowGroups"] == firstboot.ADMIN_USER
    assert conf["HostKey"] == f"{firstboot.SYSTEM_DIR}/ssh/ssh_host_ed25519_key"
    assert conf["AuthorizedKeysFile"] == f"{firstboot.SYSTEM_DIR}/ssh/authorized_keys/%u"
    assert "rm -f /etc/ssh/ssh_host_*" in POSTINST, "no host key may be shared by every robot"
    assert "passwd --lock root" in POSTINST and "usermod --password '*' hannah-admin" in POSTINST
    assert "chpasswd" not in POSTINST


def test_firewall_is_outbound_only():
    nft = (EXTRA / "etc/nftables.conf").read_text()
    assert re.search(r"chain input \{\s*type filter hook input priority filter; policy drop;", nft)
    assert re.search(r"chain forward \{\s*type filter hook forward priority filter; policy drop;", nft)
    assert re.search(r"chain output \{\s*type filter hook output priority filter; policy accept;", nft)
    assert "dport 22" not in nft, "SSH is closed unless provisioning opens it for listed networks"
    assert f'include "{firstboot.SYSTEM_DIR}/firewall/*.nft"' in nft
    tmpfiles = (EXTRA / "usr/lib/tmpfiles.d/hannah-robot-os.conf").read_text()
    assert f"{firstboot.SYSTEM_DIR}/firewall/00-local.nft" in tmpfiles, "the include pattern always matches a file"
    import ipaddress
    assert "inet hannah input" in firstboot.ssh_firewall_rules([ipaddress.ip_network("10.0.0.0/8")])


def test_journald_watchdog_and_sysctl():
    journal = parse_ini(EXTRA / "usr/lib/systemd/journald.conf.d/50-hannah.conf")
    assert values(journal, "Journal", "SystemMaxUse") and values(journal, "Journal", "RuntimeMaxUse")
    watchdog = parse_ini(EXTRA / "usr/lib/systemd/system.conf.d/50-hannah-watchdog.conf")
    assert values(watchdog, "Manager", "RuntimeWatchdogSec") == ["30s"]
    sysctl = (EXTRA / "usr/lib/sysctl.d/90-hannah-hardening.conf").read_text()
    for line in sysctl.splitlines():
        if line.strip() and not line.startswith("#"):
            assert re.fullmatch(r"[a-z0-9_.]+ = -?\d+", line), line
    assert "kernel.kptr_restrict = 2" in sysctl


def test_sudo_is_only_for_the_admin():
    lines = [l for l in (EXTRA / "etc/sudoers.d/50-hannah-admin").read_text().splitlines() if l and not l.startswith("#")]
    assert lines == ["hannah-admin ALL=(ALL:ALL) NOPASSWD: ALL"]


def test_branding_says_not_safety_certified():
    assert "Not safety certified" in POSTINST and 'NAME="HANNAH Robot OS"' in POSTINST
    assert "NOT SAFETY CERTIFIED" in (EXTRA / "etc/motd").read_text()
    assert "not safety certified" in (EXTRA / "etc/issue").read_text()
    theme = parse_ini(EXTRA / "usr/share/plymouth/themes/hannah/hannah.plymouth")
    assert "Not safety certified" in values(theme, "two-step", "SubTitle")[0]
    assert values(parse_ini(EXTRA / "etc/plymouth/plymouthd.conf"), "Daemon", "Theme") == ["hannah"]


# --- scripts, versions, build.sh -------------------------------------------

SCRIPTS = [
    ROBOT / "images/build.sh",
    ROBOT / "images/scripts/qemu-smoke.sh",
    COMMON / "mkosi.postinst.chroot",
    COMMON / "mkosi.finalize",
    EXTRA / "usr/bin/hannah-robot-os",
    EXTRA / "usr/sbin/hannah-firstboot",
    EXTRA / "usr/libexec/hannah/boot-ready",
    EXTRA / "usr/libexec/hannah/update-hook",
]


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda p: p.name)
def test_scripts_parse_and_are_executable(script):
    assert os.access(script, os.X_OK), f"{script.name} must be executable"
    shebang = script.read_text().splitlines()[0]
    shell = "bash" if "bash" in shebang else "sh"
    assert shebang in {"#!/bin/sh", "#!/usr/bin/env bash"}
    assert subprocess.run([shell, "-n", str(script)]).returncode == 0
    if shutil.which("shellcheck"):
        result = subprocess.run(["shellcheck", "-S", "warning", "-s", shell, str(script)], capture_output=True, text=True)
        assert result.returncode == 0, result.stdout


def test_boot_check_markers_agree():
    boot_ready = (EXTRA / "usr/libexec/hannah/boot-ready").read_text()
    smoke = (ROBOT / "images/scripts/qemu-smoke.sh").read_text()
    for marker in ["HANNAH-BOOT-CHECK: PASS", "HANNAH-BOOT-CHECK: FAIL", "HANNAH-BOOT-CHECK: hannah-robot-os.target"]:
        assert marker in boot_ready and marker in smoke
    assert "HANNAH Robot OS READY" in smoke
    assert 'print("HANNAH Robot OS READY")' in (ROBOT / "src/hannah_robot_os/__main__.py").read_text()


def test_pinned_mkosi_matches_ci():
    versions = dict(re.findall(r"^([A-Z_]+)=(.*)$", (MKOSI / "VERSIONS").read_text(), re.M))
    assert re.fullmatch(r"v\d+(\.\d+)*", versions["MKOSI_VERSION"])
    workflow = (REPO / ".github/workflows/robot-os-image-ci.yml").read_text()
    pins = re.findall(r"uses: systemd/mkosi@(\S+)", workflow)
    assert pins and set(pins) == {versions["MKOSI_VERSION"]}, "every mkosi install in CI uses the pinned version"
    assert "qemu-smoke.sh" in workflow and "SHA256SUMS" in workflow


def _dry_run(tmp_path, *args):
    return subprocess.run(["bash", str(ROBOT / "images/build.sh"), *args, "--out", str(tmp_path), "--dry-run"],
                          capture_output=True, text=True)


@pytest.mark.parametrize("profile", [p["id"] for p in PROFILES])
def test_build_dry_run_assembles_each_profile(tmp_path, profile):
    result = _dry_run(tmp_path, "--profile", profile, "--version", "1.2.3")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "no image built" in result.stdout
    project = tmp_path / "project"
    prof = next(p for p in PROFILES if p["id"] == profile)
    generated = parse_ini(project / "mkosi.conf.d/00-build.conf")
    assert values(generated, "Distribution", "Architecture") == [prof["image"]["arch"]]
    deb = {"x86-64": "amd64", "arm64": "arm64"}[prof["image"]["arch"]]
    kernel = f"linux-image-rt-{deb}" if prof["image"]["kernel"] == "rt" else f"linux-image-{deb}"
    assert values(generated, "Content", "Packages") == [kernel]
    for repart in (project / "mkosi.repart").glob("*.conf"):
        assert "@" not in repart.read_text(), "labels are filled in"
    assert "Label=hannah-robot-os_1.2.3" in (project / "mkosi.repart/10-root-a.conf").read_text()
    extra = project / "mkosi.extra"
    assert (extra / "usr/lib/systemd/system/hannah-robot-os.target").exists()
    assert (extra / "opt/hannah-robot-os/src/hannah_robot_os/__main__.py").exists()
    assert not list((extra / "opt/hannah-robot-os/src").rglob("__pycache__"))
    assert json.loads((extra / "etc/hannah-robot-os/config.json").read_text())["profile"] == profile
    info = (extra / "usr/lib/hannah/build-info").read_text()
    assert f"HANNAH_BOARD={prof['image']['board']}" in info and "HANNAH_IMAGE_VERSION=1.2.3" in info
    assert not (extra / "usr/lib/sysupdate.d").exists(), "no update source unless asked for"


def test_build_rt_flag_and_update_source(tmp_path):
    pubring = tmp_path / "pubring.gpg"
    pubring.write_bytes(b"test key")
    result = _dry_run(tmp_path / "o", "--profile", "robotos-dev-x86_64", "--rt",
                      "--update-url", "https://updates.example.com/robot-os/", "--update-pubring", str(pubring))
    assert result.returncode == 0, result.stdout + result.stderr
    project = tmp_path / "o/project"
    assert "Packages=linux-image-rt-amd64" in (project / "mkosi.conf.d/00-build.conf").read_text()
    root = (project / "mkosi.extra/usr/lib/sysupdate.d/10-root.transfer").read_text()
    assert "Path=https://updates.example.com/robot-os/" in root and "root-x86-64.raw.xz" in root
    assert (project / "mkosi.extra/usr/lib/systemd/import-pubring.gpg").read_bytes() == b"test key"


def test_build_refuses_unsigned_update_source_and_unknown_profile(tmp_path):
    assert _dry_run(tmp_path, "--profile", "robotos-dev-x86_64", "--update-url", "https://x.example/").returncode == 2
    assert _dry_run(tmp_path, "--profile", "robotos-dev-x86_64", "--update-url", "http://x.example/", "--update-pubring", __file__).returncode == 2
    assert _dry_run(tmp_path, "--profile", "no-such-profile").returncode == 3


def test_validate_manifests_passes():
    result = subprocess.run(["python3", str(ROBOT / "tools/validate_manifests.py")], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
