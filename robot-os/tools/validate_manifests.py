#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    profiles = ROOT / "image-profiles" / "profiles.json"
    data = json.loads(profiles.read_text(encoding="utf-8"))
    if data.get("version") != 1:
        print("invalid profiles version", file=sys.stderr)
        return 1
    ids = set()
    for p in data.get("profiles", []):
        pid = p.get("id")
        if not pid or pid in ids:
            print(f"invalid/duplicate profile id: {pid}", file=sys.stderr)
            return 1
        ids.add(pid)
        for req in ["name", "arch", "base", "target", "services", "status"]:
            if req not in p:
                print(f"missing {req} in {pid}", file=sys.stderr)
                return 1
    print(f"ok: {len(ids)} profiles")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
