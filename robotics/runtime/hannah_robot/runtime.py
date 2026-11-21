"""The runtime: what runs on the robot between HANNAH and the robot's own controller.

One loop, a few times a second:
  1. let the adapter work (a simulator advances; a real robot needs nothing);
  2. look at the robot's own state: emergency stop, faults, link age;
  3. take in commands that arrived, each through CommandGuard then LocalSafety;
  4. advance the running mission from what the robot's planner reports;
  5. keep the last state and the reports ready for the next exchange.

A second thread does the exchanges with the server, so a slow or dead network
never delays the loop.

What it guarantees by itself, with no server, internet or model:
  - a command with a bad signature, for another robot, expired, or older than
    one already accepted is never run;
  - a command its own limits refuse is never run, and the refusal is reported;
  - if the link is silent for longer than the robot's link timeout, the running
    mission is aborted and the robot holds position;
  - an engaged emergency stop or a fault aborts the mission at once;
  - a mission that runs out of time is stopped;
  - nothing resumes by itself afterwards: moving again takes a new command.
"""
from __future__ import annotations

import json
import sys
import threading
import time
from dataclasses import dataclass, field

from . import PROTOCOL, __version__
from .hal.base import RobotAdapter
from .link import Link, LinkError
from .protocol import CommandGuard
from .safety import MOTION, LocalSafety


@dataclass
class Mission:
    id: str
    capability: str
    params: dict
    max_speed: float
    deadline: float
    status: str = "accepted"
    phase: str = ""
    waypoints: list = field(default_factory=list)
    index: int = 0
    visited: list = field(default_factory=list)
    started: float = 0.0
    last_progress: float = 0.0
    final_report: dict | None = None


