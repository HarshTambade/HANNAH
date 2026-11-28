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
  - nothing resumes by itself afterwards: moving again takes a new command;
  - a command its operating mode doesn't allow is refused, and a change of
    mode the transition table doesn't allow is refused (modes.py);
  - under manual control, it moves only on a fresh operator command: when no
    new one arrives within the deadman time, when the link drops or when the
    session is withdrawn, it holds.
"""
from __future__ import annotations

import json
import math
import sys
import threading
import time
from dataclasses import dataclass, field

from . import PROTOCOL, __version__
from . import modes
from .geometry import point_in_polygon
from .hal.base import RobotAdapter
from .link import Link, LinkError
from .protocol import CommandGuard
from .safety import ARM, EXCLUSIVE, LocalSafety
from .vision import capture_result, provider


# Under manual control the link may be silent this long at most before the robot holds and drops the session.
TELEOP_LINK_TIMEOUT = 2.0


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
    paused_at: float = 0.0
    final_report: dict | None = None


class Runtime:
    def __init__(self, adapter: RobotAdapter, guard: CommandGuard, safety: LocalSafety, link_timeout: float = 5.0, clock=time.time, log=None, descriptor: dict | None = None, blackbox=None):
        self.adapter = adapter
        # The black box (blackbox/hook.py), when recording is on. It only listens: nothing here waits for it or depends on it.
        self.blackbox = blackbox
        # Sent with the first exchange after each start, so a profile changed while
        # the robot was off (a longer link timeout, a removed keep-out zone) reaches
        # the server, which then asks for commissioning again.
        self._descriptor = descriptor
        self._descriptor_pending = descriptor is not None
        self.guard = guard
        self.safety = safety
        self.vision = provider(getattr(adapter, "vision_provider", None))
        self.link_timeout = float(link_timeout)
        # The profile's own watchdog; a command can only shorten it, never lengthen it.
        self._own_link_timeout = float(link_timeout)
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
        # A ResourceReportReader (resources.py) or None.
        self.resources = None
        # The operating mode: what was last taken (kept by the guard on disk), else the default for this kind of robot.
        simulated = bool((adapter.describe() or {}).get("simulation"))
        saved = getattr(guard, "saved_mode", None)
        self.mode = saved if saved in modes.MODES else modes.default_mode(simulated)
        self.mode_seq = int(getattr(guard, "mode_seq", 0) or 0)
        self._mode_refused: dict | None = None
        # Manual control: the session the server handed over, its limits, and the last command taken.
        self._teleop: dict | None = None
        # The server's clock minus this robot's, from the last exchange: manual commands expire on the server's clock.
        self._server_offset_ms = 0

    # ---------------- what the link thread calls ----------------
    def outbox(self) -> dict:
        """Everything to send in the next exchange. Reports and events are handed over; give them back with requeue() if it fails."""
        with self._lock:
            reports, events = self._reports, self._events
            self._reports, self._events = [], []
            body = {"runtime": {"version": __version__, "protocol": PROTOCOL, "adapter": self.adapter.name}, "state": dict(self._state), "reports": reports, "events": events}
            # The onboard Edge Resource Manager's measurements, when Robot OS runs beside this runtime.
            resources = self.resources.due() if self.resources is not None else None
            if resources is not None:
                body["resources"] = resources
            if self._descriptor_pending:
                body["descriptor"] = self._descriptor
            return body

    def requeue(self, body: dict) -> None:
        with self._lock:
            self._reports = list(body.get("reports", [])) + self._reports
            self._events = (list(body.get("events", [])) + self._events)[-100:]

    def link_ok(self, response: dict) -> None:
        with self._lock:
            self._last_link_ok = self.clock()
            if isinstance(response.get("serverTime"), (int, float)):
                self._server_offset_ms = int(response["serverTime"] - self.clock() * 1000)
            self._link_ever = True
            self._descriptor_pending = False
            self._inbox.extend(item for item in response.get("commands", []) if isinstance(item, dict))

    def link_refused(self, reason: str) -> None:
        """The server no longer accepts this robot (revoked). Hold and stay held."""
        with self._lock:
            if not self._revoked:
                self._revoked = True
                self._event("revoked", "error", "HANNAH's server refused this robot's credentials. Holding position.")

    # ---------------- helpers ----------------
    def _record(self, method: str, *args) -> None:
        if self.blackbox is None:
            return
        try:
            getattr(self.blackbox, method)(*args)
        except Exception as error:  # noqa: BLE001 - recording must never stop the control loop
            self.log("blackbox-error", error=f"{type(error).__name__}: {error}")

    def _event(self, kind: str, severity: str, message: str) -> None:
        at = int(self.clock() * 1000)
        self._events.append({"at": at, "type": kind, "severity": severity, "message": message})
        self._events = self._events[-100:]
        self.log(kind, severity=severity, message=message)
        self._record("on_event", kind, severity, message, at)

    def _report(self, mission_id: str, status: str, **fields) -> dict:
        report = {"missionId": mission_id, "status": status, "at": int(self.clock() * 1000), **fields}
        self._reports.append(report)
        self.log("report", mission=mission_id, status=status, reason=fields.get("reason", ""))
        self._record("on_report", report)
        return report

    def _finish(self, mission: Mission, status: str, reason: str = "", result: dict | None = None, attachment: dict | None = None) -> None:
        mission.status = status
        fields = {}
        if reason:
            fields["reason"] = reason
        if result is not None:
            fields["result"] = result
        # What is kept for answering a repeated command is the report without the image: an image is sent once.
        mission.final_report = {"missionId": mission.id, "status": status, "at": int(self.clock() * 1000), **fields}
        self._report(mission.id, status, **fields, **({"attachment": attachment} if attachment else {}))
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
        verdict = self.guard.check(item.get("payload"), item.get("sig"), int(now * 1000), int(now * 1000) + self._server_offset_ms)
        if not verdict.ok:
            # Nothing is reported to the server about a command that didn't prove where it came from.
            if verdict.reason in ("bad-signature", "malformed", "wrong-robot", "unsupported-version"):
                self._event("command-refused", "error", f"A command was refused before it was read: {verdict.reason}.")
            elif verdict.command and verdict.command.get("type") == "teleop":
                # A late or repeated manual command is dropped: the deadman holds the robot if nothing fresh follows.
                pass
            elif verdict.reason in ("expired", "replayed", "issued-in-the-future") and verdict.command:
                self._event("command-refused", "warning", f"Command for {verdict.command.get('capability') or verdict.command.get('type')} refused: {verdict.reason}.")
                if verdict.reason == "expired" and verdict.command.get("missionId"):
                    self._report(verdict.command["missionId"], "rejected", reason="The command had already expired when it reached the robot.")
            return
        command = verdict.command
        if command["type"] == "mode":
            return self._take_mode(command, verdict.duplicate)
        if command["type"] == "teleop":
            return self._take_teleop(command, now)
        mission_id = command["missionId"]
        self._record("on_command", command)
        self._apply_link_limit(command.get("limits") or {})
        if command["type"] == "cancel":
            mission = self._missions.get(mission_id)
            if mission is self._active and mission is not None:
                self._abort("Cancelled by HANNAH; holding position.", "cancelled")
            elif mission is not None and mission.final_report:
                self._reports.append(mission.final_report)
            return
        if command["type"] == "pause":
            mission = self._missions.get(mission_id)
            if mission is self._active and mission is not None:
                if mission.status != "paused":
                    self.adapter.hold()
                    mission.status, mission.paused_at, mission.phase = "paused", now, "paused"
                    self._event("mission-paused", "info", f"{mission.capability} paused; holding position.")
                self._report(mission_id, "paused")
            elif mission is not None and mission.final_report:
                self._reports.append(mission.final_report)
            return
        if command["type"] == "resume":
            mission = self._missions.get(mission_id)
            if mission is None or mission is not self._active:
                if mission is not None and mission.final_report:
                    self._reports.append(mission.final_report)
                return
            if mission.status != "paused" or verdict.duplicate:
                self._report(mission_id, "resumed" if mission.status == "accepted" else "paused")
                return
            # Moving again gets the same checks as starting: the robot may not be fit to move any more.
            if mission.capability in ARM:
                decision = self.safety.check(mission.capability, mission.params, self.adapter.state(), busy=False)
            else:
                decision = self.safety.check("navigate_to", {**mission.waypoints[mission.index], "tolerance": mission.params.get("tolerance", 0.25)}, self.adapter.state(), {"maxLinearSpeed": mission.max_speed}, busy=False)
            if self._revoked or self._link_lost or not decision.ok:
                reason = "the link to HANNAH is down" if self._link_lost else "this robot's credentials were refused" if self._revoked else decision.reason
                self._report(mission_id, "resume-refused", reason=f"Refused by the robot's own safety checks: {reason}.")
                return
            mission.deadline += now - mission.paused_at
            mission.status, mission.paused_at = "accepted", 0.0
            self._report(mission_id, "resumed")
            self._start_leg(mission)
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
        if capability in ("report_surroundings", "report_robot_state", "read_sensor", "report_battery_state"):
            self._report(mission_id, "rejected", reason="Reading is answered from the robot's reports; it is not a command.")
            return
        # The operating mode, as this robot holds it: a server that disagrees, or a mode that doesn't take this, is refused.
        if isinstance(command.get("mode"), str) and command["mode"] != self.mode:
            mode_problem = f"the server sent it for {command['mode']} and the robot is in {self.mode}"
        else:
            mode_problem = modes.refusal(self.mode, capability, command.get("origin"))
        if not mode_problem and self._teleop is not None and capability not in modes.STOP | modes.OBSERVE:
            mode_problem = "an operator holds manual control"
        if mode_problem:
            self._report(mission_id, "rejected", reason=f"Refused by the robot's operating mode: {mode_problem}.")
            self._event("command-rejected", "warning", f"{capability} refused: {mode_problem}.")
            return
        decision = self.safety.check(capability, params, state, command.get("limits"), busy=self._active is not None and capability in EXCLUSIVE)
        if decision.ok and capability not in ARM:
            area_problem = self._area_problem(decision.params, command.get("areas") or {})
            if area_problem:
                decision.ok, decision.reason = False, area_problem
        if not decision.ok:
            self._report(mission_id, "rejected", reason=f"Refused by the robot's own safety checks: {decision.reason}.")
            self._event("command-rejected", "warning", f"{capability} refused: {decision.reason}.")
            return
        if capability not in ("stop_motion", "set_supported_device_state", "capture_image"):
            refusal = self._apply_motion_limits(capability, command.get("limits") or {})
            if refusal:
                self._report(mission_id, "rejected", reason=f"Refused by the robot's own safety checks: {refusal}.")
                self._event("command-rejected", "warning", f"{capability} refused: {refusal}.")
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
        elif capability == "capture_image":
            try:
                frame = self.adapter.capture(decision.params["camera"])
                result, attachment = capture_result(frame, self.vision)
                self._event("camera-capture", "info", f"A picture was taken with the {decision.params['camera']} (frame {frame.number}) for mission {mission_id}.")
                self._state = self._compose(self.adapter.state())
                self._finish(mission, "succeeded", result=result, attachment=attachment)
            except Exception as error:  # noqa: BLE001 - no image is a failed capture, never an empty success
                self._finish(mission, "failed", f"No picture was taken: {error}.")
        else:
            mission.waypoints = decision.params.get("waypoints") or [decision.params]
            self._active = mission
            self._start_leg(mission)

    # ---------------- operating modes and manual control ----------------
    def _take_mode(self, command: dict, duplicate: bool) -> None:
        target, seq = command["mode"], int(command["modeSeq"])
        teleop = command.get("teleop") if isinstance(command.get("teleop"), dict) else None
        if duplicate:
            return
        problem = modes.transition_refusal(self.mode, target)
        if not problem and teleop is not None and target not in modes.TELEOP_MODES:
            problem = f"manual control can't be held in {target}"
        if not problem and teleop is not None and (self.adapter.state().get("estop") or {}).get("engaged"):
            problem = "the emergency stop is engaged"
        if problem:
            self._mode_refused = {"seq": seq, "reason": problem}
            self.guard.remember_mode(self.mode, seq)
            self._event("mode-refused", "warning", f"Operating mode {target} refused: {problem}.")
            return
        before = self.mode
        self.mode, self.mode_seq, self._mode_refused = target, seq, None
        self.guard.remember_mode(target, seq)
        # Work the new mode doesn't allow stops now; it is never carried into it.
        mission = self._active
        if target == "safety_stop":
            # Safety Stop through the runtime's own stop: abort, hold, and take nothing but stops and reads until a person moves it out.
            self._abort("Safety Stop; holding position.", "cancelled")
            self.adapter.hold()
        elif mission is not None and modes.refusal(target, mission.capability, "person"):
            self._abort(f"The operating mode changed to {target}; holding position.", "cancelled")
        session = teleop.get("session") if teleop else None
        if self._teleop is not None and (session is None or session != self._teleop["session"]):
            self.adapter.hold()
            self._event("teleop-ended", "info", "Manual control was withdrawn. Holding position.")
            self._teleop = None
        if session and target in modes.TELEOP_MODES and self._teleop is None:
            own = self.safety.limits
            cap_v = [float(own.get("maxLinearSpeed") or 0.0)]
            cap_w = [float(own.get("maxAngularSpeed") or 0.0)]
            for value, caps in ((teleop.get("maxLinearSpeed"), cap_v), (teleop.get("maxAngularSpeed"), cap_w)):
                if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
                    caps.append(float(value))
            if target == "maintenance":
                cap_v.append(modes.MAINTENANCE_SPEED["linear"])
                cap_w.append(modes.MAINTENANCE_SPEED["angular"])
            deadman = teleop.get("deadmanMs")
            deadman_s = min(1.0, max(0.15, float(deadman) / 1000.0)) if isinstance(deadman, (int, float)) and not isinstance(deadman, bool) else 0.5
            self._teleop = {"session": session, "maxLinear": min(cap_v), "maxAngular": min(cap_w), "deadman": deadman_s, "last": 0.0, "seq": 0, "linear": 0.0, "angular": 0.0, "holding": True, "reason": "waiting for the operator", "appliedAt": None, "areas": teleop.get("areas") or {}}
            self.adapter.hold()
            self._event("teleop-started", "warning", f"Manual control taken (session {session}). The robot moves only on fresh operator commands.")
        if target != before:
            self._event("operating-mode", "info", f"Operating mode {before} -> {target}.")

    def _take_teleop(self, command: dict, now: float) -> None:
        teleop = self._teleop
        if teleop is None or command.get("session") != teleop["session"]:
            return  # not the session this robot holds: ignored, and the deadman keeps it still
        state = self.adapter.state()
        problem = ""
        if self.mode not in modes.TELEOP_MODES:
            problem = f"the robot is in {self.mode}"
        elif self._active is not None:
            problem = "an autonomous mission is running"
        elif (state.get("estop") or {}).get("engaged"):
            problem = "the emergency stop is engaged"
        elif state.get("faults"):
            problem = "the robot has an active fault"
        elif state.get("motorsEnabled") is False:
            problem = "the motors are disabled"
        elif self._link_lost or self._revoked:
            problem = "the link to HANNAH is down"
        linear, angular = command.get("linear"), command.get("angular")
        if not problem and (not isinstance(linear, (int, float)) or not isinstance(angular, (int, float)) or isinstance(linear, bool) or isinstance(angular, bool)):
            problem = "the command has no valid speeds"
        if problem:
            self.adapter.hold()
            teleop.update({"holding": True, "reason": problem, "linear": 0.0, "angular": 0.0, "seq": int(command["seq"])})
            return
        v = max(-teleop["maxLinear"], min(teleop["maxLinear"], float(linear)))
        w = max(-teleop["maxAngular"], min(teleop["maxAngular"], float(angular)))
        fence = self._teleop_area_problem(state, v, teleop["areas"])
        if fence:
            v = 0.0
        try:
            applied = self.adapter.teleop_velocity(v, w)
        except NotImplementedError:
            self.adapter.hold()
            teleop.update({"holding": True, "reason": "this robot's adapter has no manual control", "seq": int(command["seq"])})
            return
        v, w = applied if isinstance(applied, tuple) else (v, w)
        teleop.update({"last": now, "seq": int(command["seq"]), "linear": round(v, 3), "angular": round(w, 3), "holding": v == 0.0 and w == 0.0, "reason": fence or "", "appliedAt": int(now * 1000)})

    def _area_problem(self, params: dict, areas: dict) -> str:
        """The safety profile's areas, sent with the command: every goal inside each keep-in area, outside each keep-out one."""
        goals = params.get("waypoints") or ([params] if "x" in params else [])
        for goal in goals:
            x, y = float(goal["x"]), float(goal["y"])
            for zone in areas.get("keepIn") or []:
                if zone.get("polygon") and not point_in_polygon(x, y, zone["polygon"]):
                    return f"({x:.2f}, {y:.2f}) is outside the operating area '{zone.get('name', 'area')}'"
            for zone in areas.get("keepOut") or []:
                if zone.get("polygon") and point_in_polygon(x, y, zone["polygon"]):
                    return f"({x:.2f}, {y:.2f}) is inside the geofence '{zone.get('name', 'zone')}'"
        return ""

    def _teleop_area_problem(self, state: dict, v: float, areas: dict) -> str:
        """Under manual control: no driving out of the operating area or into a geofence. Turning on the spot, and driving back in, are allowed."""
        pose = state.get("pose") or {}
        if not v or not areas or not isinstance(pose.get("x"), (int, float)):
            return ""
        yaw = float(pose.get("yaw") or 0.0)
        x, y = float(pose["x"]), float(pose["y"])
        ax, ay = x + v * 0.5 * math.cos(yaw), y + v * 0.5 * math.sin(yaw)
        for zone in areas.get("keepIn") or []:
            polygon = zone.get("polygon")
            if polygon and point_in_polygon(x, y, polygon) and not point_in_polygon(ax, ay, polygon):
                return f"that would leave the operating area '{zone.get('name', 'area')}'"
        for zone in areas.get("keepOut") or []:
            polygon = zone.get("polygon")
            if polygon and not point_in_polygon(x, y, polygon) and point_in_polygon(ax, ay, polygon):
                return f"that would enter the geofence '{zone.get('name', 'zone')}'"
        return ""

    # Limits a command carries: the owner's, already combined with this robot's own
    # on the server. The robot applies whichever is stricter, and refuses a motion
    # whose lower limit its controller can't apply rather than ignore it.
    MOTION_LIMITS = {"arm": ("maxJointSpeed",), "base": ("maxAngularSpeed", "maxLinearAccel")}

    def _apply_link_limit(self, limits: dict) -> None:
        value = limits.get("linkTimeoutS")
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            self.link_timeout = min(self._own_link_timeout, float(value))

    def _apply_motion_limits(self, capability: str, limits: dict) -> str:
        own = (self.adapter.describe().get("limits") or {}) if not hasattr(self, "_own_limits") else self._own_limits
        self._own_limits = own
        keys = self.MOTION_LIMITS["arm" if capability in ARM else "base"]
        stricter = {}
        for key in keys:
            value = limits.get(key)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
                continue
            mine = own.get(key)
            if not isinstance(mine, (int, float)) or value < float(mine) - 1e-9:
                stricter[key] = float(value)
        unapplied = self.adapter.tighten_limits(stricter)
        if unapplied:
            return "the owner set a lower " + " and ".join(unapplied) + " than this robot's controller can apply"
        return ""

    def _start_leg(self, mission: Mission) -> None:
        goal = mission.waypoints[mission.index]
        mission.phase = {"move_robot_arm": "moving the arm", "grasp_object": "closing the gripper", "release_object": "opening the gripper"}.get(mission.capability) or (f"driving to point {mission.index + 1} of {len(mission.waypoints)}" if len(mission.waypoints) > 1 else "driving")
        try:
            if mission.capability == "move_robot_arm":
                self.adapter.move_arm(goal)
            elif mission.capability == "grasp_object":
                self.adapter.grasp(goal["object"])
            elif mission.capability == "release_object":
                self.adapter.release()
            else:
                self.adapter.navigate(goal, mission.max_speed, mission.params.get("tolerance", 0.25))
        except Exception as error:  # noqa: BLE001 - an adapter that can't take the goal is a failed mission, not a crashed runtime
            self._abort(f"The robot's navigation stack didn't take the goal ({type(error).__name__}).")

    # ---------------- the loop ----------------
    def _compose(self, raw: dict) -> dict:
        mission = self._active
        if raw.get("estop", {}).get("engaged"):
            mode = "estopped"
        elif raw.get("faults"):
            mode = "fault"
        elif self._stopping is not None:
            mode = "stopping"
        elif mission is not None and mission.status == "paused":
            mode = "paused"
        elif mission is not None:
            mode = "manipulating" if mission.capability in ARM else "navigating"
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
            "operatingMode": {"mode": self.mode, "seq": self.mode_seq, "session": self._teleop["session"] if self._teleop else None, **({"refusedSeq": self._mode_refused["seq"], "refusedReason": self._mode_refused["reason"]} if self._mode_refused else {})},
            **({"teleop": {key: self._teleop[key] for key in ("session", "seq", "linear", "angular", "appliedAt", "holding", "reason")}} if self._teleop else {}),
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
                if self._active is not None and self._active.status == "paused":
                    self.adapter.hold()  # already standing still; the paused mission is kept, and only a signed resume restarts it
                else:
                    self._abort(f"The link to HANNAH was lost for more than {self.link_timeout:.0f} s; the robot stopped by itself.", "cancelled")
                    self.adapter.hold()
            if self._teleop is not None and silent > min(self.link_timeout, TELEOP_LINK_TIMEOUT):
                # Under manual control a silent link ends the session at once: the operator can neither see nor steer it.
                self.adapter.hold()
                self._event("teleop-ended", "warning", f"No contact with HANNAH for {silent:.1f} s during manual control. Holding position; the session is over.")
                self._teleop = None
            if silent <= self.link_timeout and self._link_lost:
                self._link_lost = False
                self._event("link-restored", "info", "Contact with HANNAH is back. The robot stays still until it gets a new command.")

            inbox, self._inbox = self._inbox, []
            for item in inbox:
                self._take(item)

            # The deadman: under manual control, nothing fresh from the operator within the deadman time means stand still.
            teleop = self._teleop
            if teleop is not None and not teleop["holding"] and now - teleop["last"] > teleop["deadman"]:
                self.adapter.hold()
                teleop.update({"holding": True, "linear": 0.0, "angular": 0.0, "reason": "no fresh operator command (deadman)"})
                self._event("teleop-deadman", "info", "No fresh operator command: holding position.")

            self._advance(now)
            self._state = self._compose(self.adapter.state())
            self._record("on_state", self._state)

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
        if mission is None or mission.status == "paused":
            return  # a paused mission holds; its time limit doesn't run
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


def run(runtime: Runtime, link: Link, sync_interval: float | None = None, tick_hz: float = 20.0, uploader=None) -> None:
    """Run until interrupted: the control loop here, the server exchanges (and black box uploads) on a second thread."""
    pace = {"seconds": sync_interval or 1.0}

    def exchanges() -> None:
        while runtime.running:
            body = runtime.outbox()
            try:
                sent = int(time.time() * 1000)
                response = link.sync(body)
                runtime.link_ok(response)
                if uploader is not None:
                    uploader.observe(response, sent, int(time.time() * 1000))
                    uploader.maybe_upload(link)
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
        recorder = getattr(runtime.blackbox, "recorder", None)
        if recorder is not None:
            recorder.flush()


def json_logger(stream=sys.stdout):
    def log(event: str, **fields) -> None:
        stream.write(json.dumps({"t": round(time.time(), 3), "event": event, **{key: value for key, value in fields.items() if value not in ("", None)}}) + "\n")
        stream.flush()
    return log


__all__ = ["Mission", "Runtime", "json_logger", "run"]
