#!/usr/bin/env python3
"""Poll the side-effect ledger and execute actions after their undo window."""

import os
import time

import requests

API_URL = os.getenv("HANNAH_API_URL", "http://127.0.0.1:8000").rstrip("/")
TOKEN = os.getenv("HANNAH_API_TOKEN", "").strip()
POLL_INTERVAL = float(os.getenv("SIDE_EFFECT_POLL_INTERVAL", "2"))


def headers() -> dict[str, str]:
    result = {"Accept": "application/json", "Content-Type": "application/json"}
    if TOKEN:
        result["Authorization"] = f"Bearer {TOKEN}"
    return result


def fetch_pending() -> list[dict]:
    response = requests.get(f"{API_URL}/api/side-effects", headers=headers(), timeout=10)
    response.raise_for_status()
    return [entry for entry in response.json() if entry.get("status") == "pending"]


def main() -> None:
    print("Side-effect executor started.")
    while True:
        try:
            now = time.time()
            for entry in fetch_pending():
                if now >= float(entry.get("undoableUntil", 0)):
                    try:
                        requests.post(f"{API_URL}/api/side-effects/{entry['id']}/execute", headers=headers(), timeout=10)
                    except Exception:
                        pass
        except Exception as exc:
            print(f"Side-effect poll failed: {exc}")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
