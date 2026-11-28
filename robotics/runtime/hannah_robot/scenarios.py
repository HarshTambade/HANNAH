"""Scenario regression for HANNAH's built-in simulator.

A scenario is a small JSON file: a world, steps (drive somewhere, put an
obstacle down, take a sensor away) and what must be true afterwards. Each run
starts from a fresh simulator, so a scenario gives the same result every time
and can guard against regressions in the navigator.

    python3 -m hannah_robot.scenarios                 # every scenario in robotics/scenarios
    python3 -m hannah_robot.scenarios path/to/one.json
    python3 -m hannah_robot.scenarios --json --profile ../profiles/sim-diffdrive.json \
        --overrides '{"limits": {"maxLinearSpeed": 0.4}}'

With --profile the robot's limits, footprint and odometry drift come from that
profile (a scenario may still set its own limits on top), and --overrides
changes them again, which is how a configuration change is tried before it
goes anywhere near a robot. --json prints one machine-readable report with
the metrics a regression suite compares: trips completed, how the robot
moved, how reliably navigation did what was expected, faults and errors, and
the resources the run used.

This runs HANNAH's built-in kinematic simulator. It says nothing about Gazebo
or a physical robot, and every report says so.
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import re
import sys
import time

try:  # not on every platform
    import resource
except ImportError:  # pragma: no cover
    resource = None

from .geometry import distance_to_rect
from .hal.kinematic import DT, KinematicSimAdapter

DEFAULT_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "scenarios"))
LIMITS = {"maxLinearSpeed": 0.5, "maxAngularSpeed": 1.6, "maxLinearAccel": 0.8, "maxAngularAccel": 3.0}
ROBOT = {"radius": 0.18}
SIMULATION = {"seed": 7, "odometryDrift": 0.004}
SIMULATOR = "hannah-kinematic"
ENVIRONMENT = "simulation (HANNAH's built-in kinematic simulator; not Gazebo, not hardware)"
# What a profile or an override may change. Anything else in overrides is refused, so a typo can't pass unnoticed.
TUNABLE = {
    "limits": ("maxLinearSpeed", "maxAngularSpeed", "maxLinearAccel", "maxAngularAccel"),
    "robot": ("radius",),
    "simulation": ("seed", "odometryDrift"),
}


class ScenarioConfigError(ValueError):
    pass


def sim_config(profile: dict | None = None, overrides: dict | None = None) -> dict:
    """The simulator settings a run uses: the defaults, then the profile, then the overrides."""
    config = {"limits": dict(LIMITS), "robot": dict(ROBOT), "simulation": dict(SIMULATION)}
    for source_name, source in (("profile", profile or {}), ("overrides", overrides or {})):
        if source_name == "profile" and source and source.get("adapter") not in (None, "kinematic"):
            raise ScenarioConfigError(f"the scenario runner drives the differential-drive simulator only; this profile uses the {source.get('adapter')!r} adapter")
        for section, keys in TUNABLE.items():
            values = source.get(section) or {}
            if not isinstance(values, dict):
                raise ScenarioConfigError(f"{source_name}.{section} must be an object")
            for key, value in values.items():
                if key not in keys:
                    if source_name == "overrides":
                        raise ScenarioConfigError(f"overrides.{section}.{key} isn't something the simulator can change")
                    continue
                positive = section != "simulation"  # a seed or a drift may be 0; a limit or a radius may not
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 or (positive and value == 0):
                    raise ScenarioConfigError(f"{source_name}.{section}.{key} must be a {'positive' if positive else 'non-negative'} number")
                config[section][key] = value
        if source_name == "overrides":
            unknown = sorted(set(source) - set(TUNABLE))
            if unknown:
                raise ScenarioConfigError(f"overrides can change {', '.join(TUNABLE)}; not {', '.join(unknown)}")
    return config


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


def run_scenario(path: str, config: dict | None = None) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        scenario = json.load(handle)
    return run_scenario_data(scenario, os.path.dirname(os.path.abspath(path)), config)


def run_scenario_data(scenario: dict, base_dir: str = DEFAULT_DIR, config: dict | None = None) -> dict:
    """Run a scenario given as data; a relative world path is taken from base_dir."""
    config = config or sim_config()
    started, cpu_started = time.perf_counter(), time.process_time()
    world_path = scenario["world"] if os.path.isabs(scenario["world"]) else os.path.join(base_dir, scenario["world"])
    with open(world_path, "r", encoding="utf-8") as handle:
        world = json.load(handle)
    limits = dict(config["limits"], **scenario.get("limits", {}))
    simulation = {"seed": scenario.get("seed", config["simulation"]["seed"]), "odometryDrift": scenario.get("odometryDrift", config["simulation"]["odometryDrift"])}
    sim = KinematicSimAdapter(world, limits, dict(config["robot"]), simulation)
    problems, log = [], []
    closest = math.inf
    motion = {"maxLinearSpeed": 0.0, "maxAngularSpeed": 0.0, "maxLinearAccel": 0.0}
    last_v = 0.0
    for index, step in enumerate(scenario["steps"], start=1):
        if "navigate" not in step:
            _apply(sim, step)
            continue
        goal = world["places"].get(step["navigate"]) if isinstance(step["navigate"], str) else step["navigate"]
        if goal is None:
            problems.append(f"step {index}: the world has no place called {step['navigate']!r}")
            continue
        pending = sorted(step.get("during", []), key=lambda item: item["after"])
        sim.navigate(goal, float(step.get("maxSpeed", limits["maxLinearSpeed"])), float(step.get("tolerance", 0.25)))
        elapsed, limit = 0.0, float(step.get("timeout", 180))
        while sim.navigation_status().state == "active" and elapsed < limit:
            while pending and pending[0]["after"] <= elapsed:
                _apply(sim, pending.pop(0))
            sim.advance(DT)
            elapsed += DT
            motion["maxLinearSpeed"] = max(motion["maxLinearSpeed"], abs(sim.v))
            motion["maxAngularSpeed"] = max(motion["maxAngularSpeed"], abs(sim.w))
            motion["maxLinearAccel"] = max(motion["maxLinearAccel"], abs(sim.v - last_v) / DT)
            last_v = sim.v
            for rect in sim.static + sim.dynamic:
                closest = min(closest, distance_to_rect(sim.x, sim.y, rect))
        sim.advance(2.0)  # let it brake
        status = sim.navigation_status()
        state = "timed-out" if status.state == "active" else status.state
        distance = math.hypot(sim.x - goal["x"], sim.y - goal["y"])
        last_v = sim.v
        log.append({"step": index, "to": step["navigate"], "expected": step.get("expect", "succeeded"), "result": state, "reason": status.reason, "seconds": round(elapsed, 1), "trueDistanceToGoal": round(distance, 3)})
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
    metrics = {
        "trips": len(log),
        "tripsSucceeded": sum(1 for item in log if item["result"] == "succeeded"),
        "tripsAsExpected": sum(1 for item in log if item["result"] == item["expected"]),
        "timeouts": sum(1 for item in log if item["result"] == "timed-out"),
        "faults": len(final["faults"]),
        "problems": len(problems),
        "distanceM": round(sim.travelled, 3),
        "maxLinearSpeed": round(motion["maxLinearSpeed"], 3),
        "maxAngularSpeed": round(motion["maxAngularSpeed"], 3),
        "maxLinearAccel": round(motion["maxLinearAccel"], 3),
        "maxTrueDistanceToGoalM": max([item["trueDistanceToGoal"] for item in log if item["result"] == "succeeded"] or [0.0]),
        "odometryErrorM": final["sim"]["odometryError"],
        "closestApproachM": None if closest == math.inf else round(closest, 3),
        "simulatedSeconds": round(sim.sim_time, 1),
        "wallMs": round((time.perf_counter() - started) * 1000, 1),
        "cpuMs": round((time.process_time() - cpu_started) * 1000, 1),
    }
    return {"name": scenario["name"], "description": scenario.get("description", ""), "passed": not problems, "problems": problems, "log": log, "closestApproachM": metrics["closestApproachM"], "simulatedSeconds": metrics["simulatedSeconds"], "simulator": SIMULATOR, "metrics": metrics}


def _peak_rss_kb() -> int | None:
    if resource is None:
        return None
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(peak // 1024) if sys.platform == "darwin" else int(peak)  # bytes on macOS, KiB on Linux


def run_suite(paths: list[str], config: dict) -> dict:
    """Every scenario with the same configuration, and the totals a regression suite compares."""
    results = [run_scenario(path, config) for path in paths]

    def total(key: str) -> float:
        return sum((result["metrics"][key] or 0) for result in results)

    def most(key: str) -> float:
        return max([result["metrics"][key] for result in results] or [0.0])

    trips = int(total("trips"))
    approaches = [result["metrics"]["closestApproachM"] for result in results if result["metrics"]["closestApproachM"] is not None]
    summary = {
        "scenarios": len(results),
        "scenariosPassed": sum(1 for result in results if result["passed"]),
        "missionCompletion": round(total("tripsSucceeded") / trips, 4) if trips else None,
        "navigationReliability": round(total("tripsAsExpected") / trips, 4) if trips else None,
        "trips": trips, "timeouts": int(total("timeouts")), "faults": int(total("faults")), "problems": int(total("problems")),
        "errorsPerTrip": round((total("faults") + total("problems")) / trips, 4) if trips else None,
        "distanceM": round(total("distanceM"), 3),
        "maxLinearSpeed": most("maxLinearSpeed"), "maxAngularSpeed": most("maxAngularSpeed"), "maxLinearAccel": most("maxLinearAccel"),
        "closestApproachM": min(approaches) if approaches else None,
        "maxOdometryErrorM": most("odometryErrorM"),
        "simulatedSeconds": round(total("simulatedSeconds"), 1),
        "wallMs": round(total("wallMs"), 1),
        "cpuMs": round(total("cpuMs"), 1),
        "peakRssKb": _peak_rss_kb(),
    }
    return {"simulator": SIMULATOR, "environment": ENVIRONMENT, "physical": False, "config": config, "summary": summary, "results": results}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m hannah_robot.scenarios", description="Scenario regression in HANNAH's built-in simulator (not Gazebo, not hardware).")
    parser.add_argument("paths", nargs="*", help="scenario files (default: every scenario in robotics/scenarios)")
    parser.add_argument("--profile", help="a kinematic robot profile whose limits, footprint and odometry drift the simulator uses")
    parser.add_argument("--overrides", help="JSON: {limits, robot, simulation} changed on top of the profile")
    parser.add_argument("--json", action="store_true", help="print one JSON report")
    args = parser.parse_args(argv if argv is not None else sys.argv[1:])
    targets = args.paths or sorted(glob.glob(os.path.join(DEFAULT_DIR, "*.json")))
    try:
        profile = None
        if args.profile:
            with open(args.profile, "r", encoding="utf-8") as handle:
                profile = json.load(handle)
        overrides = json.loads(args.overrides) if args.overrides else None
        if overrides is not None and not isinstance(overrides, dict):
            raise ScenarioConfigError("overrides must be a JSON object")
        config = sim_config(profile, overrides)
    except (OSError, ValueError) as error:
        message = str(error) if isinstance(error, ScenarioConfigError) else f"the profile or overrides can't be read ({type(error).__name__})"
        if args.json:
            print(json.dumps({"ok": False, "error": message}))
        else:
            print(message, file=sys.stderr)
        return 2
    if args.json:
        report = run_suite(targets, config)
        print(json.dumps({"ok": True, **report}))
        return 0 if report["summary"]["scenariosPassed"] == report["summary"]["scenarios"] else 1
    failed = 0
    for path in targets:
        result = run_scenario(path, config)
        failed += 0 if result["passed"] else 1
        print(f"{'PASS' if result['passed'] else 'FAIL'}  {result['name']:24s} {result['simulatedSeconds']:7.1f} s simulated  " + "; ".join(f"{item['to']}: {item['result']}" for item in result["log"]))
        for problem in result["problems"]:
            print(f"      {problem}")
    print(f"{len(targets) - failed} of {len(targets)} scenarios passed (built-in simulator; not Gazebo, not hardware)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
