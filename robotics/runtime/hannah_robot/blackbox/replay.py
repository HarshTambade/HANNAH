"""Replaying a recording: a mission's timeline, playback, fault reproduction and regression scenarios.

  load_recording(directory)        every segment, records oldest first
  mission_timeline(records, id)    what happened during one mission, in order
  PlaybackAdapter(records)         a RobotAdapter that replays recorded state into the runtime.
                                   It is always labelled playback: describe() says simulation
                                   kind "playback", every state carries playback.live = False,
                                   and it moves nothing (every goal fails at once).
  scenario_from_recording(...)     a scenario file (robotics/scenarios format) that drives HANNAH's
                                   built-in simulator through what was recorded: the goal, the
                                   objects the range sensor reported, sensors that stopped, the
                                   emergency stop, expecting the outcome that was recorded.
  reproduce(...)                   runs that scenario and says whether the simulator reproduced it.

Reproducing in the built-in simulator shows the same inputs give the same
outcome in a 2-D kinematic model. It is not a reproduction on the robot.
"""
from __future__ import annotations

import os
import re

from ..hal.base import NavigationStatus, RobotAdapter
from .format import FormatError, is_segment, read_segment

PLAYBACK_NOTE = "Recorded data played back. Not live, not a simulation of new motion: nothing moves."
STOPPING = ("mission-failed", "mission-cancelled", "mission-timed-out", "estop-engaged", "fault", "link-lost", "nav-failed", "sensor-lost")


def load_recording(directory: str, *, include_sensitive: bool = False) -> dict:
    segments, records, problems = [], [], []
    root = os.path.join(directory, "segments") if os.path.isdir(os.path.join(directory, "segments")) else directory
    simulated = None
    robot = None
    for folder, _dirs, files in os.walk(root):
        for name in sorted(files):
            if not is_segment(name):
                continue
            path = os.path.join(folder, name)
            try:
                header, items, info = read_segment(path)
            except (OSError, FormatError) as error:
                problems.append({"path": path, "problem": str(error)})
                continue
            if header.get("sensitivity") == "sensitive" and not include_sensitive:
                continue
            simulated = bool(header.get("simulated")) if simulated is None else simulated or bool(header.get("simulated"))
            robot = robot or header.get("robotId")
            segments.append({"id": header["segment"], "stream": header.get("stream"), "verified": info["verified"], "closed": info["closed"], "records": len(items)})
            for item in items:
                records.append({**item, "segment": header["segment"]})
    records.sort(key=lambda item: (int(item.get("t") or 0), int(item.get("seq") or 0)))
    return {"robotId": robot, "simulated": bool(simulated), "segments": segments, "records": records, "problems": problems}


def events_of(records) -> list[dict]:
    return [item for item in records if item.get("kind") == "event"]


def mission_timeline(records, mission_id: str, before_ms: int = 30_000, after_ms: int = 10_000) -> dict:
    """The mission's own records, and every event from a little before it started until a little after it ended."""
    own = [item for item in records if item.get("mission") == mission_id]
    if not own:
        return {"missionId": mission_id, "found": False, "events": [], "track": []}
    start, end = int(own[0]["t"]), int(own[-1]["t"])
    window = [item for item in records if start - before_ms <= int(item.get("t") or 0) <= end + after_ms]
    events = [{"id": item.get("id"), "t": item["t"], "topic": item["topic"], "severity": item.get("sev"), "mission": item.get("mission"), "device": item.get("device"), **(item.get("data") or {})} for item in events_of(window)]
    track = [{"t": item["t"], **(item.get("data") or {})} for item in own if item.get("topic") == "nav/pose"]
    outcome = next((event for event in reversed(events) if event.get("mission") == mission_id and str(event.get("type", "")).startswith("mission-") and event["type"] not in ("mission-issued", "mission-accepted", "mission-paused", "mission-resumed")), None)
    return {"missionId": mission_id, "found": True, "startMs": start, "endMs": end, "events": events, "track": track, "outcome": outcome}


