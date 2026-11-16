#!/usr/bin/env python3
"""Harvest bad cases from feedback and rejected HITL confirmations."""

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "reports" / "bad_cases.json"


def harvest_feedback():
    # Feedback is stored by the operator in Discord/MongoDB. This script reads
    # an optional local export placed at reports/feedback_export.json.
    source = ROOT / "reports" / "feedback_export.json"
    if not source.exists():
        return []
    try:
        data = json.loads(source.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    items = data if isinstance(data, list) else data.get("items", [])
    harvested = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if item.get("category") in {"bug", "privacy", "other"} or item.get("rating") == "dislike":
            harvested.append({
                "source": "feedback",
                "id": item.get("id"),
                "category": item.get("category"),
                "inferenceMode": item.get("inferenceMode"),
                "platform": item.get("platform"),
                "appVersion": item.get("appVersion"),
                "message": item.get("message"),
            })
    return harvested


def harvest_audit_rejections():
    # Reads the hash-chained audit log for user_rejected tool calls.
    log_path = Path(os.getenv("HANNAH_AUDIT_LOG", ROOT / "logs" / "hannah_audit.jsonl"))
    if not log_path.exists():
        return []
    harvested = []
    for line in log_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if record.get("action") == "tool_rejected" and record.get("status") == "user_rejected":
            harvested.append({
                "source": "audit",
                "sequence": record.get("sequence"),
                "timestamp": record.get("timestamp"),
                "tool": record.get("tool"),
                "status": record.get("status"),
                "details": record.get("details"),
            })
    return harvested


def main():
    harvested = harvest_feedback() + harvest_audit_rejections()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(harvested, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Harvested {len(harvested)} bad cases to {OUTPUT}")


if __name__ == "__main__":
    main()
