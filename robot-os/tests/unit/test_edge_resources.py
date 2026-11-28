"""Edge Resource Manager: metrics from fixture /proc and /sys trees, the real
machine's own values where it has them, workload protection, warnings and
the predefined recovery policies."""
from __future__ import annotations

import json
import os
import platform
from pathlib import Path

import pytest

from hannah_robot_os.config import RobotOSConfig
from hannah_robot_os.resources import (
    DEFAULT_SPECS,
    EdgeResourceManager,
    NOT_MEASURABLE,
    PolicyConfig,
    ResourceProbe,
    Thresholds,
    WorkloadClass,
    check_action,
    decide,
    evaluate,
    generate_units,
    manager_from_config,
    validate_specs,
)
from hannah_robot_os.resources.manager import quota_commands
from hannah_robot_os.resources.workloads import apply_overrides, assignments, cgroup_settings

STAT_1 = "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\n"
STAT_2 = "cpu  250 0 150 900 0 0 0 0 0 0\ncpu0 250 0 150 900 0 0 0 0 0 0\n"


def write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def linux_tree(root: Path, *, temp_milli: int = 52000, battery: int | None = 80, status: str = "Discharging", used_kb: int = 4_000_000) -> Path:
    write(root, "proc/stat", STAT_1)
    write(root, "proc/meminfo", f"MemTotal:        8000000 kB\nMemFree:          1000000 kB\nMemAvailable:    {8_000_000 - used_kb} kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n")
    write(root, "proc/loadavg", "1.25 0.90 0.70 2/300 4242\n")
    write(root, "proc/cpuinfo", "processor\t: 0\nprocessor\t: 1\nprocessor\t: 2\nprocessor\t: 3\n")
    write(root, "proc/net/dev", "Inter-|   Receive\n face |bytes packets\n    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n")
    (root / "proc" / "1").mkdir(parents=True, exist_ok=True)
    (root / "proc" / "77").mkdir(parents=True, exist_ok=True)
    write(root, "sys/class/net/eth0/operstate", "up\n")
    write(root, "sys/class/net/eth0/speed", "1000\n")
    write(root, "sys/class/thermal/thermal_zone0/type", "cpu-thermal\n")
    write(root, "sys/class/thermal/thermal_zone0/temp", f"{temp_milli}\n")
    write(root, "sys/class/thermal/thermal_zone1/type", "gpu-thermal\n")
    write(root, "sys/class/thermal/thermal_zone1/temp", "41000\n")
    if battery is not None:
        write(root, "sys/class/power_supply/BAT0/type", "Battery\n")
        write(root, "sys/class/power_supply/BAT0/capacity", f"{battery}\n")
        write(root, "sys/class/power_supply/BAT0/status", f"{status}\n")
        write(root, "sys/class/power_supply/BAT0/voltage_now", "24100000\n")
        write(root, "sys/class/power_supply/BAT0/current_now", "1500000\n")
    write(root, "sys/class/power_supply/AC/type", "Mains\n")
    write(root, "sys/class/power_supply/AC/online", "0\n")
    return root


def probe_for(root: Path, storage: list[str] | None = None, **kw) -> ResourceProbe:
    # Storage is the real filesystem under the fixture (statvfs can't be faked), so policy
    # tests leave it out: how full this computer's disk is mustn't change their outcome.
    return ResourceProbe(root=root, storage_paths=storage or [], which=lambda _n: None, psutil_module=None, cpu_interval_s=0, **kw)


