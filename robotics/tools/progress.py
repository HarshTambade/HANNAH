#!/usr/bin/env python3
"""The robotics implementation tracker.

docs/robotics/ROBOTICS_PROGRESS.json is the record: one entry per requirement of
the master directive, with its real state. This tool checks it and writes the
page people read, docs/robotics/ROBOTICS_PROGRESS.md.

    python3 tools/progress.py                     write the page
    python3 tools/progress.py --check             exit 1 if the record breaks a rule or the page is out of date
    python3 tools/progress.py set 5.2 VERIFIED --where sim --tests server/robotics.plans.test.js --note "..."

The rules exist so the record can't say more than was done:

  - VERIFIED needs at least one test file that exists, and says where it was
    verified: unit, server, sim (HANNAH's built-in simulators) or browser.
  - "gazebo", "hardware-in-the-loop" and "physical" need an evidence file as
    well. There is none yet, so nothing can be marked that way.
  - BLOCKED_EXTERNAL_DEPENDENCY names a blocker from the list.
  - Every file an entry names has to exist.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
RECORD = os.path.join(REPO, "docs", "robotics", "ROBOTICS_PROGRESS.json")
PAGE = os.path.join(REPO, "docs", "robotics", "ROBOTICS_PROGRESS.md")

STATUSES = ["NOT_STARTED", "IN_PROGRESS", "IMPLEMENTED", "TESTING", "VERIFIED", "BLOCKED_EXTERNAL_DEPENDENCY"]
SOFTWARE = {"unit", "server", "sim", "browser"}
NEEDS_EVIDENCE = {"gazebo", "hardware-in-the-loop", "physical"}
MEANING = {
    "NOT_STARTED": "Nothing exists",
    "IN_PROGRESS": "Being built; not usable yet",
    "IMPLEMENTED": "Code exists; it has not been run or has no test that proves it",
    "TESTING": "Tests exist and are not all passing",
    "VERIFIED": "Implemented and its tests pass, at the level named",
    "BLOCKED_EXTERNAL_DEPENDENCY": "Can't go further without something only the owner can provide",
}


def load() -> dict:
    with open(RECORD, encoding="utf-8") as handle:
        return json.load(handle)


def problems(record: dict) -> list:
    found = []
    blockers = {entry["id"] for entry in record.get("blockers", [])}
    seen = set()
    for item in record.get("items", []):
        tag = f"{item.get('id')}: "
        if item.get("id") in seen:
            found.append(tag + "listed twice")
        seen.add(item.get("id"))
        status = item.get("status")
        if status not in STATUSES:
            found.append(tag + f"unknown status {status!r}")
        for path in list(item.get("files", [])) + list(item.get("tests", [])) + list(item.get("evidence", [])):
            if not os.path.exists(os.path.join(REPO, path)):
                found.append(tag + f"names a file that doesn't exist: {path}")
        where = set(item.get("where", []))
        if status == "VERIFIED":
            if not item.get("tests"):
                found.append(tag + "VERIFIED without a test")
            if not where:
                found.append(tag + "VERIFIED without saying where")
        if where - SOFTWARE - NEEDS_EVIDENCE:
            found.append(tag + f"unknown level {sorted(where - SOFTWARE - NEEDS_EVIDENCE)}")
        if where & NEEDS_EVIDENCE and not item.get("evidence"):
            found.append(tag + f"claims {sorted(where & NEEDS_EVIDENCE)} without an evidence file")
        if status == "BLOCKED_EXTERNAL_DEPENDENCY" and not (set(item.get("blockedBy", [])) and set(item.get("blockedBy", [])) <= blockers):
            found.append(tag + "blocked without naming a listed blocker")
        for blocker in item.get("blockedBy", []):
            if blocker not in blockers:
                found.append(tag + f"names an unknown blocker {blocker}")
    return found


def render(record: dict) -> str:
    items = record["items"]
    count = {status: sum(1 for item in items if item["status"] == status) for status in STATUSES}
    lines = [
        "# HANNAH Robotics — implementation tracker",
        "",
        "Generated from `ROBOTICS_PROGRESS.json` by `robotics/tools/progress.py`. Edit the JSON, not this page.",
        "",
        f"Updated {record['updated']}. **Nothing here has run in Gazebo, with ROS 2, or on a physical robot.** \"sim\" means HANNAH's own built-in simulators. HANNAH is not safety-certified.",
        "",
        "| Status | Count | Meaning |",
        "|---|---|---|",
    ]
    lines += [f"| {status} | {count[status]} | {MEANING[status]} |" for status in STATUSES]
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
    lines += ["", "## External blockers", "", "| Id | What is missing | What it needs | What it holds up |", "|---|---|---|---|"]
    lines += [f"| {entry['id']} | {entry['what']} | {entry['needs']} | {entry['unblocks']} |" for entry in record["blockers"]]
    lines += ["", "## Next unblocked tasks", ""]
    lines += [f"{index}. {task}" for index, task in enumerate(record["next"], 1)] or ["None."]
    lines += ["", "## Last full verification", ""]
    lines += [f"- {key}: {value}" for key, value in record["lastVerified"].items()]
    lines += ["", "## To resume", "", "```sh"] + record["resume"] + ["```", ""]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--check", action="store_true")
    sub = parser.add_subparsers(dest="command")
    setter = sub.add_parser("set")
    setter.add_argument("id")
    setter.add_argument("status", choices=STATUSES)
    setter.add_argument("--where", default=None)
    setter.add_argument("--tests", default=None)
    setter.add_argument("--files", default=None)
    setter.add_argument("--note", default=None)
    args = parser.parse_args()
    record = load()
    if args.command == "set":
        item = next((entry for entry in record["items"] if entry["id"] == args.id), None)
        if item is None:
            print(f"No entry {args.id}.", file=sys.stderr)
            return 1
        item["status"] = args.status
        for name in ("where", "tests", "files"):
            value = getattr(args, name)
            if value is not None:
                item[name] = [part for part in value.split(",") if part]
        if args.note is not None:
            item["note"] = args.note
        if args.status != "BLOCKED_EXTERNAL_DEPENDENCY" and args.status == "VERIFIED":
            item.pop("blockedBy", None)
        with open(RECORD, "w", encoding="utf-8") as handle:
            json.dump(record, handle, indent=1, ensure_ascii=False)
            handle.write("\n")
    found = problems(record)
    if found:
        print("\n".join(found), file=sys.stderr)
        return 1
    page = render(record)
    if args.check:
        current = open(PAGE, encoding="utf-8").read() if os.path.exists(PAGE) else ""
        if current != page:
            print("ROBOTICS_PROGRESS.md is out of date. Run: python3 robotics/tools/progress.py", file=sys.stderr)
            return 1
        return 0
    with open(PAGE, "w", encoding="utf-8") as handle:
        handle.write(page)
    return 0


if __name__ == "__main__":
    sys.exit(main())
