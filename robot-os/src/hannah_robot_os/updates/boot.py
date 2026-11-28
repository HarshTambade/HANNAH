"""Tie the A/B update state to what the disk image actually booted.

The image has two root partitions. `systemd-sysupdate` writes a new version to
the unused one plus a boot entry with a try counter; systemd-boot falls back to
the previous entry when the new one never reaches `boot-complete.target`, and
`hannah-boot-ready.service` only lets the boot complete once the READY gate
passes. This module keeps `UpdateState` honest about the result:

- `stage` records the pending version and the boot it was staged in;
- after a reboot, `confirm` promotes the pending version when the robot is
  running it and READY passed, and records a rollback when the robot came back
  up on the old version instead;
- `gate` refuses to apply an update unless the safety gateway is reporting and
  the software stop is engaged, so an update never reboots a robot that may move.
"""
from __future__ import annotations

from pathlib import Path

from ..common import now_ms
from ..safety import shared
from .state import UpdateState


def read_os_release_version(path: str | Path = "/usr/lib/os-release") -> str | None:
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    values = {}
    for line in lines:
        if "=" in line and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values.get("IMAGE_VERSION") or values.get("VERSION_ID")


def read_boot_id(path: str | Path = "/proc/sys/kernel/random/boot_id") -> str | None:
    try:
        return Path(path).read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def stage(state: UpdateState, version: str, boot_id: str | None) -> UpdateState:
    version = version.strip()
    if not version:
        raise ValueError("version is required")
    if version == state.current_version:
        raise ValueError(f"version {version} is already running")
    state.stage(version)
    state.staged_boot_id = boot_id
    return state


def confirm(state: UpdateState, running_version: str | None, boot_id: str | None, robot_ready: bool) -> str:
    """Record the outcome of this boot. Returns what happened, in a word."""
    if not robot_ready:
        return "not-ready"
    if not running_version:
        return "unknown-version"
    if state.pending_version:
        if running_version == state.pending_version:
            state.mark_healthy()
            return "promoted"
        if boot_id and state.staged_boot_id and boot_id != state.staged_boot_id:
            # A reboot happened since staging and the robot is not running the new version:
            # the boot loader fell back to the previous entry.
            state.rollback()
            return "rolled-back"
        return "pending"
    if state.status in {"idle", "healthy", "rolled_back"} and state.current_version != running_version:
        # First boot of a fresh image, or a version installed outside this state file.
        state.current_version = running_version
        state.last_good_version = running_version
        state.status = "healthy"
        return "recorded"
    return "unchanged"


def gate(safety_dir: str | Path, stale_after_ms: int, now: int | None = None) -> tuple[bool, str]:
    """An update may be applied only while the robot is held stopped."""
    now = now_ms() if now is None else now
    data = shared.read(Path(safety_dir))
    if not data:
        return False, "the safety gateway hasn't published its state"
    written = int(data.get("written_at_ms") or 0)
    if written <= 0 or abs(now - written) > stale_after_ms:
        return False, "the safety gateway's state is stale"
    if not data.get("estop_active"):
        return False, "engage the software stop before updating (hannah-robot-os safety engage)"
    return True, "software stop engaged"
