"""In-memory task spine for asynchronous Shanaya work."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

TaskStatus = Literal["pending", "running", "paused", "completed", "cancelled", "failed"]


@dataclass
class Task:
    id: str
    title: str
    prompt: str
    status: TaskStatus = "pending"
    progress: float = 0.0
    result: dict[str, Any] | None = None
    error: str | None = None
    pending_action: dict[str, Any] | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)


class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    prompt: str = Field(min_length=1, max_length=8000)


class TaskApproval(BaseModel):
    approved: bool


_TASKS: dict[str, Task] = {}
_LOCK = threading.RLock()


def create_task(title: str, prompt: str) -> Task:
    task = Task(id=str(uuid.uuid4()), title=title, prompt=prompt)
    with _LOCK:
        _TASKS[task.id] = task
    return task


def get_task(task_id: str) -> Task:
    with _LOCK:
        task = _TASKS.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found.")
    return task


def list_tasks() -> list[Task]:
    with _LOCK:
        return list(_TASKS.values())


def update_task(task_id: str, **changes: Any) -> Task:
    with _LOCK:
        task = _TASKS.get(task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="Task not found.")
        for key, value in changes.items():
            setattr(task, key, value)
        task.updated_at = time.time()
        return task


router = APIRouter()


@router.post("")
async def create(payload: TaskCreate) -> dict[str, Any]:
    task = create_task(payload.title, payload.prompt)
    return _serialize(task)


@router.get("")
async def list_all() -> list[dict[str, Any]]:
    return [_serialize(task) for task in list_tasks()]


@router.get("/{task_id}")
async def get_one(task_id: str) -> dict[str, Any]:
    return _serialize(get_task(task_id))


@router.post("/{task_id}/pause")
async def pause(task_id: str) -> dict[str, Any]:
    task = get_task(task_id)
    if task.status not in {"pending", "running"}:
        raise HTTPException(status_code=409, detail="Task cannot be paused.")
    return _serialize(update_task(task_id, status="paused"))


@router.post("/{task_id}/resume")
async def resume(task_id: str) -> dict[str, Any]:
    task = get_task(task_id)
    if task.status != "paused":
        raise HTTPException(status_code=409, detail="Task is not paused.")
    return _serialize(update_task(task_id, status="pending"))


@router.post("/{task_id}/cancel")
async def cancel(task_id: str) -> dict[str, Any]:
    task = get_task(task_id)
    if task.status in {"completed", "cancelled"}:
        raise HTTPException(status_code=409, detail="Task is already finished.")
    return _serialize(update_task(task_id, status="cancelled"))


@router.post("/{task_id}/complete")
async def complete(task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return _serialize(update_task(task_id, status="completed", progress=1.0, result=payload.get("result")))


@router.post("/{task_id}/fail")
async def fail(task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return _serialize(update_task(task_id, status="failed", error=payload.get("error")))


@router.post("/{task_id}/approve")
async def approve(task_id: str, payload: TaskApproval) -> dict[str, Any]:
    task = get_task(task_id)
    if task.pending_action is None:
        raise HTTPException(status_code=409, detail="Task has no pending action.")
    if not payload.approved:
        update_task(task_id, pending_action=None, status="cancelled")
        return _serialize(get_task(task_id))
    update_task(task_id, pending_action=None, status="pending")
    return _serialize(get_task(task_id))


def _serialize(task: Task) -> dict[str, Any]:
    return {
        "id": task.id,
        "title": task.title,
        "prompt": task.prompt,
        "status": task.status,
        "progress": task.progress,
        "result": task.result,
        "error": task.error,
        "pendingAction": task.pending_action,
        "createdAt": task.created_at,
        "updatedAt": task.updated_at,
    }