"""What the runtime tells the black box, and how it is turned into records.

The runtime calls three methods and nothing else: on_event (its own events:
emergency stop, faults, link lost, refused commands), on_report (mission
reports it sends to HANNAH) and on_state (its state, every tick). From the
state this records motor, navigation and sensor telemetry, and notices the
changes that matter as events: a sensor that stopped reporting, the planner
giving up, the mode changing.
"""
from __future__ import annotations

from .recorder import Recorder

EVENT_SOURCES = {
    "estop-engaged": "safety", "estop-released": "safety", "fault": "motor", "link-lost": "link", "link-restored": "link", "revoked": "link",
    "command-refused": "mission", "command-rejected": "mission", "mission-paused": "mission", "resume-refused": "mission", "camera-capture": "sensor",
}
REPORTED = {"accepted": "info", "rejected": "warning", "succeeded": "info", "failed": "error", "cancelled": "warning", "timed-out": "error", "paused": "info", "resumed": "info", "resume-refused": "warning"}
NAV_FAILURE = ("No path", "Blocked", "planner", "range sensor", "localization", "Localization")


class RuntimeRecorder:
    def __init__(self, recorder: Recorder):
        self.recorder = recorder
        self._mode = None
        self._sensors_ok: dict[str, bool] = {}
        self._nav_status = None
        self._mission = None
        self._missions: dict[str, dict] = {}

    def on_command(self, command: dict) -> None:
        """A command that passed the signature and sequence checks: the mission as HANNAH issued it."""
        if command.get("type") != "mission":
            return
        self._missions[command["missionId"]] = {"capability": command.get("capability"), "params": command.get("params") or {}}
        self.recorder.event("ai", "mission-issued", "info", f"HANNAH issued {command.get('capability')} (mission {command['missionId']}).", mission=command["missionId"],
                            details={"capability": command.get("capability"), "params": command.get("params") or {}, "seq": command.get("seq"), "expiresAt": command.get("expiresAt"), "limits": command.get("limits") or {}})

    def on_event(self, kind: str, severity: str, message: str, at_ms: int | None = None) -> None:
        self.recorder.event(EVENT_SOURCES.get(kind, "os"), kind, severity, message, at=at_ms, mission=self._mission)

    def on_report(self, report: dict) -> None:
        status = report.get("status")
        if status not in REPORTED:
            return
        mission = report.get("missionId")
        known = self._missions.get(mission, {})
        reason = str(report.get("reason") or "")
        details = {"status": status, "capability": known.get("capability"), "params": known.get("params"), "reason": reason or None}
        result = report.get("result") if isinstance(report.get("result"), dict) else None
        if result:
            details["final"] = result.get("final")
            details["durationS"] = result.get("durationS")
        text = f"Mission {mission} {status}" + (f": {reason}" if reason else ".")
        self.recorder.event("mission", f"mission-{status}", REPORTED[status], text, at=report.get("at"), mission=mission, details=details)
        if status in ("failed", "timed-out") and any(word in reason for word in NAV_FAILURE):
            self.recorder.event("navigation", "nav-failed", "error", f"Navigation gave up: {reason}", at=report.get("at"), mission=mission, details={"reason": reason, "goal": known.get("params")})

    def on_state(self, state: dict) -> None:
        at = state.get("at")
        mission = (state.get("mission") or {}).get("id")
        self._mission = mission
        velocity = state.get("velocity") or {}
        estop = state.get("estop") or {}
        self.recorder.record("motor/state", {"linear": velocity.get("linear"), "angular": velocity.get("angular"), "motorsEnabled": state.get("motorsEnabled"),
                                             "estop": bool(estop.get("engaged")), "faults": [fault.get("code") for fault in state.get("faults") or []]}, at=at, mission=mission)
        pose = state.get("pose") or {}
        if pose:
            self.recorder.record("nav/pose", {key: pose.get(key) for key in ("x", "y", "yaw", "frame", "source")}, at=at, mission=mission)
        nav = state.get("nav") or {}
        mission_state = state.get("mission") or {}
        self.recorder.record("nav/status", {"status": nav.get("status"), "goal": nav.get("goal"), "mode": state.get("mode"), "phase": mission_state.get("phase"),
                                            "distanceRemaining": mission_state.get("distanceRemaining"), "localized": state.get("localized")}, at=at, mission=mission)
        battery = state.get("battery")
        link = state.get("link") or {}
        if link:
            self.recorder.record("os/link", {"ok": link.get("ok"), "silentS": link.get("silentS"), "timeoutS": link.get("timeoutS")}, at=at)
        for sensor, reading in (state.get("sensors") or {}).items():
            if not isinstance(reading, dict):
                continue
            self.recorder.record(f"sensors/{sensor}", reading, at=at, device=sensor, mission=mission)
            ok = reading.get("ok") is not False
            if self._sensors_ok.get(sensor, True) and not ok:
                self.recorder.event("sensor", "sensor-lost", "error" if sensor in ("lidar", "odometry", "imu") else "warning", f"The {sensor} sensor stopped reporting ({reading.get('problem') or 'no reason given'}).", at=at, mission=mission, device=sensor)
            elif not self._sensors_ok.get(sensor, True) and ok:
                self.recorder.event("sensor", "sensor-restored", "info", f"The {sensor} sensor is reporting again.", at=at, mission=mission, device=sensor)
            self._sensors_ok[sensor] = ok
        if isinstance(battery, dict):
            self.recorder.record("sensors/battery-state", {"percent": battery.get("percent"), "charging": battery.get("charging")}, at=at)
        perception = state.get("perception") or {}
        unmapped = [item for item in perception.get("obstacles") or [] if isinstance(item, dict) and item.get("kind") == "object not on the map"]
        if unmapped:
            self.recorder.record("sensors/obstacles", {"source": perception.get("source"), "objects": [{key: item.get(key) for key in ("x", "y", "widthM", "distanceM", "bearingDeg", "confidence")} for item in unmapped[:8]]}, at=at, mission=mission)
        if perception.get("route", {}).get("blocked") and self._nav_status == "active":
            self.recorder.record("nav/costmap", {"blocked": True, "reason": perception["route"].get("reason"), "obstacles": len(perception.get("obstacles") or [])}, at=at, mission=mission)
        status = nav.get("status")
        if status != self._nav_status:
            if status == "failed" and self._nav_status == "active":
                self.recorder.event("navigation", "nav-goal-failed", "warning", "The planner reports the goal failed.", at=at, mission=mission, details={"goal": nav.get("goal")})
            self._nav_status = status
        mode = state.get("mode")
        if mode != self._mode:
            if self._mode is not None:
                severity = "error" if mode in ("estopped", "fault") else "info"
                self.recorder.event("os", "mode-changed", severity, f"Mode changed from {self._mode} to {mode}.", at=at, mission=mission, details={"from": self._mode, "to": mode})
            self._mode = mode


__all__ = ["RuntimeRecorder"]
