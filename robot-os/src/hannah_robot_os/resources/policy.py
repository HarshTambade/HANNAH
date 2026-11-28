"""Thermal, power, storage, memory and overload warnings, and the predefined
recovery policies they may trigger.

The only things a policy can do are:

    warn                 record a warning and report it to HANNAH
    shed_optional_load   lower the CPU quota of sheddable classes (optional
                         perception, AI reasoning, background, maintenance)
                         for as long as the condition lasts
    offload_reasoning    move eligible AI reasoning to a remote resource the
                         owner approved, when the network is up and the
                         privacy setting allows it
    restore              put the quotas back once the condition has cleared

There is no policy that stops, kills, shuts down or throttles a service in a
protected class (critical safety, navigation), and check_action() refuses any
action that would. Collision avoidance and the safety functions keep running
at full priority whatever the readings say.

A metric the device can't measure never raises or clears a warning; it is
listed under `unmeasured` so the dashboard can say the condition is unknown.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .metrics import is_measured, value_of
from .workloads import DEFAULT_SPECS, WorkloadClass, WorkloadSpec

ALLOWED_POLICIES = {"warn", "shed_optional_load", "offload_reasoning", "restore"}
FORBIDDEN_WORDS = {"stop", "kill", "shutdown", "poweroff", "halt", "disable", "mask", "freeze"}


@dataclass
class Thresholds:
    cpu_temp_warn_c: float = 80.0
    cpu_temp_critical_c: float = 90.0
    gpu_temp_warn_c: float = 83.0
    gpu_temp_critical_c: float = 92.0
    battery_warn_pct: float = 25.0
    battery_critical_pct: float = 12.0
    storage_warn_pct: float = 85.0
    storage_critical_pct: float = 95.0
    memory_warn_pct: float = 85.0
    memory_critical_pct: float = 93.0
    cpu_overload_pct: float = 95.0
    # Consecutive samples above cpu_overload_pct before it counts as overload.
    overload_samples: int = 3
    # Consecutive clear samples before shed load is restored.
    clear_samples: int = 3

    @staticmethod
    def from_dict(data: dict[str, Any] | None) -> "Thresholds":
        base = Thresholds()
        for key, value in (data or {}).items():
            if not hasattr(base, key):
                raise ValueError(f"unknown threshold: {key}")
            setattr(base, key, type(getattr(base, key))(value))
        return base


@dataclass
class PolicyConfig:
    # Remote resources (a HANNAH server, a GPU box) the owner approved for reasoning. Empty: none.
    approved_remote_resources: list[str] = field(default_factory=list)
    # "local-only" keeps reasoning on the robot whatever happens.
    reasoning_privacy: str = "allow-approved-remote"

    @staticmethod
    def from_dict(data: dict[str, Any] | None) -> "PolicyConfig":
        data = data or {}
        privacy = str(data.get("reasoning_privacy", "allow-approved-remote"))
        if privacy not in {"local-only", "allow-approved-remote"}:
            raise ValueError("reasoning_privacy must be local-only or allow-approved-remote")
        return PolicyConfig(approved_remote_resources=[str(x) for x in data.get("approved_remote_resources", []) if str(x).strip()], reasoning_privacy=privacy)


def check_action(action: dict[str, Any], specs: dict[WorkloadClass, WorkloadSpec] | None = None) -> None:
    """Raise ValueError for anything but a predefined policy on non-protected classes."""
    specs = specs or DEFAULT_SPECS
    policy = str(action.get("policy", ""))
    if policy not in ALLOWED_POLICIES:
        raise ValueError(f"{policy or 'that'} is not a predefined recovery policy")
    for word in FORBIDDEN_WORDS:
        if word in str(action.get("operation", "")).lower():
            raise ValueError(f"recovery policies never {word} a service")
    for name in action.get("targets", []):
        cls = WorkloadClass(name)
        if specs[cls].protected:
            raise ValueError(f"{cls.value} is protected; no policy may throttle, shed or offload it")
        if policy == "shed_optional_load" and not specs[cls].sheddable:
            raise ValueError(f"{cls.value} is not sheddable")


def _warning(kind: str, severity: str, metric: str, value: Any, threshold: float, message: str, source: str) -> dict[str, Any]:
    return {"kind": kind, "severity": severity, "metric": metric, "value": value, "threshold": threshold, "message": message, "source": source}


def evaluate(snapshot: dict[str, Any], thresholds: Thresholds | None = None, history: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Warnings from one snapshot (and the recent history, for sustained overload). Pure."""
    t = thresholds or Thresholds()
    warnings: list[dict[str, Any]] = []
    unmeasured: list[str] = []

    def level(value: float, warn: float, critical: float, higher_is_worse: bool = True) -> str | None:
        if higher_is_worse:
            return "critical" if value >= critical else "warning" if value >= warn else None
        return "critical" if value <= critical else "warning" if value <= warn else None

    cpu = snapshot.get("cpu", {})
    temp = cpu.get("temperature_c")
    if is_measured(temp):
        sev = level(temp["value"], t.cpu_temp_warn_c, t.cpu_temp_critical_c)
        if sev:
            warnings.append(_warning("thermal", sev, "cpu.temperature_c", temp["value"], t.cpu_temp_critical_c if sev == "critical" else t.cpu_temp_warn_c, f"CPU temperature {temp['value']} C", temp["source"]))
    else:
        unmeasured.append("cpu.temperature_c")

    for index, gpu in enumerate(snapshot.get("gpu", {}).get("devices", [])):
        gtemp = gpu.get("temperature_c")
        if is_measured(gtemp):
            sev = level(gtemp["value"], t.gpu_temp_warn_c, t.gpu_temp_critical_c)
            if sev:
                warnings.append(_warning("thermal", sev, f"gpu[{index}].temperature_c", gtemp["value"], t.gpu_temp_critical_c if sev == "critical" else t.gpu_temp_warn_c, f"GPU {gpu.get('name', index)} temperature {gtemp['value']} C", gtemp["source"]))

    battery = snapshot.get("battery", {})
    percent, status = battery.get("percent"), battery.get("status")
    if is_measured(percent):
        discharging = value_of(status) not in {"charging", "full"}
        sev = level(percent["value"], t.battery_warn_pct, t.battery_critical_pct, higher_is_worse=False)
        if sev and discharging:
            warnings.append(_warning("power", sev, "battery.percent", percent["value"], t.battery_critical_pct if sev == "critical" else t.battery_warn_pct, f"Battery at {percent['value']}% and {value_of(status) or 'not reported as charging'}", percent["source"]))
    else:
        unmeasured.append("battery.percent")

    for disk in snapshot.get("storage", []):
        used = disk.get("used_pct")
        if is_measured(used):
            sev = level(used["value"], t.storage_warn_pct, t.storage_critical_pct)
            if sev:
                warnings.append(_warning("storage", sev, f"storage[{disk.get('path')}].used_pct", used["value"], t.storage_critical_pct if sev == "critical" else t.storage_warn_pct, f"{disk.get('path')} is {used['value']}% full", used["source"]))
        else:
            unmeasured.append(f"storage[{disk.get('path')}].used_pct")

    mem = snapshot.get("memory", {}).get("used_pct")
    if is_measured(mem):
        sev = level(mem["value"], t.memory_warn_pct, t.memory_critical_pct)
        if sev:
            warnings.append(_warning("memory", sev, "memory.used_pct", mem["value"], t.memory_critical_pct if sev == "critical" else t.memory_warn_pct, f"Memory {mem['value']}% used", mem["source"]))
    else:
        unmeasured.append("memory.used_pct")

    util = cpu.get("utilization_pct")
    if is_measured(util):
        recent = [value_of(h.get("cpu", {}).get("utilization_pct")) for h in (history or [])][-(t.overload_samples - 1):] if t.overload_samples > 1 else []
        series = [v for v in recent if v is not None] + [util["value"]]
        if len(series) >= t.overload_samples and all(v >= t.cpu_overload_pct for v in series[-t.overload_samples:]):
            warnings.append(_warning("overload", "critical", "cpu.utilization_pct", util["value"], t.cpu_overload_pct, f"CPU at or above {t.cpu_overload_pct}% for {t.overload_samples} samples", util["source"]))
    else:
        unmeasured.append("cpu.utilization_pct")

    worst = "critical" if any(w["severity"] == "critical" for w in warnings) else "warning" if warnings else "ok"
    return {"status": worst, "warnings": warnings, "unmeasured": unmeasured}


