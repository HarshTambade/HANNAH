"""Scenario regression for HANNAH's built-in simulator.

A scenario is a small JSON file: a world, steps (drive somewhere, put an
obstacle down, take a sensor away) and what must be true afterwards. Each run
starts from a fresh simulator, so a scenario gives the same result every time
and can guard against regressions in the navigator.

    python3 -m hannah_robot.scenarios                 # every scenario in robotics/scenarios
    python3 -m hannah_robot.scenarios path/to/one.json

This runs HANNAH's built-in kinematic simulator. It says nothing about Gazebo
or a physical robot.
"""
from __future__ import annotations

import glob
import json
import math
import os
import re
import sys

from .geometry import distance_to_rect
from .hal.kinematic import DT, KinematicSimAdapter

DEFAULT_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "scenarios"))
LIMITS = {"maxLinearSpeed": 0.5, "maxAngularSpeed": 1.6, "maxLinearAccel": 0.8, "maxAngularAccel": 3.0}


def _apply(sim: KinematicSimAdapter, action: dict) -> None:
    if "obstacle" in action:
        sim.place_obstacle(action["obstacle"])
    if action.get("clearObstacles"):
        sim.clear_obstacles()
    if "sensorFaults" in action:
        sim.sensor_faults = set(action["sensorFaults"])
    if "estop" in action:
        sim.press_estop(bool(action["estop"]))
    if "wait" in action:
        sim.advance(float(action["wait"]))


def run_scenario(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        scenario = json.load(handle)
    world_path = scenario["world"] if os.path.isabs(scenario["world"]) else os.path.join(os.path.dirname(os.path.abspath(path)), scenario["world"])
    with open(world_path, "r", encoding="utf-8") as handle:
        world = json.load(handle)
    sim = KinematicSimAdapter(world, dict(LIMITS, **scenario.get("limits", {})), {"radius": 0.18}, {"seed": scenario.get("seed", 7), "odometryDrift": scenario.get("odometryDrift", 0.004)})
    problems, log = [], []
    closest = math.inf
    for index, step in enumerate(scenario["steps"], start=1):
        if "navigate" not in step:
            _apply(sim, step)
            continue
        goal = world["places"].get(step["navigate"]) if isinstance(step["navigate"], str) else step["navigate"]
        if goal is None:
            problems.append(f"step {index}: the world has no place called {step['navigate']!r}")
            continue
        pending = sorted(step.get("during", []), key=lambda item: item["after"])
        sim.navigate(goal, float(step.get("maxSpeed", LIMITS["maxLinearSpeed"])), float(step.get("tolerance", 0.25)))
        elapsed, limit = 0.0, float(step.get("timeout", 180))
        while sim.navigation_status().state == "active" and elapsed < limit:
            while pending and pending[0]["after"] <= elapsed:
                _apply(sim, pending.pop(0))
            sim.advance(DT)
            elapsed += DT
            for rect in sim.static + sim.dynamic:
                closest = min(closest, distance_to_rect(sim.x, sim.y, rect))
        sim.advance(2.0)  # let it brake
        status = sim.navigation_status()
        state = "timed-out" if status.state == "active" else status.state
        distance = math.hypot(sim.x - goal["x"], sim.y - goal["y"])
        log.append({"step": index, "to": step["navigate"], "result": state, "reason": status.reason, "seconds": round(elapsed, 1), "trueDistanceToGoal": round(distance, 3)})
        if state != step.get("expect", "succeeded"):
            problems.append(f"step {index}: expected {step.get('expect', 'succeeded')}, got {state} ({status.reason or 'no reason'})")
        elif state == "succeeded" and distance > float(step.get("tolerance", 0.25)):
            problems.append(f"step {index}: reported success {distance:.2f} m from the goal")
        if step.get("reason") and state != "succeeded" and not re.search(step["reason"], status.reason or ""):
            problems.append(f"step {index}: the reason {status.reason!r} doesn't match {step['reason']!r}")
        if abs(sim.v) > 1e-6:
            problems.append(f"step {index}: the robot is still moving after the step ended")
    final = sim.state()
    expect = scenario.get("expect", {})
    if "faults" in expect and len(final["faults"]) != expect["faults"]:
        problems.append(f"expected {expect['faults']} faults, found {[fault['code'] for fault in final['faults']]}")
    if "maxOdometryError" in expect and final["sim"]["odometryError"] > expect["maxOdometryError"]:
        problems.append(f"odometry is {final['sim']['odometryError']} m from the truth; the limit is {expect['maxOdometryError']}")
    if expect.get("discovered") and not final["map"]["discovered"]:
        problems.append("the range sensor should have put the unexpected object on the map")
    # Always: the robot never touches anything.
    if closest < sim.radius - 1e-6:
        problems.append(f"the robot came within {closest:.3f} m of an obstacle, closer than its {sim.radius} m radius")
    return {"name": scenario["name"], "description": scenario.get("description", ""), "passed": not problems, "problems": problems, "log": log, "closestApproachM": None if closest == math.inf else round(closest, 3), "simulatedSeconds": round(sim.sim_time, 1), "simulator": "hannah-kinematic"}


def main(argv=None) -> int:
    targets = (argv if argv is not None else sys.argv[1:]) or sorted(glob.glob(os.path.join(DEFAULT_DIR, "*.json")))
    failed = 0
    for path in targets:
        result = run_scenario(path)
        failed += 0 if result["passed"] else 1
        print(f"{'PASS' if result['passed'] else 'FAIL'}  {result['name']:24s} {result['simulatedSeconds']:7.1f} s simulated  " + "; ".join(f"{item['to']}: {item['result']}" for item in result["log"]))
        for problem in result["problems"]:
            print(f"      {problem}")
    print(f"{len(targets) - failed} of {len(targets)} scenarios passed (built-in simulator; not Gazebo, not hardware)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