class PlaybackAdapter(RobotAdapter):
    """Recorded state, played back. Never live and never moving."""

    name = "playback"

    def __init__(self, records, *, speed: float = 1.0, world: dict | None = None, robot_type: str = "differential-drive"):
        self.records = [item for item in records if item.get("kind") == "telemetry"]
        self.events = events_of(records)
        if not self.records:
            raise ValueError("there is no recorded telemetry to play back")
        self.speed = float(speed)
        self.world = world
        self.robot_type = robot_type
        self.start_ms = int(self.records[0]["t"])
        self.end_ms = int(self.records[-1]["t"])
        self.position_ms = self.start_ms
        self._index = 0
        self._latest: dict[str, dict] = {}

    @property
    def finished(self) -> bool:
        return self.position_ms >= self.end_ms

    def step(self, wall_dt: float) -> None:
        self.position_ms = min(self.end_ms, self.position_ms + int(wall_dt * 1000 * self.speed))
        while self._index < len(self.records) and int(self.records[self._index]["t"]) <= self.position_ms:
            item = self.records[self._index]
            self._latest[item["topic"]] = item.get("data") or {}
            self._index += 1

    def seek(self, at_ms: int) -> None:
        self.position_ms, self._index, self._latest = self.start_ms, 0, {}
        self.step((int(at_ms) - self.start_ms) / 1000.0 / self.speed)

    def describe(self) -> dict:
        world = self.world or {}
        return {"robotType": self.robot_type, "protocols": ["hannah-robot-v1"], "sensors": [], "actuators": [], "devices": [], "capabilities": ["report_robot_state", "read_sensor"],
                "places": world.get("places", {}), "dock": world.get("dock"), "world": {"name": f"{world.get('name', 'recording')} (playback)", "bounds": world.get("bounds"), "obstacles": world.get("obstacles", [])} if world else None,
                "limits": {"maxLinearSpeed": 0.0, "environment": "simulation", "estop": {"hardware": False, "description": "Playback: there is no emergency stop to press."}},
                "simulation": {"kind": "playback", "note": PLAYBACK_NOTE}}

    def state(self) -> dict:
        motor = self._latest.get("motor/state", {})
        pose = self._latest.get("nav/pose")
        sensors = {topic.split("/", 1)[1]: dict(value) for topic, value in self._latest.items() if topic.startswith("sensors/") and topic != "sensors/battery-state"}
        battery = self._latest.get("sensors/battery-state")
        return {
            "pose": dict(pose) if pose else None,
            "velocity": {"linear": motor.get("linear") or 0.0, "angular": motor.get("angular") or 0.0},
            "battery": dict(battery) if battery else None,
            "estop": {"engaged": bool(motor.get("estop")), "source": "playback"},
            "motorsEnabled": False,
            "localized": (self._latest.get("nav/status") or {}).get("localized"),
            "faults": [{"code": code, "message": f"recorded fault {code}"} for code in motor.get("faults") or []],
            "sensors": sensors,
            "nav": {"status": (self._latest.get("nav/status") or {}).get("status"), "goal": (self._latest.get("nav/status") or {}).get("goal"), "path": []},
            "playback": {"live": False, "recordedAt": self.position_ms, "startMs": self.start_ms, "endMs": self.end_ms, "note": PLAYBACK_NOTE},
            "sim": {"kind": "playback"},
        }

    def navigate(self, goal: dict, max_speed: float, tolerance: float) -> None:
        self._nav = NavigationStatus("failed", "Playback can't move the robot.")

    def navigation_status(self) -> NavigationStatus:
        return getattr(self, "_nav", NavigationStatus())

    def cancel_navigation(self) -> None:
        self._nav = NavigationStatus("cancelled", "Playback.")

    def hold(self) -> None:
        pass


def _goal_of(details: dict, world: dict | None):
    params = (details or {}).get("params") or {}
    capability = (details or {}).get("capability")
    if capability == "return_to_dock" and world and world.get("dock"):
        return {"x": world["dock"]["x"], "y": world["dock"]["y"]}
    if capability in ("navigate_to", "return_to_dock") and isinstance(params.get("x"), (int, float)) and isinstance(params.get("y"), (int, float)):
        return {"x": params["x"], "y": params["y"]}
    return None


