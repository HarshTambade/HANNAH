#!/usr/bin/env python3
"""What would go into each HANNAH OS image, as a manifest that is the same every time it is made.

hannah-os/images/profiles.json describes five image profiles that share one
core. This tool expands a profile into its manifest: the base system, the
packages, the services and every file of every HANNAH component with its
SHA-256. Two runs on the same tree give the same bytes, which is what a
reproducible build starts from.

    python3 tools/image_manifest.py --check          exit 1 if the description breaks a rule
    python3 tools/image_manifest.py iot-gateway      print that profile's manifest

It does not build an image. Building needs ubuntu-image or snapcraft on a
Linux machine, and nothing here has been built or booted.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DESCRIPTION = os.path.join(REPO, "hannah-os", "images", "profiles.json")
ARCHITECTURES = {"amd64", "arm64"}
BASES = {"ubuntu-server", "ubuntu-core", "yocto"}
SKIP = {"__pycache__", "tests", ".pytest_cache"}


def load() -> dict:
    with open(DESCRIPTION, encoding="utf-8") as handle:
        return json.load(handle)


def files_of(source: str) -> list:
    root = os.path.join(REPO, source)
    out = []
    for folder, names, files in os.walk(root):
        names[:] = sorted(name for name in names if name not in SKIP)
        for name in sorted(files):
            if name.endswith((".pyc", ".pyo")):
                continue
            path = os.path.join(folder, name)
            with open(path, "rb") as handle:
                data = handle.read()
            out.append({"path": os.path.relpath(path, REPO).replace(os.sep, "/"), "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})
    return out


def manifest(description: dict, profile_id: str) -> dict:
    profile = next((item for item in description["profiles"] if item["id"] == profile_id), None)
    if not profile:
        raise SystemExit(f"There is no image profile called {profile_id!r}. There are: {', '.join(item['id'] for item in description['profiles'])}.")
    core = description["core"]
    components = core["components"] + profile.get("components", [])
    return {
        "profile": profile["id"], "name": profile["name"], "built": False, "base": profile["base"], "architectures": sorted(profile["architectures"]),
        "packages": sorted(set(profile.get("packages", []))), "services": sorted(set(core["services"] + profile.get("services", []))),
        "firstBoot": profile.get("firstBoot"), "snap": profile.get("snap"), "security": core["security"],
        "components": [{"id": component["id"], "module": component["module"], "files": files_of(component["source"])} for component in components],
        "validatedHardware": description.get("validatedHardware", []),
    }


def problems(description: dict) -> list:
    found = []
    core = description.get("core", {})
    if not any(component.get("id") == "hannah-edge" for component in core.get("components", [])):
        found.append("The core must contain hannah-edge: every image is a hub first.")
    seen = set()
    for profile in description.get("profiles", []):
        tag = f"{profile.get('id')}: "
        if profile.get("id") in seen:
            found.append(tag + "listed twice")
        seen.add(profile.get("id"))
        if profile.get("base", {}).get("system") not in BASES:
            found.append(tag + f"base.system must be one of {sorted(BASES)}")
        if not profile.get("base", {}).get("why"):
            found.append(tag + "say why this base was chosen")
        if not profile.get("architectures") or not set(profile["architectures"]) <= ARCHITECTURES:
            found.append(tag + f"architectures must be from {sorted(ARCHITECTURES)}")
        for key in ("firstBoot", "snap"):
            if profile.get(key) and not os.path.exists(os.path.join(REPO, profile[key])):
                found.append(tag + f"{key} names a file that doesn't exist: {profile[key]}")
        if profile.get("base", {}).get("system") == "ubuntu-core" and not profile.get("snap"):
            found.append(tag + "an Ubuntu Core image is made of snaps: name the snap")
        if profile.get("base", {}).get("system") == "ubuntu-server" and not profile.get("firstBoot"):
            found.append(tag + "name the first-boot configuration")
        for service in core.get("services", []) + profile.get("services", []):
            if not os.path.exists(os.path.join(REPO, service)):
                found.append(tag + f"names a service file that doesn't exist: {service}")
        for component in core.get("components", []) + profile.get("components", []):
            if not os.path.isdir(os.path.join(REPO, component["source"], component["module"])):
                found.append(tag + f"component {component['id']} has no module at {component['source']}/{component['module']}")
    for wanted in ("edge", "robotics", "iot-gateway", "industrial-edge", "developer"):
        if wanted not in seen:
            found.append(f"The {wanted} profile is missing.")
    # A board is "validated" only with a record of booting it. There is none, so the list must be empty.
    for entry in description.get("validatedHardware", []):
        evidence = entry.get("evidence", "") if isinstance(entry, dict) else ""
        if not evidence or not os.path.exists(os.path.join(REPO, evidence)):
            found.append(f"validatedHardware lists {entry!r} without a boot record that exists.")
    return found


if __name__ == "__main__":
    described = load()
    if "--check" in sys.argv:
        issues = problems(described)
        for issue in issues:
            print(issue)
        print("image description is consistent" if not issues else f"{len(issues)} problem(s)")
        sys.exit(1 if issues else 0)
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    print(json.dumps(manifest(described, sys.argv[1]), indent=2, sort_keys=True))
