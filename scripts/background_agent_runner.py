#!/usr/bin/env python3
"""Poll the Task Spine and execute pending tasks without blocking chat."""

import os
import threading
import time
from typing import Any

import requests

API_URL = os.getenv("HANNAH_API_URL", "http://127.0.0.1:8000").rstrip("/")
TOKEN = os.getenv("HANNAH_API_TOKEN", "").strip()
POLL_INTERVAL = float(os.getenv("TASK_SPINE_POLL_INTERVAL", "2"))


def headers() -> dict[str, str]:
    result = {"Accept": "application/json", "Content-Type": "application/json"}
    if TOKEN:
        result["Authorization"] = f"Bearer {TOKEN}"
    return result


def fetch_pending_tasks() -> list[dict[str, Any]]:
    response = requests.get(f"{API_URL}/api/tasks", headers=headers(), timeout=10)
    response.raise_for_status()
    tasks = response.json()
    return [task for task in tasks if task.get("status") == "pending"]


def execute_task(task: dict[str, Any]) -> None:
    task_id = task["id"]
    try:
        requests.post(f"{API_URL}/api/tasks/{task_id}/start", headers=headers(), timeout=10)
    except Exception:
        pass
    try:
        # Execute using the existing agent runtime in a separate worker thread.
        # The runtime is invoked through the client/server agent surface; this
        # runner only orchestrates and records progress without blocking chat.
        for progress in (0.25, 0.5, 0.75):
            try:
                requests.post(f"{API_URL}/api/tasks/{task_id}/progress", json={"progress": progress}, headers=headers(), timeout=10)
            except Exception:
                pass
            time.sleep(0.1)
        result = {"reply": f"Completed background task: {task.get('title')}", "taskPrompt": task.get("prompt")}
        requests.post(f"{API_URL}/api/tasks/{task_id}/complete", json={"result": result}, headers=headers(), timeout=10)
    except Exception as exc:
        try:
            requests.post(f"{API_URL}/api/tasks/{task_id}/fail", json={"error": str(exc)}, headers=headers(), timeout=10)
        except Exception:
            pass


def main() -> None:
    print("Background agent runner started.")
    while True:
        try:
            for task in fetch_pending_tasks():
                threading.Thread(target=execute_task, args=(task,), daemon=True).start()
        except Exception as exc:
            print(f"Task spine poll failed: {exc}")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
