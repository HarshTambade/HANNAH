#!/usr/bin/env python3
"""Check image-profiles/profiles.json against itself and against the mkosi image config."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MKOSI = ROOT / "images" / "mkosi"

STATUSES = {"experimental", "not_supported"}
ARCHES = {"amd64": "x86-64", "arm64": "arm64"}
BOARDS = {"uefi", "rpi"}
KERNELS = {"standard", "rt"}
CI_MODES = {"build-and-boot", "manual"}


def mkosi_packages(path: Path) -> set[str]:
    """Packages= values from an mkosi config file (one per line or space separated)."""
    packages: set[str] = set()
    in_packages = False
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if line[:1].isspace() and in_packages:
            packages.update(stripped.split())
            continue
        in_packages = False
        match = re.match(r"^Packages=(.*)$", stripped)
        if match:
            in_packages = True
            packages.update(match.group(1).split())
    return packages


def image_packages(board: str) -> set[str]:
    found = mkosi_packages(MKOSI / "common" / "mkosi.conf")
    for conf in sorted((MKOSI / "boards" / board / "mkosi.conf.d").glob("*.conf")):
        found |= mkosi_packages(conf)
    return found


def check_profile(p: dict, units: set[str]) -> list[str]:
    pid = p.get("id")
    errors = []
    for req in ["name", "arch", "base", "target", "services", "status", "image"]:
        if req not in p:
            errors.append(f"missing {req} in {pid}")
    if errors:
        return errors
    if p["status"] not in STATUSES:
        errors.append(f"{pid}: status {p['status']!r} is not one of {sorted(STATUSES)}")
    if p["arch"] not in ARCHES:
        errors.append(f"{pid}: arch {p['arch']!r} is not one of {sorted(ARCHES)}")
    for service in p["services"]:
        if f"{service}.service" not in units:
            errors.append(f"{pid}: service {service} has no unit in robot-os/systemd")
    img = p["image"]
    if img.get("tool") != "mkosi":
        errors.append(f"{pid}: image.tool must be mkosi")
    if img.get("board") not in BOARDS or not (MKOSI / "boards" / str(img.get("board"))).is_dir():
        errors.append(f"{pid}: image.board {img.get('board')!r} has no images/mkosi/boards directory")
    if ARCHES.get(p["arch"]) != img.get("arch"):
        errors.append(f"{pid}: image.arch {img.get('arch')!r} doesn't match arch {p['arch']!r}")
    if img.get("kernel") not in KERNELS:
        errors.append(f"{pid}: image.kernel must be one of {sorted(KERNELS)}")
    if img.get("ci") not in CI_MODES:
        errors.append(f"{pid}: image.ci must be one of {sorted(CI_MODES)}")
    if img.get("board") == "rpi" and img.get("arch") != "arm64":
        errors.append(f"{pid}: the rpi board is arm64 only")
    if not errors:
        missing = set(p.get("packages", [])) - image_packages(img["board"])
        if missing:
            errors.append(f"{pid}: packages not in the image config: {', '.join(sorted(missing))}")
    return errors


def main() -> int:
    profiles = ROOT / "image-profiles" / "profiles.json"
    data = json.loads(profiles.read_text(encoding="utf-8"))
    if data.get("version") != 1:
        print("invalid profiles version", file=sys.stderr)
        return 1
    units = {u.name for u in (ROOT / "systemd").iterdir()}
    ids = set()
    errors: list[str] = []
    for p in data.get("profiles", []):
        pid = p.get("id")
        if not pid or pid in ids:
            print(f"invalid/duplicate profile id: {pid}", file=sys.stderr)
            return 1
        ids.add(pid)
        errors.extend(check_profile(p, units))
    if not any(p.get("image", {}).get("ci") == "build-and-boot" for p in data.get("profiles", [])):
        errors.append("no profile is built and boot-checked in CI (image.ci = build-and-boot)")
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print(f"ok: {len(ids)} profiles")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
