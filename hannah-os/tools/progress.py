#!/usr/bin/env python3
"""The HANNAH OS implementation tracker.

hannah-os/PROGRESS.json is the record: one entry per requirement of the
HANNAH OS specification, with its real state. This tool checks it and writes
the page people read, hannah-os/HANNAH_OS_IMPLEMENTATION_TRACKER.md.

    python3 hannah-os/tools/progress.py            write the page
    python3 hannah-os/tools/progress.py --check    exit 1 if the record breaks a rule or the page is out of date

The rules are the robotics tracker's (robotics/tools/progress.py), so the two
can't drift apart: VERIFIED needs a test file that exists and says at which
level (unit, server, sim, browser); a hardware level needs an evidence file;
a blocked entry names a listed blocker; every file named has to exist.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
RECORD = os.path.join(REPO, "hannah-os", "PROGRESS.json")
PAGE = os.path.join(REPO, "hannah-os", "HANNAH_OS_IMPLEMENTATION_TRACKER.md")
spec = importlib.util.spec_from_file_location("robotics_progress", os.path.join(REPO, "robotics", "tools", "progress.py"))
rules = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rules)


def load() -> dict:
    with open(RECORD, encoding="utf-8") as handle:
        return json.load(handle)


def render(record: dict) -> str:
    items = record["items"]
    count = {status: sum(1 for item in items if item["status"] == status) for status in rules.STATUSES}
    lines = [
        "# HANNAH OS — implementation tracker",
        "",
        "Generated from `PROGRESS.json` by `hannah-os/tools/progress.py`. Edit the JSON, not this page.",
        "",
        f"Updated {record['updated']}. **No physical device, robot, board or image is behind anything on this page.** \"sim\" means HANNAH's own simulated devices and simulators. HANNAH is not safety-certified and is not a safety system.",
        "",
        "| Status | Count | Meaning |",
        "|---|---|---|",
    ]
    lines += [f"| {status} | {count[status]} | {rules.MEANING[status]} |" for status in rules.STATUSES]
    stage = None
    for item in items:
        if item["stage"] != stage:
            stage = item["stage"]
            lines += ["", f"## {record['stages'][stage]}", "", "| # | Requirement | Status | Verified at | Tests | Note |", "|---|---|---|---|---|---|"]
        tests = ", ".join(f"`{os.path.basename(path)}`" for path in item.get("tests", [])) or "—"
        note = item.get("note", "")
        if item.get("blockedBy"):
            note = (note + " " if note else "") + "Blocked by " + ", ".join(item["blockedBy"]) + "."
        lines.append(f"| {item['id']} | {item['feature']} | {item['status']} | {', '.join(item.get('where', [])) or '—'} | {tests} | {note} |")
    lines += ["", "## External blockers", "", "See `HANNAH_OS_BLOCKERS.md` for what each needs from the owner.", "", "| Id | What is missing | What it holds up |", "|---|---|---|"]
    lines += [f"| {entry['id']} | {entry['what']} | {entry['unblocks']} |" for entry in record["blockers"]]
    lines += ["", "## Next unblocked tasks", ""]
    lines += [f"{index}. {task}" for index, task in enumerate(record["next"], 1)] or ["None."]
    lines += ["", "## Last full verification", ""]
    lines += [f"- {key}: {value}" for key, value in record["lastVerified"].items()]
    lines += ["", "## To resume", "", "```sh"] + record["resume"] + ["```", ""]
    return "\n".join(lines)


def main() -> int:
    record = load()
    found = rules.problems(record)
    stages = set(record["stages"])
    found += [f"{item['id']}: unknown stage {item['stage']}" for item in record["items"] if item["stage"] not in stages]
    if found:
        print("\n".join(found), file=sys.stderr)
        return 1
    page = render(record)
    if "--check" in sys.argv:
        current = open(PAGE, encoding="utf-8").read() if os.path.exists(PAGE) else ""
        if current != page:
            print("hannah-os/HANNAH_OS_IMPLEMENTATION_TRACKER.md is out of date. Run: python3 hannah-os/tools/progress.py", file=sys.stderr)
            return 1
        return 0
    with open(PAGE, "w", encoding="utf-8") as handle:
        handle.write(page)
    return 0


if __name__ == "__main__":
    sys.exit(main())