class Runtime:
    def __init__(self, adapter: RobotAdapter, guard: CommandGuard, safety: LocalSafety, link_timeout: float = 5.0, clock=time.time, log=None):
        self.adapter = adapter
        self.guard = guard
        self.safety = safety
        self.link_timeout = float(link_timeout)
        self.clock = clock
        self.log = log or (lambda event, **fields: None)
        self._lock = threading.RLock()
        self._inbox: list[dict] = []
        self._reports: list[dict] = []
        self._events: list[dict] = []
        self._missions: dict[str, Mission] = {}
        self._active: Mission | None = None
        self._stopping: Mission | None = None
        self._stop_deadline = 0.0
        self._still_since = 0.0
        self._last_link_ok = clock()
        self._link_lost = False
        self._link_ever = False
        self._was_estopped = False
        self._known_faults: set[str] = set()
        self._state: dict = {}
        self._revoked = False
        self.running = True

    # ---------------- what the link thread calls ----------------
    def outbox(self) -> dict:
        """Everything to send in the next exchange. Reports and events are handed over; give them back with requeue() if it fails."""
        with self._lock:
            reports, events = self._reports, self._events
            self._reports, self._events = [], []
            return {"runtime": {"version": __version__, "protocol": PROTOCOL, "adapter": self.adapter.name}, "state": dict(self._state), "reports": reports, "events": events}

    def requeue(self, body: dict) -> None:
        with self._lock:
            self._reports = list(body.get("reports", [])) + self._reports
            self._events = (list(body.get("events", [])) + self._events)[-100:]

    def link_ok(self, response: dict) -> None:
        with self._lock:
            self._last_link_ok = self.clock()
            self._link_ever = True
            self._inbox.extend(item for item in response.get("commands", []) if isinstance(item, dict))

    def link_refused(self, reason: str) -> None:
        """The server no longer accepts this robot (revoked). Hold and stay held."""
        with self._lock:
            if not self._revoked:
                self._revoked = True
                self._event("revoked", "error", "HANNAH's server refused this robot's credentials. Holding position.")

    # ---------------- helpers ----------------
    def _event(self, kind: str, severity: str, message: str) -> None:
        self._events.append({"at": int(self.clock() * 1000), "type": kind, "severity": severity, "message": message})
        self._events = self._events[-100:]
        self.log(kind, severity=severity, message=message)

    def _report(self, mission_id: str, status: str, **fields) -> dict:
        report = {"missionId": mission_id, "status": status, "at": int(self.clock() * 1000), **fields}
        self._reports.append(report)
        self.log("report", mission=mission_id, status=status, reason=fields.get("reason", ""))
        return report

    def _finish(self, mission: Mission, status: str, reason: str = "", result: dict | None = None) -> None:
        mission.status = status
        fields = {}
        if reason:
            fields["reason"] = reason
        if result is not None:
            fields["result"] = result
        mission.final_report = self._report(mission.id, status, **fields)
        if self._active is mission:
            self._active = None

    def _abort(self, reason: str, status: str = "failed") -> None:
        """Stop the running mission and stand still."""
        mission = self._active
        self.adapter.hold()
        if mission is not None:
            self._finish(mission, status, reason, self._result(mission))

    def _result(self, mission: Mission) -> dict:
        state = self.adapter.state()
        result = {"final": state.get("pose"), "durationS": round(self.clock() - mission.started, 1)}
        if mission.capability == "inspect_area":
            result["visited"] = mission.visited
        return result

    # ---------------- commands ----------------
    def _take(self, item: dict) -> None:
        now = self.clock()
        verdict = self.guard.check(item.get("payload"), item.get("sig"), int(now * 1000))
        if not verdict.ok:
            # Nothing is reported to the server about a command that didn't prove where it came from.
            if verdict.reason in ("bad-signature", "malformed", "wrong-robot", "unsupported-version"):
                self._event("command-refused", "error", f"A command was refused before it was read: {verdict.reason}.")
            elif verdict.reason in ("expired", "replayed", "issued-in-the-future") and verdict.command:
                self._event("command-refused", "warning", f"Command for {verdict.command.get('capability')} refused: {verdict.reason}.")
                if verdict.reason == "expired":
                    self._report(verdict.command["missionId"], "rejected", reason="The command had already expired when it reached the robot.")
            return
        command = verdict.command
        mission_id = command["missionId"]
        if command["type"] == "cancel":
            mission = self._missions.get(mission_id)
            if mission is self._active and mission is not None:
                self._abort("Cancelled by HANNAH; holding position.", "cancelled")
            elif mission is not None and mission.final_report:
                self._reports.append(mission.final_report)
            return
        if verdict.duplicate:
            known = self._missions.get(mission_id)
            if known is not None:
                self._reports.append(known.final_report or {"missionId": mission_id, "status": "accepted", "at": int(now * 1000)})
            return
        capability, params = command.get("capability"), command.get("params") or {}
        state = self.adapter.state()
        if self._revoked:
            self._report(mission_id, "rejected", reason="This robot's credentials were refused by the server; it is holding.")
            return
        decision = self.safety.check(capability, params, state, command.get("limits"), busy=self._active is not None and capability in MOTION)
        if not decision.ok:
            self._report(mission_id, "rejected", reason=f"Refused by the robot's own safety checks: {decision.reason}.")
            self._event("command-rejected", "warning", f"{capability} refused: {decision.reason}.")
            return
        timeout = float(command.get("timeoutS") or 60)
        mission = Mission(mission_id, capability, decision.params, decision.max_speed, now + timeout, started=now)
        self._missions[mission_id] = mission
        if len(self._missions) > 60:
            for old in list(self._missions)[:-60]:
                if self._missions[old] is not self._active:
                    del self._missions[old]
        self._report(mission_id, "accepted")

        if capability == "stop_motion":
            self._abort("Stopped by HANNAH.", "cancelled")
            self.adapter.hold()
            self._stopping, self._stop_deadline, self._still_since = mission, now + 6.0, 0.0
        elif capability == "set_supported_device_state":
            try:
                self.adapter.set_device(decision.params["device"], decision.params["state"] == "on")
                # Push the new state out with the report, so the server can read it back.
                self._state = self._compose(self.adapter.state())
                self._finish(mission, "succeeded", result={"device": decision.params["device"], "state": decision.params["state"]})
            except Exception as error:  # noqa: BLE001 - whatever the adapter raises is the failure
                self._finish(mission, "failed", f"The device didn't switch ({type(error).__name__}).")
        else:
            mission.waypoints = decision.params.get("waypoints") or [decision.params]
            self._active = mission
            self._start_leg(mission)

    def _start_leg(self, mission: Mission) -> None:
        goal = mission.waypoints[mission.index]
        mission.phase = f"driving to point {mission.index + 1} of {len(mission.waypoints)}" if len(mission.waypoints) > 1 else "driving"
        self.adapter.navigate(goal, mission.max_speed, mission.params.get("tolerance", 0.25))

    # ---------------- the loop ----------------
    def _compose(self, raw: dict) -> dict:
        mission = self._active
        if raw.get("estop", {}).get("engaged"):
            mode = "estopped"
        elif raw.get("faults"):
            mode = "fault"
        elif self._stopping is not None:
            mode = "stopping"
        elif mission is not None:
            mode = "navigating"
        elif raw.get("docked"):
            mode = "docked"
        elif self._link_lost or self._revoked:
            mode = "holding"
        else:
            mode = "idle"
        status = self.adapter.navigation_status()
        return {
            **raw, "at": int(self.clock() * 1000), "mode": mode,
            "mission": None if mission is None else {"id": mission.id, "capability": mission.capability, "phase": mission.phase, "distanceRemaining": None if status.distance_remaining is None else round(status.distance_remaining, 2), "secondsLeft": round(max(0.0, mission.deadline - self.clock()))},
            "link": {"ok": not self._link_lost, "silentS": round(max(0.0, self.clock() - self._last_link_ok), 1), "timeoutS": self.link_timeout},
        }

    def tick(self, wall_dt: float = 0.05) -> None:
        with self._lock:
            now = self.clock()
            self.adapter.step(wall_dt)
            self.adapter.heartbeat()
            raw = self.adapter.state()

            # The robot's own condition comes first.
            estopped = bool(raw.get("estop", {}).get("engaged"))
            if estopped and not self._was_estopped:
                self._event("estop-engaged", "error", "The emergency stop was engaged.")
                self._abort("The emergency stop was engaged.")
            elif not estopped and self._was_estopped:
                self._event("estop-released", "info", "The emergency stop was released. The robot stays still until it gets a new command.")
            self._was_estopped = estopped
            for fault in raw.get("faults") or []:
                if fault.get("code") not in self._known_faults:
                    self._known_faults.add(fault.get("code"))
                    self._event("fault", "error", str(fault.get("message") or fault.get("code")))
                    self._abort(f"The robot faulted: {fault.get('message') or fault.get('code')}")
            if not raw.get("faults"):
                self._known_faults.clear()

            # The link watchdog: silent too long means stop, whatever was being done.
            silent = now - self._last_link_ok
            if silent > self.link_timeout and not self._link_lost:
                self._link_lost = True
                self._event("link-lost", "warning", f"No contact with HANNAH for {silent:.0f} s. Holding position.")
                self._abort(f"The link to HANNAH was lost for more than {self.link_timeout:.0f} s; the robot stopped by itself.", "cancelled")
                self.adapter.hold()
            elif silent <= self.link_timeout and self._link_lost:
                self._link_lost = False
                self._event("link-restored", "info", "Contact with HANNAH is back. The robot stays still until it gets a new command.")

            inbox, self._inbox = self._inbox, []
            for item in inbox:
                self._take(item)

            self._advance(now)
            self._state = self._compose(self.adapter.state())

    def _advance(self, now: float) -> None:
        stopping = self._stopping
        if stopping is not None:
            velocity = self.adapter.state().get("velocity") or {}
            speed, turn = abs(velocity.get("linear") or 0.0), abs(velocity.get("angular") or 0.0)
            # Standing still means measured still, and staying so for a moment: not "almost stopped".
            if speed <= 0.01 and turn <= 0.02:
                self._still_since = self._still_since or now
            else:
                self._still_since = 0.0
            if self._still_since and now - self._still_since >= 0.3:
                self._stopping = None
                self._state = self._compose(self.adapter.state())
                self._finish(stopping, "succeeded", result={"stopped": True, "speed": round(speed, 3)})
            elif now > self._stop_deadline:
                self._stopping = None
                self._finish(stopping, "failed", f"The robot is still moving at {speed:.2f} m/s six seconds after the stop.")
        mission = self._active
        if mission is None:
            return
        if now > mission.deadline:
            return self._abort("The mission ran out of time; the robot stopped.", "timed-out")
        status = self.adapter.navigation_status()
        if status.state == "succeeded":
            state = self.adapter.state()
            if mission.capability == "inspect_area":
                lidar = (state.get("sensors") or {}).get("lidar") or {}
                mission.visited.append({"reached": True, "pose": state.get("pose"), "nearestObstacleM": lidar.get("minRange"), "nearestBearingDeg": lidar.get("minBearingDeg")})
                mission.index += 1
                if mission.index < len(mission.waypoints):
                    return self._start_leg(mission)
            self._state = self._compose(state)
            result = self._result(mission)
            result["travelled"] = round(status.travelled, 2)
            self._finish(mission, "succeeded", result=result)
        elif status.state == "failed":
            self._abort(status.reason or "The robot's planner gave up.")
        elif status.state in ("cancelled", "idle"):
            self._abort(status.reason or "The robot's planner dropped the goal.", "cancelled")
        elif now - mission.last_progress >= 2.0:
            mission.last_progress = now
            self._report(mission.id, "progress", progress={"phase": mission.phase, "distanceRemaining": None if status.distance_remaining is None else round(status.distance_remaining, 2), "travelled": round(status.travelled, 2)})

    def stop(self) -> None:
        self.running = False


