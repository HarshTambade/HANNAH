#!/usr/bin/env python3
"""Write server/devices/catalog.json from hannah-os/profiles/*.json.

The server is deployed from its own folder, so the profiles it ships have to
live inside it. This keeps one source (hannah-os/profiles) and one generated
copy; `--check` exits 1 when the copy is out of date.
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SOURCE = os.path.join(REPO, "hannah-os", "profiles")
TARGET = os.path.join(REPO, "server", "devices", "catalog.json")


def build() -> str:
    profiles = []
    for path in sorted(glob.glob(os.path.join(SOURCE, "*.json"))):
        with open(path, encoding="utf-8") as handle:
            profiles.append(json.load(handle))
    return json.dumps(profiles, indent=1, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    text = build()
    if "--check" in sys.argv:
        current = open(TARGET, encoding="utf-8").read() if os.path.exists(TARGET) else ""
        if current != text:
            print("server/devices/catalog.json is out of date. Run: python3 hannah-os/tools/build_catalog.py")
            sys.exit(1)
        print("catalog is current")
    else:
        with open(TARGET, "w", encoding="utf-8") as handle:
            handle.write(text)
        print(f"wrote {TARGET}")
