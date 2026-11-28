"""Configuration backups taken before an update, and their validated restore.

`take` copies the configuration files (the Robot OS config, the hardware
profile, the safety limits) into a backup folder with each file's SHA-256 and
the hardware identity the robot had at that moment.

`restore` puts them back only when:

- every file is still exactly what was backed up (no corrupted or edited backup);
- the robot is still the same hardware (a backup from before a motor or
  controller swap is not restored onto the new hardware);
- every file passes the validator given (for example the config and hardware
  profile validators), so a rollback never restores a configuration that
  doesn't validate.

Otherwise it refuses and leaves the current files alone.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path
from typing import Any, Callable

from ..common import now_ms


class BackupError(RuntimeError):
    pass


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def hardware_identity(facts: dict) -> str:
    keys = ("manufacturer", "model", "serialNumber", "controllerHardwareId", "robotType")
    return hashlib.sha256(json.dumps({key: str(facts.get(key, "")) for key in keys}, sort_keys=True).encode("utf-8")).hexdigest()[:24]


def take(backup_root: str | Path, backup_id: str, files: list[str | Path], facts: dict, now: Callable[[], int] = now_ms) -> dict:
    if not backup_id or "/" in backup_id or backup_id.startswith("."):
        raise BackupError("bad backup id")
    folder = Path(backup_root) / backup_id
    if folder.exists():
        raise BackupError(f"backup {backup_id} already exists")
    folder.mkdir(parents=True)
    entries = []
    for index, source in enumerate(Path(item) for item in files):
        if not source.is_file():
            continue
        stored = folder / f"{index:02d}-{source.name}"
        shutil.copy2(source, stored)
        entries.append({"source": str(source), "stored": stored.name, "sha256": _digest(stored)})
    record = {"id": backup_id, "takenAtMs": int(now()), "hardware": hardware_identity(facts), "files": entries}
    (folder / "backup.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record


def restore(backup_root: str | Path, backup_id: str, facts: dict, validate: Callable[[Path], Any] | None = None) -> dict:
    folder = Path(backup_root) / backup_id
    try:
        record = json.loads((folder / "backup.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise BackupError(f"backup {backup_id} not found") from None
    if record.get("hardware") != hardware_identity(facts):
        raise BackupError("the robot's hardware changed since this backup; it is not restored onto different hardware")
    for entry in record["files"]:
        stored = folder / entry["stored"]
        if not stored.is_file() or _digest(stored) != entry["sha256"]:
            raise BackupError(f"backup file {entry['stored']} was changed or is missing")
        if validate is not None:
            try:
                validate(stored)
            except Exception as error:  # noqa: BLE001 - any validator failure refuses the restore
                raise BackupError(f"backup file {entry['stored']} doesn't validate: {error}") from None
    for entry in record["files"]:
        target = Path(entry["source"])
        temporary = target.with_name(f".{target.name}.restore")
        shutil.copy2(folder / entry["stored"], temporary)
        os.replace(temporary, target)
    return {"id": backup_id, "restored": [entry["source"] for entry in record["files"]]}
