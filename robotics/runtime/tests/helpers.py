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


def simulator(**simulation) -> KinematicSimAdapter:
    return KinematicSimAdapter(world(), dict(LIMITS), {"radius": 0.18}, {"seed": 7, "odometryDrift": 0.004, **simulation})


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
