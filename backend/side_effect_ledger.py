"""Side-effect ledger with an undo window for irreversible actions."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

SideEffectStatus = Literal["pending", "executed", "undone"]

DEFAULT_DELAY_SECONDS = 30


@dataclass
class SideEffectEntry:
    id: str
    action: str
    target: str
    timestamp: float
    delay_seconds: int
    status: SideEffectStatus = "pending"
    undoable_until: float = field(default_factory=lambda: time.time())


class SideEffectCreate(BaseModel):
    action: str = Field(min_length=1, max_length=120)
    target: str = Field(min_length=1, max_length=4096)
    delay_seconds: int = Field(default=DEFAULT_DELAY_SECONDS, ge=1, le=3600)


class UndoRequest(BaseModel):
    id: str | None = None


_ENTRIES: dict[str, SideEffectEntry] = {}
_LOCK = threading.RLock()


def record(action: str, target: str, delay_seconds: int = DEFAULT_DELAY_SECONDS) -> SideEffectEntry:
    now = time.time()
    entry = SideEffectEntry(
        id=str(uuid.uuid4()),
        action=action,
        target=target,
        timestamp=now,
        delay_seconds=delay_seconds,
        status="pending",
        undoable_until=now + delay_seconds,
    )
    with _LOCK:
        _ENTRIES[entry.id] = entry
    return entry


def get_entry(entry_id: str) -> SideEffectEntry:
    with _LOCK:
        entry = _ENTRIES.get(entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Side effect not found.")
    return entry


def list_entries() -> list[SideEffectEntry]:
    with _LOCK:
        return list(_ENTRIES.values())


def undo(entry_id: str) -> SideEffectEntry:
    with _LOCK:
        entry = _ENTRIES.get(entry_id)
        if entry is None:
            raise HTTPException(status_code=404, detail="Side effect not found.")
        if entry.status != "pending":
            raise HTTPException(status_code=409, detail="Side effect is no longer undoable.")
        if time.time() > entry.undoable_until:
            raise HTTPException(status_code=409, detail="Undo window has expired.")
        entry.status = "undone"
        entry.undoable_until = time.time()
        return entry


def mark_executed(entry_id: str) -> SideEffectEntry:
    with _LOCK:
        entry = _ENTRIES.get(entry_id)
        if entry is None:
            raise HTTPException(status_code=404, detail="Side effect not found.")
        if entry.status == "pending" and time.time() >= entry.undoable_until:
            entry.status = "executed"
        return entry


def pending_executable() -> list[SideEffectEntry]:
    now = time.time()
    with _LOCK:
        return [entry for entry in _ENTRIES.values() if entry.status == "pending" and now >= entry.undoable_until]


def _serialize(entry: SideEffectEntry) -> dict[str, Any]:
    return {
        "id": entry.id,
        "action": entry.action,
        "target": entry.target,
        "timestamp": entry.timestamp,
        "delaySeconds": entry.delay_seconds,
        "status": entry.status,
        "undoableUntil": entry.undoable_until,
    }


router = APIRouter()


@router.post("")
async def create(payload: SideEffectCreate) -> dict[str, Any]:
    entry = record(payload.action, payload.target, payload.delay_seconds)
    return _serialize(entry)


@router.get("")
async def list_all() -> list[dict[str, Any]]:
    return [_serialize(entry) for entry in list_entries()]


@router.get("/{entry_id}")
async def get_one(entry_id: str) -> dict[str, Any]:
    return _serialize(get_entry(entry_id))


@router.post("/{entry_id}/undo")
async def undo_one(entry_id: str) -> dict[str, Any]:
    return _serialize(undo(entry_id))


@router.post("/undo")
async def undo_by_body(payload: UndoRequest) -> dict[str, Any]:
    if not payload.id:
        raise HTTPException(status_code=400, detail="Side effect id is required.")
    return _serialize(undo(payload.id))


@router.post("/{entry_id}/execute")
async def execute_one(entry_id: str) -> dict[str, Any]:
    return _serialize(mark_executed(entry_id))
