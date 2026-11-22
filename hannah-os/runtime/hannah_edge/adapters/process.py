"""Per-device adapter process boundary used by the hub.

The hub process owns profile validation, allow-lists, rules and signed commands.
This worker owns one built-in protocol adapter and its device socket. IPC is a
private multiprocessing pipe; it is not exposed on the network and does not
make contributed adapter code safe to run.
"""
from __future__ import annotations

import multiprocessing
import threading
import time

from .base import AdapterError


def _serve(connection, adapter_name: str, device: dict, client_id: str) -> None:
    from . import ADAPTERS

    adapter = ADAPTERS[adapter_name](device, client_id=client_id)
    operations = {"start", "stop", "poll", "connection", "readings", "reading", "has_feedback", "refresh", "write"}
    try:
        while True:
            try:
                operation, args = connection.recv()
            except EOFError:
                break
            if operation not in operations and operation != "rejected":
                connection.send((False, {"reason": "bad-operation", "message": "The adapter worker refused an unknown request."}))
                continue
            try:
                if operation == "rejected":
                    result = adapter.rejected
                elif operation == "stop":
                    adapter.stop()
                    connection.send((True, None))
                    break
                else:
                    result = getattr(adapter, operation)(*args)
                connection.send((True, result))
            except Exception as error:
                connection.send((False, {"reason": getattr(error, "reason", "worker-error"), "message": str(error)[:300]}))
    finally:
        try:
            adapter.stop()
        except Exception:
            pass
        connection.close()


class AdapterProcess:
    """Synchronous proxy for one adapter running in a bounded child process."""

    def __init__(self, adapter_name: str, device: dict, client_id: str, timeout: float = 12.0):
        self.NAME = adapter_name
        self.points = {point["id"]: point for point in (device.get("profile") or {}).get("points", [])}
        self._timeout = timeout
        self._lock = threading.RLock()
        self._last_connection = {"state": "starting", "reason": "", "message": "", "since": time.time()}
        self._last_readings = {}
        self._last_rejected = 0
        context = multiprocessing.get_context("spawn")
        parent, child = context.Pipe(duplex=True)
        self._connection = parent
        self._process = context.Process(target=_serve, args=(child, adapter_name, device, client_id), name="hannah-adapter-" + str(device.get("id", "device"))[-8:], daemon=True)
        try:
            self._process.start()
        except Exception:
            parent.close()
            child.close()
            raise
        child.close()

    @property
    def pid(self):
        return self._process.pid

    def _stop_process(self) -> None:
        try:
            self._connection.close()
        except OSError:
            pass
        if self._process.is_alive():
            self._process.terminate()
            self._process.join(timeout=1.0)
        if self._process.is_alive():
            self._process.kill()
            self._process.join(timeout=1.0)

    def _rpc(self, operation: str, *args, timeout: float | None = None):
        with self._lock:
            if not self._process.is_alive():
                raise AdapterError("The device adapter worker stopped.", "worker-exit")
            try:
                self._connection.send((operation, args))
                if not self._connection.poll(self._timeout if timeout is None else timeout):
                    self._stop_process()
                    raise AdapterError("The device adapter worker reached its time limit and was stopped.", "worker-timeout")
                ok, result = self._connection.recv()
            except AdapterError:
                raise
            except (EOFError, OSError, BrokenPipeError):
                self._stop_process()
                raise AdapterError("The device adapter worker stopped unexpectedly.", "worker-exit") from None
            if not ok:
                raise AdapterError(result.get("message") or "The device adapter worker failed.", result.get("reason") or "worker-error")
            return result

    def start(self) -> None:
        try:
            self._rpc("start", timeout=12.0)
        except Exception:
            self._stop_process()
            raise

    def stop(self) -> None:
        try:
            if self._process.is_alive():
                self._rpc("stop", timeout=2.0)
        except Exception:
            pass
        self._stop_process()

    def poll(self) -> None:
        self._rpc("poll")

    def connection(self) -> dict:
        try:
            self._last_connection = self._rpc("connection")
        except AdapterError as error:
            self._last_connection = {"state": "error", "reason": error.reason, "message": str(error), "since": time.time()}
        return dict(self._last_connection)

    def readings(self) -> dict:
        try:
            self._last_readings = self._rpc("readings")
        except AdapterError:
            pass
        return {key: dict(value) for key, value in self._last_readings.items()}

    def reading(self, point_id: str):
        try:
            reading = self._rpc("reading", point_id)
            if reading:
                self._last_readings[point_id] = reading
            return dict(reading) if reading else None
        except AdapterError:
            return self._last_readings.get(point_id)

    @property
    def rejected(self) -> int:
        try:
            self._last_rejected = int(self._rpc("rejected"))
        except (AdapterError, TypeError, ValueError):
            pass
        return self._last_rejected

    def has_feedback(self, point_id: str) -> bool:
        try:
            return bool(self._rpc("has_feedback", point_id))
        except AdapterError:
            return False

    def refresh(self, point_id: str) -> None:
        self._rpc("refresh", point_id)

    def write(self, point_id: str, value) -> None:
        self._rpc("write", point_id, value)
