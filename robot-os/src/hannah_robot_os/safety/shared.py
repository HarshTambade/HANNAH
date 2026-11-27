"""Safety state shared between Robot OS service processes.

Each service runs in its own process with its own SafetyGateway object, so an
emergency stop seen by the safety-gateway service never reached the
motor-controller service. Now:

- the safety-gateway service is the only writer: it publishes its state to one
  file every tick (written atomically);
- every other service mirrors that file into its own gateway each tick, and a
  missing or stale file is a fault ("safety gateway not reporting"), so a
  crashed gateway stops motion instead of being ignored;
- operators and tools ask the gateway to engage, release or reset through
  request files it processes in order. Nothing but the gateway changes state.

This is software coordination between processes on one computer. It is not a
safety-rated emergency stop: a physical robot needs a hardware stop circuit.
"""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

from ..common import now_ms
from .gateway import SafetyGateway

STATE_FILE = "state.json"
REQUESTS_DIR = "requests"
REQUEST_KINDS = {"engage", "release", "reset"}
NOT_REPORTING = "safety gateway not reporting"


def _write_atomic(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(data), encoding="utf-8")
    os.replace(temporary, path)


def publish(gateway: SafetyGateway, safety_dir: Path, now: int | None = None) -> dict:
    """Written by the safety-gateway service only."""
    data = {
        "estop_active": bool(gateway.estop_active),
        "estop_latched": bool(gateway.estop_latched),
        "fault": gateway.fault,
        "state": gateway.state.value,
        "written_at_ms": now_ms() if now is None else now,
    }
    _write_atomic(Path(safety_dir) / STATE_FILE, data)
    return data


def read(safety_dir: Path) -> dict | None:
    try:
        data = json.loads((Path(safety_dir) / STATE_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def mirror(gateway: SafetyGateway, safety_dir: Path, stale_after_ms: int, now: int | None = None) -> bool:
    """Copy the published state into this process's gateway. Returns True when motion may continue."""
    now = now_ms() if now is None else now
    data = read(safety_dir)
    written = int(data.get("written_at_ms") or 0) if data else 0
    if not data or written <= 0 or now - written > stale_after_ms or written - now > stale_after_ms:
        gateway.mirror(estop_active=gateway.estop_active, estop_latched=gateway.estop_latched, fault=NOT_REPORTING)
        return False
    fault = data.get("fault")
    gateway.mirror(
        estop_active=bool(data.get("estop_active")),
        estop_latched=bool(data.get("estop_latched")),
        fault=str(fault) if fault else None,
    )
    return not (gateway.estop_active or gateway.estop_latched or gateway.fault)


def submit(safety_dir: Path, kind: str, operator: str = "") -> Path:
    """Ask the safety gateway to engage, release or reset. It acts on its next tick."""
    if kind not in REQUEST_KINDS:
        raise ValueError(f"unknown safety request: {kind}")
    if kind == "reset" and not operator:
        raise ValueError("a reset needs the operator's name")
    folder = Path(safety_dir) / REQUESTS_DIR
    path = folder / f"{now_ms():015d}-{uuid.uuid4().hex}.json"
    _write_atomic(path, {"kind": kind, "operator": operator, "at_ms": now_ms()})
    return path


def drain(gateway: SafetyGateway, safety_dir: Path) -> list[dict]:
    """Apply waiting requests in the order they were made. Called by the safety-gateway service only."""
    folder = Path(safety_dir) / REQUESTS_DIR
    if not folder.is_dir():
        return []
    handled = []
    for path in sorted(folder.glob("*.json")):
        try:
            request = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            request = {}
        finally:
            path.unlink(missing_ok=True)
        kind = request.get("kind") if isinstance(request, dict) else None
        if kind == "engage":
            gateway.set_estop(True)
            handled.append({"kind": kind, "ok": True})
        elif kind == "release":
            gateway.set_estop(False)
            handled.append({"kind": kind, "ok": True, "latched": gateway.estop_latched})
        elif kind == "reset":
            decision = gateway.reset_estop(str(request.get("operator") or ""))
            handled.append({"kind": kind, "ok": decision.allowed, "reason": decision.reason})
        else:
            gateway.audit.emit("safety-gateway", "request_ignored", severity="warning", file=path.name)
    return handled
