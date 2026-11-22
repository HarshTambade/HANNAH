"""Repeatable loopback latency benchmark for HANNAH's simulated device adapters.

This is a descriptive development-host measurement, not a product performance
test: both endpoints are HANNAH's own simulators and no physical device, hub
image, control plane or network is involved.

Run from hannah-os/runtime:
    python3 -m hannah_edge.benchmark --iterations 100 --output ../PERFORMANCE_BASELINE.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import platform
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .adapters.process import AdapterProcess
from .sim.broker import Broker
from .sim.devices import MqttRoom, ModbusMeter


ROOT = Path(__file__).resolve().parents[2]
PROFILES = ROOT / "profiles"


def percentile(samples_ms: list[float], percent: float) -> float:
    """Nearest-rank percentile, returning 0 for an empty sample."""
    if not samples_ms:
        return 0.0
    if not 0 < percent <= 100:
        raise ValueError("percent must be greater than 0 and no more than 100")
    values = sorted(samples_ms)
    return values[math.ceil(percent / 100 * len(values)) - 1]


def summarize(samples_ms: list[float], controller_cpu_seconds: float) -> dict:
    if not samples_ms:
        raise ValueError("at least one sample is required")
    total_seconds = sum(samples_ms) / 1000
    return {
        "samples": len(samples_ms),
        "minMs": round(min(samples_ms), 3),
        "medianMs": round(statistics.median(samples_ms), 3),
        "p95Ms": round(percentile(samples_ms, 95), 3),
        "maxMs": round(max(samples_ms), 3),
        "meanMs": round(statistics.mean(samples_ms), 3),
        "operationsPerSecond": round(len(samples_ms) / total_seconds, 2) if total_seconds else None,
        "controllerCpuSeconds": round(controller_cpu_seconds, 4),
    }


def _profile(name: str) -> dict:
    with (PROFILES / ("org.hannah.sim." + name + ".json")).open(encoding="utf-8") as handle:
        return json.load(handle)


def _device(profile: dict, device_id: str, settings: dict) -> dict:
    writable = [point["id"] for point in profile["points"] if point.get("access") == "read-write"]
    return {"id": device_id, "name": profile["name"], "profile": profile, "settings": settings, "writable": writable}


def _wait_for(check, what: str, seconds: float = 8.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(0.001)
    raise TimeoutError("Timed out waiting for " + what)


def _point(profile: dict, kind: str) -> dict:
    for point in profile["points"]:
        if point.get("type") == kind and point.get("access") == "read-write":
            return point
    raise ValueError("The simulation profile has no writable " + kind + " point")


def _measure_toggle(adapter, point: dict, iterations: int, warmup: int) -> dict:
    _wait_for(lambda: adapter.reading(point["id"]), point["id"] + " initial reading")
    current = bool(adapter.reading(point["id"])["value"])

    def toggle():
        nonlocal current
        current = not current
        started = time.perf_counter_ns()
        adapter.write(point["id"], current)
        adapter.refresh(point["id"])
        _wait_for(
            lambda: (reading := adapter.reading(point["id"]))
            and reading.get("value") is current,
            point["id"] + " write/readback",
        )
        return (time.perf_counter_ns() - started) / 1_000_000

    for _ in range(warmup):
        toggle()
    samples = []
    cpu_before = time.process_time()
    for _ in range(iterations):
        samples.append(toggle())
    return summarize(samples, time.process_time() - cpu_before)


def run(iterations: int = 100, warmup: int = 5) -> dict:
    if not 10 <= iterations <= 5000:
        raise ValueError("iterations must be between 10 and 5000")
    if not 0 <= warmup <= 100:
        raise ValueError("warmup must be between 0 and 100")

    mqtt_profile = _profile("fan")
    mqtt_point = _point(mqtt_profile, "boolean")
    broker = Broker()
    room = None
    mqtt_device = AdapterProcess("mqtt", _device(mqtt_profile, "bench-mqtt", {"host": broker.host, "port": broker.port}), client_id="hannah-bench-mqtt")
    try:
        room = MqttRoom(broker.host, broker.port, period=5.0)
        startup = time.perf_counter_ns()
        mqtt_device.start()
        mqtt_startup_ms = (time.perf_counter_ns() - startup) / 1_000_000
        mqtt_result = _measure_toggle(mqtt_device, mqtt_point, iterations, warmup)
        mqtt_result["workerStartupMs"] = round(mqtt_startup_ms, 3)
    finally:
        mqtt_device.stop()
        if room:
            room.close()
        broker.close()

    modbus_profile = _profile("power-meter")
    modbus_point = _point(modbus_profile, "boolean")
    meter = ModbusMeter()
    modbus_device = AdapterProcess("modbus-tcp", _device(modbus_profile, "bench-modbus", {"host": meter.host, "port": meter.port, "unit": 1}), client_id="hannah-bench-modbus")
    try:
        startup = time.perf_counter_ns()
        modbus_device.start()
        modbus_startup_ms = (time.perf_counter_ns() - startup) / 1_000_000
        modbus_result = _measure_toggle(modbus_device, modbus_point, iterations, warmup)
        modbus_result["workerStartupMs"] = round(modbus_startup_ms, 3)
    finally:
        modbus_device.stop()
        meter.close()

    return {
        "format": "hannah-sim-performance-v1",
        "measuredAt": datetime.now(timezone.utc).isoformat(),
        "host": {
            "os": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor() or "not reported",
            "python": sys.version.split()[0],
            "logicalCpuCount": os.cpu_count(),
        },
        "workload": {
            "iterationsPerProtocol": iterations,
            "warmupPerProtocol": warmup,
            "operation": "Toggle one simulated boolean output and wait for the adapter child process to report the matching readback over its private pipe.",
            "network": "Loopback TCP sockets on the same development host.",
        },
        "results": {
            "mqtt": {"adapter": "HANNAH MqttDevice", "simulator": "HANNAH Broker + MqttRoom fan", **mqtt_result},
            "modbusTcp": {"adapter": "HANNAH ModbusDevice", "simulator": "HANNAH ModbusMeter", **modbus_result},
        },
        "limitations": [
            "Both endpoints are written by HANNAH; this is not interoperability evidence.",
            "The benchmark includes per-device process IPC during measured operations, but excludes process CPU used by child workers.",
            "No physical devices, production hub image, server control plane or external network were measured.",
            "Results depend on this host, Python build, background load and simulator implementation; there is no pass/fail target.",
            "Latency includes simulator response and adapter readback, but excludes account authentication, Action Engine assessment, approval time and server-to-hub transport.",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=100, help="measured write/readback cycles per protocol (10 to 5000)")
    parser.add_argument("--warmup", type=int, default=5, help="unrecorded cycles per protocol (0 to 100)")
    parser.add_argument("--output", type=Path, help="write JSON to this path; defaults to stdout")
    args = parser.parse_args(argv)
    result = run(args.iterations, args.warmup)
    text = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