SHED_TARGETS = [WorkloadClass.PERCEPTION, WorkloadClass.AI_REASONING, WorkloadClass.BACKGROUND, WorkloadClass.MAINTENANCE]


def decide(evaluation: dict[str, Any], snapshot: dict[str, Any], config: PolicyConfig | None = None, specs: dict[WorkloadClass, WorkloadSpec] | None = None) -> list[dict[str, Any]]:
    """The predefined responses to an evaluation. Every action passes check_action()."""
    config = config or PolicyConfig()
    specs = specs or DEFAULT_SPECS
    actions: list[dict[str, Any]] = []
    warnings = evaluation.get("warnings", [])
    if warnings:
        actions.append({"policy": "warn", "targets": [], "reason": "; ".join(w["message"] for w in warnings)})
    critical = [w for w in warnings if w["severity"] == "critical"]
    shed_kinds = {"thermal", "memory", "overload", "power"}
    shed_reasons = [w for w in critical if w["kind"] in shed_kinds]
    storage_critical = [w for w in critical if w["kind"] == "storage"]
    if shed_reasons:
        targets = [c.value for c in SHED_TARGETS if specs[c].sheddable]
        actions.append({
            "policy": "shed_optional_load",
            "targets": targets,
            "quota_pct": {c.value: specs[c].shed_cpu_quota_pct for c in SHED_TARGETS if specs[c].sheddable},
            "reason": "; ".join(w["message"] for w in shed_reasons),
            "keeps": "critical safety and navigation (collision avoidance) keep full priority",
        })
    elif storage_critical:
        # A full disk is slowed by writers, not by perception: shed only background and maintenance.
        targets = [c.value for c in (WorkloadClass.BACKGROUND, WorkloadClass.MAINTENANCE) if specs[c].sheddable]
        actions.append({"policy": "shed_optional_load", "targets": targets, "quota_pct": {c: specs[WorkloadClass(c)].shed_cpu_quota_pct for c in targets}, "reason": "; ".join(w["message"] for w in storage_critical), "keeps": "critical safety and navigation keep full priority; safety logs keep writing"})
    if shed_reasons or any(w["kind"] == "power" for w in warnings):
        actions.append(offload_decision(snapshot, config, "; ".join(w["message"] for w in (shed_reasons or [w for w in warnings if w["kind"] == "power"]))))
    for action in actions:
        check_action(action, specs)
    return actions


def offload_decision(snapshot: dict[str, Any], config: PolicyConfig, reason: str) -> dict[str, Any]:
    base = {"policy": "offload_reasoning", "targets": [WorkloadClass.AI_REASONING.value], "reason": reason}
    if config.reasoning_privacy == "local-only":
        return {**base, "status": "not-allowed", "detail": "Reasoning is set to stay on this robot (local-only); it is shed instead of moved."}
    if not config.approved_remote_resources:
        return {**base, "status": "unavailable", "detail": "No remote resource has been approved for this robot's reasoning."}
    link = snapshot.get("network", {}).get("link_up")
    if not is_measured(link):
        return {**base, "status": "unavailable", "detail": "The network link state can't be measured, so a remote resource can't be relied on."}
    if not link["value"]:
        return {**base, "status": "unavailable", "detail": "No network link is up."}
    return {**base, "status": "eligible", "resource": config.approved_remote_resources[0], "detail": "Eligible reasoning requests go to the approved remote resource; requests marked private stay on the robot."}