def scenario_from_recording(records, mission_id: str, *, world_ref: str = "../worlds/home.json", world: dict | None = None, name: str | None = None, recorded_on: str = "unknown") -> dict:
    """A regression scenario from one recorded mission. Raises ValueError when the mission can't be expressed as one."""
    timeline = mission_timeline(records, mission_id)
    if not timeline["found"]:
        raise ValueError(f"the recording has nothing for mission {mission_id}")
    issued = next((event for event in timeline["events"] if event.get("type") == "mission-issued" and event.get("mission") == mission_id), None)
    if issued is None:
        raise ValueError("the recording doesn't hold the mission as it was issued (its goal is unknown)")
    goal = _goal_of(issued.get("details") or {}, world)
    if goal is None:
        raise ValueError(f"only drive missions can become a simulator scenario; this one was {(issued.get('details') or {}).get('capability')}")
    started = next((event["t"] for event in timeline["events"] if event.get("type") == "mission-accepted" and event.get("mission") == mission_id), issued["t"])
    outcome = timeline["outcome"]
    expect = (outcome or {}).get("details", {}).get("status") or "succeeded"
    reason = (outcome or {}).get("details", {}).get("reason") or ""
    during, faults, not_reproducible = [], set(), []
    for event in timeline["events"]:
        after = round(max(0.0, (int(event["t"]) - int(started)) / 1000.0), 2)
        if int(event["t"]) < int(started) or (outcome and int(event["t"]) > int(outcome["t"])):
            continue
        if event.get("type") == "sensor-lost" and event.get("device"):
            faults.add(event["device"])
            during.append({"after": after, "sensorFaults": sorted(faults), "recordedEvent": event.get("id")})
        elif event.get("type") == "sensor-restored" and event.get("device"):
            faults.discard(event["device"])
            during.append({"after": after, "sensorFaults": sorted(faults), "recordedEvent": event.get("id")})
        elif event.get("type") == "estop-engaged":
            during.append({"after": after, "estop": True, "recordedEvent": event.get("id")})
        elif event.get("type") == "link-lost":
            not_reproducible.append({"event": event.get("id"), "what": "the link to HANNAH was lost: the built-in simulator's scenarios have no network"})
        elif event.get("type") == "fault":
            not_reproducible.append({"event": event.get("id"), "what": f"a robot fault ({event.get('summary')}): the simulator only faults on collision"})
    seen: list[dict] = []
    for item in records:
        if item.get("topic") != "sensors/obstacles" or item.get("mission") != mission_id:
            continue
        for found in (item.get("data") or {}).get("objects") or []:
            if not all(isinstance(found.get(key), (int, float)) for key in ("x", "y")):
                continue
            if any(abs(found["x"] - other["x"]) < 0.3 and abs(found["y"] - other["y"]) < 0.3 for other in seen):
                continue
            size = max(0.2, float(found.get("widthM") or 0.3))
            seen.append({"name": "object the range sensor reported", "x": float(found["x"]), "y": float(found["y"]), "w": round(size, 2), "h": round(size, 2)})
    if expect not in ("succeeded", "failed", "cancelled", "timed-out"):
        raise ValueError(f"the recorded outcome {expect!r} isn't one the simulator can check")
    if any(item["what"].startswith("the link") for item in not_reproducible) and expect == "cancelled":
        raise ValueError("the mission ended because the link was lost, which the built-in simulator can't reproduce")
    step = {"navigate": goal, "expect": expect, "timeout": 240}
    if reason and expect != "succeeded":
        step["reason"] = re.escape(reason[:60])
    if during:
        step["during"] = during
    return {
        "name": name or f"recorded-{mission_id}",
        "description": f"Generated from a black box recording of mission {mission_id}: the same goal, the objects the range sensor reported and the sensor and emergency-stop changes that were recorded, expecting the recorded outcome ({expect}).",
        "world": world_ref,
        "steps": [*({"obstacle": rect} for rect in seen[:8]), step],
        "expect": {},
        "source": {"kind": "blackbox-recording", "missionId": mission_id, "recordedAt": int(started), "recordedOn": recorded_on,
                   "notReproducible": not_reproducible, "note": "Runs in HANNAH's built-in simulator only. Passing it is not a test on the robot."},
    }


def reproduce(records, mission_id: str, *, world_ref: str, base_dir: str, world: dict | None = None, recorded_on: str = "unknown") -> dict:
    from ..scenarios import run_scenario_data

    scenario = scenario_from_recording(records, mission_id, world_ref=world_ref, world=world, recorded_on=recorded_on)
    result = run_scenario_data(scenario, base_dir)
    recorded = scenario["steps"][-1]["expect"]
    got = result["log"][-1]["result"] if result["log"] else None
    return {"scenario": scenario, "result": result, "recorded": recorded, "reproduced": got, "same": got == recorded, "simulator": "hannah-kinematic",
            "note": "Reproduced in the built-in 2-D simulator, not on the robot."}


__all__ = ["PLAYBACK_NOTE", "PlaybackAdapter", "events_of", "load_recording", "mission_timeline", "reproduce", "scenario_from_recording"]