# ---------------------------------------------------------------- metrics
def test_fixture_tree_metrics_are_read_with_their_source(tmp_path: Path):
    probe = probe_for(linux_tree(tmp_path), storage=["/"])
    snap = probe.sample()
    assert snap["schema"] == "hannah.edge-resources.v1"
    mem = snap["memory"]
    assert mem["total_mb"]["value"] == pytest.approx(7812.5)
    assert mem["used_pct"]["value"] == 50.0 and mem["used_pct"]["source"] == "/proc/meminfo"
    assert mem["swap_used_pct"]["value"] == 25.0
    cpu = snap["cpu"]
    assert cpu["cores"]["value"] == 4
    assert cpu["load_1m"]["value"] == 1.25
    assert cpu["temperature_c"]["value"] == 52.0 and "thermal_zone0" in cpu["temperature_c"]["source"]
    # CPU use is a rate: with no second sample it is not invented.
    assert cpu["utilization_pct"]["available"] is False
    assert NOT_MEASURABLE in cpu["utilization_pct"]["reason"]
    bat = snap["battery"]
    assert bat["percent"]["value"] == 80 and bat["status"]["value"] == "discharging"
    assert bat["voltage_v"]["value"] == pytest.approx(24.1)
    assert bat["power_w"]["value"] == pytest.approx(36.15)
    assert snap["power"]["external_power"]["value"] is False
    eth = snap["network"]["interfaces"][0]
    assert eth["name"] == "eth0" and eth["up"]["value"] is True and eth["speed_mbps"]["value"] == 1000
    assert snap["network"]["link_up"]["value"] is True
    assert snap["processes"]["count"]["value"] == 2
    assert snap["storage"][0]["total_gb"]["available"] is True
    assert snap["gpu"]["devices"] == [] and snap["gpu"]["status"]["available"] is False
    assert snap["inference"]["latency_ms_p50"]["available"] is False


def test_cpu_utilization_comes_from_two_proc_stat_samples(tmp_path: Path):
    root = linux_tree(tmp_path)
    probe = probe_for(root)
    probe.sample()
    write(root, "proc/stat", STAT_2)
    util = probe.sample()["cpu"]["utilization_pct"]
    # delta total 300, delta idle 100 -> 66.7 %
    assert util["available"] and util["value"] == pytest.approx(66.7)


def test_missing_trees_are_reported_as_not_measurable(tmp_path: Path):
    snap = probe_for(tmp_path).sample()
    for key in ("total_mb", "available_mb", "used_pct"):
        assert snap["memory"][key]["available"] is False
        assert snap["memory"][key]["reason"].startswith(NOT_MEASURABLE)
    assert snap["cpu"]["temperature_c"]["available"] is False
    assert snap["battery"]["percent"]["available"] is False
    assert snap["power"]["external_power"]["available"] is False
    assert snap["network"]["link_up"]["available"] is False
    assert snap["processes"]["count"]["available"] is False
    # Nothing anywhere carries an invented value.
    def leaves(node):
        if isinstance(node, dict):
            if "available" in node:
                yield node
            for v in node.values():
                yield from leaves(v)
        elif isinstance(node, list):
            for v in node:
                yield from leaves(v)
    for leaf in leaves(snap):
        if leaf["available"] is False:
            assert "value" not in leaf


def test_nvidia_smi_and_tegrastats_are_parsed_when_present(tmp_path: Path):
    out = "NVIDIA RTX A2000, 37, 2100, 6138, 61, 34.50\n"
    probe = ResourceProbe(root=tmp_path, which=lambda n: "/usr/bin/nvidia-smi" if n == "nvidia-smi" else None, runner=lambda cmd, t: out, psutil_module=None, cpu_interval_s=0)
    gpu = probe.gpu()["devices"][0]
    assert gpu["name"] == "NVIDIA RTX A2000"
    assert gpu["memory_total_mb"]["value"] == 6138 and gpu["power_w"]["value"] == 34.5
    na = ResourceProbe(root=tmp_path, which=lambda n: "x" if n == "nvidia-smi" else None, runner=lambda cmd, t: "GPU, 5, 1, 2, 40, [N/A]\n", psutil_module=None).gpu()["devices"][0]
    assert na["power_w"]["available"] is False
    line = "RAM 2510/7620MB (lfb 2x4MB) CPU [3%@1190,2%@1190] GR3D_FREQ 21% cpu@44.5C GPU@43.25C VDD_GPU_SOC 1200mW/1200mW"
    tegra = ResourceProbe(root=tmp_path, which=lambda n: "x" if n == "tegrastats" else None, line_reader=lambda cmd, t: line, psutil_module=None).gpu()["devices"][0]
    assert tegra["utilization_pct"]["value"] == 21 and tegra["memory_total_mb"]["value"] == 7620
    assert tegra["temperature_c"]["value"] == 43.25 and tegra["power_w"]["value"] == 1.2 and tegra["shared_memory"]