def run(runtime: Runtime, link: Link, sync_interval: float | None = None, tick_hz: float = 20.0) -> None:
    """Run until interrupted: the control loop here, the server exchanges on a second thread."""
    pace = {"seconds": sync_interval or 1.0}

    def exchanges() -> None:
        while runtime.running:
            body = runtime.outbox()
            try:
                response = link.sync(body)
                runtime.link_ok(response)
                suggested = response.get("intervalMs")
                if sync_interval is None and isinstance(suggested, (int, float)) and suggested >= 100:
                    pace["seconds"] = suggested / 1000.0
            except LinkError as error:
                runtime.requeue(body)
                runtime.log("link-error", status=error.status, reason=error.reason or str(error))
                if error.status == 401 and error.reason in ("revoked", "bad-signature"):
                    runtime.link_refused(error.reason)
                    time.sleep(5.0)
            time.sleep(max(0.1, pace["seconds"]))

    runtime.tick(0.0)  # so the first exchange already carries a real state
    thread = threading.Thread(target=exchanges, name="hannah-link", daemon=True)
    thread.start()
    period = 1.0 / tick_hz
    previous = time.monotonic()
    try:
        while runtime.running:
            started = time.monotonic()
            runtime.tick(started - previous)
            previous = started
            time.sleep(max(0.0, period - (time.monotonic() - started)))
    finally:
        runtime.running = False
        runtime.adapter.hold()
        runtime.adapter.close()


def json_logger(stream=sys.stdout):
    def log(event: str, **fields) -> None:
        stream.write(json.dumps({"t": round(time.time(), 3), "event": event, **{key: value for key, value in fields.items() if value not in ("", None)}}) + "\n")
        stream.flush()
    return log


__all__ = ["Mission", "Runtime", "json_logger", "run"]
