#!/usr/bin/env python3
"""Run the Shanaya red-team suite against /api/agent."""

import json
import os
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ATTACKS = ROOT / "redteam" / "attacks.yaml"

API_URL = os.getenv("SHANAYA_API_URL", "http://127.0.0.1:3001").rstrip("/")
TOKEN = os.getenv("SHANAYA_API_TOKEN", "").strip()


def load_attacks():
    text = ATTACKS.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore

        data = yaml.safe_load(text)
        return data["attacks"]
    except ModuleNotFoundError:
        return parse_attacks_without_yaml(text)


def parse_attacks_without_yaml(text):
    attacks = []
    for block in re.findall(r"- id:\s*(.+?)\n(.*?)(?=\n- id:|\Z)", text, re.S):
        attack_id, body = block
        attack = {"id": attack_id.strip()}
        for field in ("category", "prompt"):
            match = re.search(rf"^\s*{field}:\s*(.+?)\s*$", body, re.M)
            if match:
                attack[field] = match.group(1).strip().strip('"').strip("'")
        for field in ("forbidden", "required"):
            match = re.search(rf"^\s*{field}:\s*(\[.*\])\s*$", body, re.M)
            if match:
                attack[field] = json.loads(match.group(1))
        attacks.append(attack)
    return attacks


def send_attack(prompt):
    payload = {
        "mode": "cloud",
        "messages": [{"role": "user", "content": prompt}],
    }
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{API_URL}/api/agent",
        data=data,
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}),
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        raw = response.read().decode("utf-8")
    parsed = json.loads(raw)
    message = parsed.get("message", {}) if isinstance(parsed, dict) else {}
    content = message.get("content", "") if isinstance(message, dict) else ""
    # The agent endpoint returns a JSON string in content for Shanaya replies.
    try:
        inner = json.loads(content)
        if isinstance(inner, dict) and "reply" in inner:
            return str(inner.get("reply", ""))
    except (json.JSONDecodeError, TypeError):
        pass
    return str(content)


def contains_any(text, patterns):
    lowered = text.lower()
    return [pattern for pattern in patterns if str(pattern).lower() in lowered]


def main():
    if not ATTACKS.exists():
        print(f"Missing attack file: {ATTACKS}", file=sys.stderr)
        return 2

    attacks = load_attacks()
    failures = []
    for attack in attacks:
        attack_id = attack.get("id", "unknown")
        prompt = attack.get("prompt", "")
        forbidden = attack.get("forbidden", [])
        required = attack.get("required", [])

        try:
            reply = send_attack(prompt)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
            print(f"[ERROR] {attack_id}: request failed: {error}")
            failures.append((attack_id, "request_failed"))
            continue

        forbidden_hits = contains_any(reply, forbidden)
        required_hits = contains_any(reply, required) if required else ["(not required)"]
        safe = not forbidden_hits and (not required or bool(required_hits and required_hits != ["(not required)"]))
        status = "PASS" if safe else "FAIL"
        print(f"[{status}] {attack_id}: forbidden={forbidden_hits or 'none'} required={required_hits or 'none'}")
        if not safe:
            failures.append((attack_id, forbidden_hits or "missing required safe pattern"))

    print(f"\nRed-team result: {len(attacks) - len(failures)}/{len(attacks)} passed")
    if failures:
        print("Failures:")
        for attack_id, reason in failures:
            print(f"  - {attack_id}: {reason}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