def test_inference_latency_is_only_what_was_recorded():
    probe = ResourceProbe(root="/nonexistent", psutil_module=None)
    for ms in (100, 120, 140, 900):
        probe.inference.record(ms)
    summary = probe.inference.summary()
    assert summary["samples"] == 4 and summary["latency_ms_p95"]["value"] == 900


def test_this_machine_reports_real_values_or_says_why_not():
    """Reads the computer running the tests. Linux has /proc; macOS doesn't, and must say so."""
    probe = ResourceProbe(cpu_interval_s=0.05)
    snap = probe.sample()
    disk = snap["storage"][0]
    assert disk["total_gb"]["available"] and disk["total_gb"]["value"] > 0  # statvfs works everywhere POSIX
    if Path("/proc/meminfo").exists():
        assert snap["memory"]["total_mb"]["available"] and snap["memory"]["total_mb"]["value"] > 0
        assert snap["cpu"]["utilization_pct"]["available"]
    elif probe.psutil_module is not None:
        assert snap["memory"]["total_mb"]["source"].startswith("psutil")
    else:
        assert platform.system() != "Linux" or not Path("/proc").exists()
        assert snap["memory"]["total_mb"]["available"] is False
        assert "/proc/meminfo is missing" in snap["memory"]["total_mb"]["reason"]
        # Load average and core count still come from the OS itself.
        assert snap["cpu"]["cores"]["value"] == os.cpu_count()


# ---------------------------------------------------------------- workloads
def test_critical_safety_is_never_deprioritized():
    assert validate_specs(DEFAULT_SPECS) == []
    crit = DEFAULT_SPECS[WorkloadClass.CRITICAL_SAFETY]
    assert crit.protected and not crit.sheddable and crit.cpu_quota_pct is None and crit.memory_high_mb is None
    for cls, spec in DEFAULT_SPECS.items():
        if cls is WorkloadClass.CRITICAL_SAFETY:
            continue
        assert spec.nice > crit.nice and spec.cpu_weight < crit.cpu_weight and spec.oom_score_adjust > crit.oom_score_adjust
    with pytest.raises(ValueError, match="protected"):
        apply_overrides({"critical_safety": {"nice": 19}})
    with pytest.raises(ValueError, match="protected"):
        apply_overrides({"navigation": {"cpu_quota_pct": 10}})
    with pytest.raises(ValueError, match="higher nice"):
        apply_overrides({"perception": {"nice": -15}})
    with pytest.raises(ValueError, match="safety service"):
        assignments({"motor-controller": "background"})


def test_generated_units_keep_safety_first():
    files = generate_units()
    crit = files["hannah-critical.slice"]
    assert "CPUWeight=1000" in crit and "CPUQuota" not in crit and "MemoryHigh" not in crit and "MemoryMin=256M" in crit
    assert "CPUQuota=200%" in files["hannah-ai.slice"]
    gateway = files["hannah-safety-gateway.service.d/10-hannah-resources.conf"]
    assert "Slice=hannah-critical.slice" in gateway and "Nice=-10" in gateway and "ManagedOOMPreference=omit" in gateway
    assert "Slice=hannah-navigation.slice" in files["hannah-ros2-runtime.service.d/10-hannah-resources.conf"]
    raw = cgroup_settings(DEFAULT_SPECS[WorkloadClass.CRITICAL_SAFETY], shed=True)
    assert raw["cpu.max"] == "max 100000" and raw["memory.high"] == "max"
    assert cgroup_settings(DEFAULT_SPECS[WorkloadClass.AI_REASONING], shed=True)["cpu.max"] == "50000 100000"


def test_units_command_writes_the_files(tmp_path: Path):
    from hannah_robot_os.__main__ import main
    import sys

    argv = sys.argv
    sys.argv = ["hannah-robot-os", "resources", "units", "--out", str(tmp_path)]
    try:
        assert main() == 0
    finally:
        sys.argv = argv
    assert (tmp_path / "hannah-critical.slice").exists()
    assert (tmp_path / "hannah-motor-controller.service.d" / "10-hannah-resources.conf").exists()


