"""Shared pieces for the runtime's tests: a world, a signed-command maker and a runtime on a hand-driven clock."""
from __future__ import annotations

import base64
import json
import os

from hannah_robot.hal.kinematic import KinematicSimAdapter
from hannah_robot.profile import local_safety
from hannah_robot.protocol import CommandGuard, sign_command
from hannah_robot.runtime import Runtime

HERE = os.path.dirname(os.path.abspath(__file__))
WORLD_PATH = os.path.normpath(os.path.join(HERE, "..", "..", "worlds", "workcell.json"))
SECRET = base64.urlsafe_b64encode(bytes([7]) * 32).decode().rstrip("=")
ROBOT_ID = "rb_000000000000000001"
LIMITS = {"maxLinearSpeed": 0.5, "maxAngularSpeed": 1.6, "maxLinearAccel": 0.8, "maxAngularAccel": 3.0, "minBatteryPercent": 15, "linkTimeoutS": 5, "commandTtlS": 20}


def world() -> dict:
    with open(WORLD_PATH, "r", encoding="utf-8") as handle:
        return json.load(handle)


def simulator(world_name: str = "workcell", **simulation) -> KinematicSimAdapter:
    with open(os.path.join(os.path.dirname(WORLD_PATH), f"{world_name}.json"), "r", encoding="utf-8") as handle:
        return KinematicSimAdapter(json.load(handle), dict(LIMITS), {"radius": 0.18}, {"seed": 7, "odometryDrift": 0.004, **simulation})


class Bench:
    """A runtime and a simulated robot on a clock the test moves. No network: the test plays the server."""

    def __init__(self, **simulation):
        self.now = 1_800_000_000.0
        self.sim = simulator(**simulation)
        self.guard = CommandGuard(SECRET, ROBOT_ID)
        self.runtime = Runtime(self.sim, self.guard, local_safety(self.sim), link_timeout=5.0, clock=lambda: self.now)
        self.seq = 0
        self.sent: list[dict] = []

    def command(self, capability: str, params: dict | None = None, *, mission: str | None = None, ttl: float = 20.0, timeout: float = 180.0, robot: str = ROBOT_ID, secret: str = SECRET, seq: int | None = None, limits: dict | None = None, issued: float | None = None) -> dict:
        self.seq += 1
        issued_ms = int((self.now if issued is None else issued) * 1000)
        body = {"v": 1, "type": "mission", "robotId": robot, "missionId": mission or f"ms_{self.seq:04d}", "seq": self.seq if seq is None else seq, "nonce": f"{self.seq:032x}", "capability": capability, "params": params or {}, "issuedAt": issued_ms, "expiresAt": issued_ms + int(ttl * 1000), "timeoutS": timeout, "limits": limits or {}}
        payload = json.dumps(body)
        return {"payload": payload, "sig": sign_command(secret, payload), "missionId": body["missionId"]}

    def cancel(self, mission: str) -> dict:
        payload = json.dumps({"v": 1, "type": "cancel", "robotId": ROBOT_ID, "missionId": mission, "issuedAt": int(self.now * 1000)})
        return {"payload": payload, "sig": sign_command(SECRET, payload)}

    def pause(self, mission: str) -> dict:
        payload = json.dumps({"v": 1, "type": "pause", "robotId": ROBOT_ID, "missionId": mission, "issuedAt": int(self.now * 1000)})
        return {"payload": payload, "sig": sign_command(SECRET, payload)}

    def resume(self, mission: str, nonce: str = "", ttl: float = 20.0) -> dict:
        self.seq += 1
        payload = json.dumps({"v": 1, "type": "resume", "robotId": ROBOT_ID, "missionId": mission, "nonce": nonce or f"resume-{self.seq}", "issuedAt": int(self.now * 1000), "expiresAt": int((self.now + ttl) * 1000)})
        return {"payload": payload, "sig": sign_command(SECRET, payload)}

    def mode(self, mode: str, *, seq: int | None = None, session: str | None = None, deadman_ms: int = 500, max_linear: float | None = None, areas: dict | None = None) -> dict:
        """A signed operating-mode command, as the server sends it; with a session, manual control is handed over."""
        self.seq += 1
        teleop = {"session": session, "deadmanMs": deadman_ms, "maxLinearSpeed": max_linear, "maxAngularSpeed": None, **({"areas": areas} if areas else {})} if session else None
        payload = json.dumps({"v": 1, "type": "mode", "robotId": ROBOT_ID, "mode": mode, "modeSeq": self.seq if seq is None else seq, "issuedAt": int(self.now * 1000), "teleop": teleop})
        return {"payload": payload, "sig": sign_command(SECRET, payload)}

    def teleop(self, session: str, seq: int, linear: float, angular: float = 0.0, ttl_ms: int = 400) -> dict:
        """A signed manual-control command: a speed, a number that only goes up, a short life."""
        issued = int(self.now * 1000)
        payload = json.dumps({"v": 1, "type": "teleop", "robotId": ROBOT_ID, "session": session, "seq": seq, "linear": linear, "angular": angular, "issuedAt": issued, "expiresAt": issued + ttl_ms})
        return {"payload": payload, "sig": sign_command(SECRET, payload)}

    def exchange(self, *commands: dict) -> dict:
        """One exchange with the server: take what the robot has to say, hand it commands."""
        body = self.runtime.outbox()
        self.sent.append(body)
        self.runtime.link_ok({"commands": list(commands)})
        return body

    def run(self, seconds: float, *, linked: bool = True, until=None) -> None:
        """Let time pass, with an exchange every second while the link is up."""
        elapsed, since = 0.0, 0.0
        while elapsed < seconds:
            self.now += 0.05
            elapsed += 0.05
            since += 0.05
            self.runtime.tick(0.05)
            if linked and since >= 1.0:
                since = 0.0
                self.exchange()
            if until is not None and until():
                return

    def reports(self, mission: str | None = None) -> list[dict]:
        pending = self.runtime.outbox()
        self.runtime.requeue(pending)
        everything = [report for body in self.sent for report in body["reports"]] + pending["reports"]
        return [report for report in everything if mission is None or report["missionId"] == mission]

    def statuses(self, mission: str) -> list[str]:
        return [report["status"] for report in self.reports(mission) if report["status"] != "progress"]

    def events(self) -> list[str]:
        pending = self.runtime.outbox()
        self.runtime.requeue(pending)
        return [event["type"] for body in self.sent for event in body["events"]] + [event["type"] for event in pending["events"]]

    def state(self) -> dict:
        body = self.runtime.outbox()
        self.runtime.requeue(body)
        return body["state"]
