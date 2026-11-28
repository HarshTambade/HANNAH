"""Robot OS's black box: audit events recorded, system telemetry read only from what the OS offers, retention and size caps, bridge envelopes."""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

from hannah_robot_os.blackbox import OSBlackBox
from hannah_robot_os.blackbox.format import read_segment
from hannah_robot_os.blackbox.system import snapshot
from hannah_robot_os.common import AuditLog
from hannah_robot_os.network.bridge import BridgeEnvelope

RUNTIME_FORMAT = Path(__file__).resolve().parents[3] / "robotics" / "runtime" / "hannah_robot" / "blackbox" / "format.py"


def fake_linux(root: Path, *, temp_millic: int = 45000, eth: str = "up") -> Path:
    (root / "proc").mkdir(parents=True)
    (root / "proc" / "meminfo").write_text("MemTotal:       4000000 kB\nMemFree:         100000 kB\nMemAvailable:   1000000 kB\n")
    (root / "proc" / "loadavg").write_text("0.52 0.40 0.31 1/123 4567\n")
    zone = root / "sys" / "class" / "thermal" / "thermal_zone0"
    zone.mkdir(parents=True)
    (zone / "temp").write_text(f"{temp_millic}\n")
    (zone / "type").write_text("cpu-thermal\n")
    for name, state in (("lo", "unknown"), ("eth0", eth)):
        (root / "sys" / "class" / "net" / name).mkdir(parents=True)
        (root / "sys" / "class" / "net" / name / "operstate").write_text(state + "\n")
    return root


class Clock:
    def __init__(self):
        self.now = 1_800_000_000.0

    def __call__(self):
        return self.now


def test_every_audit_event_is_recorded_with_its_source_and_queued_as_a_bridge_envelope(tmp_path):
    clock = Clock()
    box = OSBlackBox(str(tmp_path / "bb"), "robot-1", simulated=True, clock=clock)
    audit = AuditLog(sinks=[box.sink])
    audit.emit("safety-gateway", "motion_denied", severity="warning", reason="estop active")
    audit.emit("motor-controller", "controller_fault_needs_operator", severity="error", controller_id="left", image=b"\x00" * 10)
    box.flush()
    _header, records, info = read_segment(box.segments()[0]["path"])
    assert info["verified"]
    assert [(item["topic"], item["data"]["type"], item["sev"]) for item in records] == [("events/safety", "motion-denied", "warning"), ("events/motor", "controller-fault-needs-operator", "error")]
    assert records[1]["device"] == "left"
    assert records[1]["data"]["details"]["imageOmitted"] is True
    envelopes = box.envelopes()
    assert all(isinstance(item, BridgeEnvelope) and item.kind == "event" for item in envelopes)
    assert envelopes[0].payload["blackbox"]["summary"] == "safety-gateway: motion denied (estop active)"
    assert envelopes[0].payload["simulated"] is True
    box.mark_uploaded([item.payload["blackbox"]["id"] for item in envelopes])
    assert box.pending_events() == []


def test_a_failing_sink_never_breaks_the_service_that_emitted():
    def broken(_evt):
        raise OSError("disk full")
    audit = AuditLog(sinks=[broken])
    assert audit.emit("service-health", "state_changed").event == "state_changed"
    assert len(audit.list()) == 1


def test_system_telemetry_is_what_the_os_offers_and_crossing_a_threshold_is_an_event(tmp_path):
    root = fake_linux(tmp_path / "root", temp_millic=85000)
    snap = snapshot(root, str(tmp_path))
    assert snap["memory"]["usedPercent"] == 75.0
    assert snap["load"]["load1"] == 0.52
    assert snap["temperatures"] == [{"zone": "thermal_zone0", "type": "cpu-thermal", "celsius": 85.0}]
    assert snap["network"] == [{"interface": "eth0", "state": "up"}]
    empty = snapshot(tmp_path / "nothing", str(tmp_path))
    assert empty["memory"] is None and empty["load"] is None and empty["temperatures"] == [], "nothing offered: nothing invented"
    clock = Clock()
    box = OSBlackBox(str(tmp_path / "bb"), "robot-1", simulated=False, clock=clock, system_root=str(root), data_dir=str(tmp_path))
    assert box.sample_system() is not None
    assert box.sample_system() is None, "rate-limited"
    (root / "sys" / "class" / "net" / "eth0" / "operstate").write_text("down\n")
    clock.now += 6
    box.sample_system()
    types = [item["type"] for item in box.pending_events()]
    assert types.count("temperature-high") == 1, "a threshold warns once until it clears"
    assert "network-link-changed" in types


def test_retention_and_the_size_cap_remove_telemetry_before_events(tmp_path):
    clock = Clock()
    box = OSBlackBox(str(tmp_path / "bb"), "robot-1", simulated=True, clock=clock, max_segment_bytes=1200, max_total_bytes=5000, telemetry_retention_hours=1, events_retention_hours=24)
    box.event("safety", "estop-changed", "error", "E-stop engaged.")
    box.flush()
    for n in range(200):
        box.motor_status("left", {"target": n, "feedback": n - 1, "encoder": n * 10, "fault": None})
        clock.now += 1
    box.flush()
    kinds = [item["kind"] for item in box.segments()]
    assert "events" in kinds
    assert sum(item["bytes"] for item in box.segments()) <= 5000
    clock.now += 2 * 3600
    box.sweep()
    assert [item["kind"] for item in box.segments()] == ["events"]


def test_the_runtime_reads_robot_os_segments_and_the_formats_agree(tmp_path):
    clock = Clock()
    box = OSBlackBox(str(tmp_path / "bb"), "robot-1", simulated=True, clock=clock)
    box.event("os", "boot", "info", "Robot OS started.")
    box.flush()
    spec = importlib.util.spec_from_file_location("runtime_hbx_format", RUNTIME_FORMAT)
    runtime_format = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = runtime_format
    spec.loader.exec_module(runtime_format)
    header, records, info = runtime_format.read_segment(box.segments()[0]["path"])
    assert info["verified"] and header["robotId"] == "robot-1" and records[0]["data"]["type"] == "boot"
    # And the other way round.
    writer = runtime_format.SegmentWriter(os.path.join(str(tmp_path), "r.hbx"), {"segment": "seg_r", "robotId": "rb_1", "openedAt": 1})
    writer.append({"seq": 1, "t": 1, "topic": "nav/pose", "kind": "telemetry", "data": {"x": 1}})
    assert read_segment(writer.close(2))[2]["verified"]