# ---------------------------------------------------------------- policies
def snap_with(tmp_path: Path, **kw) -> dict:
    return probe_for(linux_tree(tmp_path, **kw)).sample()


def test_no_warnings_on_a_healthy_robot(tmp_path: Path):
    ev = evaluate(snap_with(tmp_path))
    assert ev["status"] == "ok" and ev["warnings"] == []
    assert decide(ev, snap_with(tmp_path)) == []


def test_thermal_critical_sheds_optional_load_and_never_touches_safety(tmp_path: Path):
    snap = snap_with(tmp_path, temp_milli=93000)
    ev = evaluate(snap)
    assert ev["status"] == "critical" and ev["warnings"][0]["kind"] == "thermal"
    actions = decide(ev, snap, PolicyConfig())
    policies = [a["policy"] for a in actions]
    assert policies[:2] == ["warn", "shed_optional_load"]
    shed = actions[1]
    assert "critical_safety" not in shed["targets"] and "navigation" not in shed["targets"]
    assert set(shed["targets"]) == {"perception", "ai_reasoning", "background", "maintenance"}
    offload = next(a for a in actions if a["policy"] == "offload_reasoning")
    assert offload["status"] == "unavailable"  # nothing approved
    commands = quota_commands(shed, DEFAULT_SPECS)
    assert all("critical" not in " ".join(c) and "navigation" not in " ".join(c) for c in commands)
    assert ["systemctl", "set-property", "--runtime", "hannah-ai.slice", "CPUQuota=50%"] in commands


def test_offload_goes_only_to_an_approved_remote_with_a_link(tmp_path: Path):
    snap = snap_with(tmp_path, temp_milli=95000)
    ev = evaluate(snap)
    approved = PolicyConfig(approved_remote_resources=["hannah-server"])
    assert next(a for a in decide(ev, snap, approved) if a["policy"] == "offload_reasoning")["status"] == "eligible"
    private = PolicyConfig(approved_remote_resources=["hannah-server"], reasoning_privacy="local-only")
    assert next(a for a in decide(ev, snap, private) if a["policy"] == "offload_reasoning")["status"] == "not-allowed"
    snap["network"]["link_up"] = {"available": True, "value": False, "unit": "bool", "source": "test"}
    assert next(a for a in decide(ev, snap, approved) if a["policy"] == "offload_reasoning")["status"] == "unavailable"


def test_low_battery_while_charging_is_not_a_power_warning(tmp_path: Path):
    assert evaluate(snap_with(tmp_path, battery=10, status="Charging"))["warnings"] == []
    low = evaluate(snap_with(tmp_path / "b", battery=10, status="Discharging"))
    assert low["warnings"][0]["kind"] == "power" and low["warnings"][0]["severity"] == "critical"


def test_storage_critical_sheds_only_writers():
    snap = {"storage": [{"path": "/var", "used_pct": {"available": True, "value": 97.0, "unit": "%", "source": "os.statvfs"}}], "network": {}}
    ev = evaluate(snap)
    assert ev["warnings"][0]["kind"] == "storage" and ev["warnings"][0]["severity"] == "critical"
    shed = next(a for a in decide(ev, snap) if a["policy"] == "shed_optional_load")
    assert shed["targets"] == ["background", "maintenance"]


def test_unmeasured_metrics_never_warn(tmp_path: Path):
    ev = evaluate(probe_for(tmp_path).sample())
    assert ev["warnings"] == [] and "cpu.temperature_c" in ev["unmeasured"] and "battery.percent" in ev["unmeasured"]


def test_memory_and_sustained_overload(tmp_path: Path):
    snap = snap_with(tmp_path, used_kb=7_700_000)
    assert evaluate(snap)["warnings"][0]["kind"] == "memory"
    hot = {"cpu": {"utilization_pct": {"available": True, "value": 99.0, "unit": "%", "source": "t"}}}
    one = evaluate(hot, Thresholds(overload_samples=3), history=[])
    assert not any(w["kind"] == "overload" for w in one["warnings"])
    three = evaluate(hot, Thresholds(overload_samples=3), history=[hot, hot])
    assert any(w["kind"] == "overload" for w in three["warnings"])


def test_check_action_refuses_anything_unsafe():
    for bad in (
        {"policy": "shed_optional_load", "targets": ["critical_safety"]},
        {"policy": "shed_optional_load", "targets": ["navigation"]},
        {"policy": "offload_reasoning", "targets": ["critical_safety"]},
        {"policy": "shutdown", "targets": []},
        {"policy": "warn", "targets": [], "operation": "systemctl stop hannah-ai"},
    ):
        with pytest.raises(ValueError):
            check_action(bad)
    check_action({"policy": "shed_optional_load", "targets": ["perception", "ai_reasoning"]})


# ---------------------------------------------------------------- manager
def test_manager_keeps_history_restores_and_recommends_by_default(tmp_path: Path):
    root = linux_tree(tmp_path / "root", temp_milli=95000)
    ran: list[list[str]] = []
    mgr = EdgeResourceManager(probe=probe_for(root), state_dir=tmp_path / "state", executor=lambda c: (ran.append(c) or True, "ok"), thresholds=Thresholds(clear_samples=2))
    report = mgr.tick()
    assert report["enforcement"] == "recommend-only" and report["shed_active"]
    shed = next(a for a in report["actions"] if a["policy"] == "shed_optional_load")
    assert shed["applied"] is False and ran == []
    write(root, "sys/class/thermal/thermal_zone0/temp", "50000\n")
    mgr.tick()
    restored = mgr.tick()
    assert any(a["policy"] == "restore" for a in restored["actions"]) and not restored["shed_active"]
    lines = (tmp_path / "state" / "history.jsonl").read_text().splitlines()
    assert len(lines) == 3
    latest = json.loads((tmp_path / "state" / "latest.json").read_text())
    assert latest["report_id"] == restored["report_id"]
    # History survives a restart.
    again = EdgeResourceManager(probe=probe_for(root), state_dir=tmp_path / "state")
    assert len(again.history()) == 3
    table = {row["cls"]: row for row in report["workloads"]}
    assert table["critical_safety"]["protected"] and "motor-controller" in table["critical_safety"]["services"]


def test_enforced_shed_runs_only_quota_commands(tmp_path: Path):
    root = linux_tree(tmp_path, temp_milli=95000)
    ran: list[list[str]] = []
    mgr = EdgeResourceManager(probe=probe_for(root), enforce=True, executor=lambda c: (ran.append(c) or True, "ok"))
    mgr.tick()
    assert ran and all(c[:3] == ["systemctl", "set-property", "--runtime"] for c in ran)
    assert not any("critical" in c[3] or "navigation" in c[3] for c in ran)


def test_envelope_carries_the_report(tmp_path: Path):
    mgr = EdgeResourceManager(probe=probe_for(linux_tree(tmp_path)))
    env = mgr.envelope("robot-7")
    assert env.kind == "telemetry" and env.payload["type"] == "edge_resources"
    assert env.payload["report"]["snapshot"]["schema"] == "hannah.edge-resources.v1"


def test_manager_from_config_refuses_unsafe_overrides(tmp_path: Path):
    cfg = RobotOSConfig.from_dict({"data_dir": str(tmp_path), "resources": {"workload_overrides": {"critical_safety": {"nice": 10}}}})
    with pytest.raises(ValueError):
        manager_from_config(cfg)
    ok = RobotOSConfig.from_dict({"data_dir": str(tmp_path), "resources": {"approved_remote_resources": ["hannah"], "thresholds": {"cpu_temp_warn_c": 70}}})
    mgr = manager_from_config(ok, root=str(tmp_path))
    assert mgr.thresholds.cpu_temp_warn_c == 70 and mgr.config.approved_remote_resources == ["hannah"]
    assert ok.to_dict()["resources"]["approved_remote_resources"] == ["hannah"]
