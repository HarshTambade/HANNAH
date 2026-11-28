"""Workload classes and the systemd slice / cgroup settings that enforce them.

Six classes, from most to least protected:

    critical_safety   safety gateway, motor controller, sensor manager, hardware manager
    navigation        ROS 2 runtime: localisation, planning, costmaps, collision avoidance
    perception        detectors, cameras beyond the safety sensors
    ai_reasoning      onboard language and planning models
    background        telemetry upload, remote gateway, this monitor
    maintenance       updates, analytics, log compaction

Critical safety work is protected by construction: it gets the highest CPU
and IO weight, the lowest nice value, a memory floor, an OOM score that keeps
the kernel from choosing it, and no CPU quota or memory ceiling at all. An
override that would weaken any of that is refused (ValueError), and so is any
recovery action that names a protected class. Navigation is never shed
either: collision avoidance lives there.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from enum import Enum
from typing import Any


class WorkloadClass(str, Enum):
    CRITICAL_SAFETY = "critical_safety"
    NAVIGATION = "navigation"
    PERCEPTION = "perception"
    AI_REASONING = "ai_reasoning"
    BACKGROUND = "background"
    MAINTENANCE = "maintenance"


ORDER = [c for c in WorkloadClass]


@dataclass(frozen=True)
class WorkloadSpec:
    cls: WorkloadClass
    description: str
    slice: str
    # Never throttled, shed or offloaded by any policy.
    protected: bool
    # A recovery policy may lower this class's CPU quota for a while.
    sheddable: bool
    nice: int
    cpu_weight: int
    io_weight: int
    cpu_quota_pct: int | None = None
    shed_cpu_quota_pct: int | None = None
    memory_min_mb: int | None = None
    memory_high_mb: int | None = None
    oom_score_adjust: int = 0

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["cls"] = self.cls.value
        return data


DEFAULT_SPECS: dict[WorkloadClass, WorkloadSpec] = {
    WorkloadClass.CRITICAL_SAFETY: WorkloadSpec(WorkloadClass.CRITICAL_SAFETY, "Critical control and safety (protected)", "hannah-critical.slice", protected=True, sheddable=False, nice=-10, cpu_weight=1000, io_weight=1000, memory_min_mb=256, oom_score_adjust=-900),
    WorkloadClass.NAVIGATION: WorkloadSpec(WorkloadClass.NAVIGATION, "Navigation, localisation and collision avoidance (protected)", "hannah-navigation.slice", protected=True, sheddable=False, nice=-5, cpu_weight=500, io_weight=500, memory_min_mb=256, oom_score_adjust=-500),
    WorkloadClass.PERCEPTION: WorkloadSpec(WorkloadClass.PERCEPTION, "Optional perception (detectors beyond the safety sensors)", "hannah-perception.slice", protected=False, sheddable=True, nice=0, cpu_weight=200, io_weight=200, cpu_quota_pct=300, shed_cpu_quota_pct=100, memory_high_mb=2048),
    WorkloadClass.AI_REASONING: WorkloadSpec(WorkloadClass.AI_REASONING, "Onboard AI reasoning", "hannah-ai.slice", protected=False, sheddable=True, nice=5, cpu_weight=100, io_weight=100, cpu_quota_pct=200, shed_cpu_quota_pct=50, memory_high_mb=4096, oom_score_adjust=300),
    WorkloadClass.BACKGROUND: WorkloadSpec(WorkloadClass.BACKGROUND, "Background: telemetry, remote gateway, monitoring", "hannah-background.slice", protected=False, sheddable=True, nice=10, cpu_weight=50, io_weight=50, cpu_quota_pct=100, shed_cpu_quota_pct=25, memory_high_mb=512, oom_score_adjust=500),
    WorkloadClass.MAINTENANCE: WorkloadSpec(WorkloadClass.MAINTENANCE, "Maintenance and analytics: updates, log compaction", "hannah-maintenance.slice", protected=False, sheddable=True, nice=15, cpu_weight=20, io_weight=20, cpu_quota_pct=50, shed_cpu_quota_pct=10, memory_high_mb=512, oom_score_adjust=700),
}

DEFAULT_ASSIGNMENTS: dict[str, WorkloadClass] = {
    "safety-gateway": WorkloadClass.CRITICAL_SAFETY,
    "motor-controller": WorkloadClass.CRITICAL_SAFETY,
    "sensor-manager": WorkloadClass.CRITICAL_SAFETY,
    "hardware-manager": WorkloadClass.CRITICAL_SAFETY,
    "ros2-runtime": WorkloadClass.NAVIGATION,
    "perception": WorkloadClass.PERCEPTION,
    "ai-runtime": WorkloadClass.AI_REASONING,
    "telemetry": WorkloadClass.BACKGROUND,
    "remote-gateway": WorkloadClass.BACKGROUND,
    "edge-resources": WorkloadClass.BACKGROUND,
    "update-manager": WorkloadClass.MAINTENANCE,
}

# Services that must always be critical, whatever an assignment file says.
ALWAYS_CRITICAL = {"safety-gateway", "motor-controller", "sensor-manager", "hardware-manager"}
TUNABLE = {"nice", "cpu_weight", "io_weight", "cpu_quota_pct", "shed_cpu_quota_pct", "memory_high_mb"}


def validate_specs(specs: dict[WorkloadClass, WorkloadSpec]) -> list[str]:
    """Every rule that keeps critical safety work first. An empty list means valid."""
    errors: list[str] = []
    crit = specs.get(WorkloadClass.CRITICAL_SAFETY)
    if crit is None:
        return ["the critical_safety class is missing"]
    if not crit.protected or crit.sheddable:
        errors.append("critical_safety must be protected and never sheddable")
    if crit.cpu_quota_pct is not None or crit.shed_cpu_quota_pct is not None:
        errors.append("critical_safety must have no CPU quota")
    if crit.memory_high_mb is not None:
        errors.append("critical_safety must have no memory ceiling")
    if not crit.memory_min_mb:
        errors.append("critical_safety must keep a memory floor")
    if crit.oom_score_adjust > -500:
        errors.append("critical_safety must be shielded from the OOM killer")
    nav = specs.get(WorkloadClass.NAVIGATION)
    if nav is None or not nav.protected or nav.sheddable or nav.cpu_quota_pct is not None:
        errors.append("navigation (collision avoidance) must be protected, unsheddable and without a CPU quota")
    for cls, spec in specs.items():
        if cls is WorkloadClass.CRITICAL_SAFETY:
            continue
        if spec.nice <= crit.nice:
            errors.append(f"{cls.value} must have a higher nice value than critical_safety")
        if spec.cpu_weight >= crit.cpu_weight or spec.io_weight >= crit.io_weight:
            errors.append(f"{cls.value} must weigh less than critical_safety")
        if spec.oom_score_adjust <= crit.oom_score_adjust:
            errors.append(f"{cls.value} must be a likelier OOM target than critical_safety")
        if spec.sheddable and spec.protected:
            errors.append(f"{cls.value} can't be both protected and sheddable")
    return errors


def apply_overrides(overrides: dict[str, Any] | None, base: dict[WorkloadClass, WorkloadSpec] | None = None) -> dict[WorkloadClass, WorkloadSpec]:
    """Operator tuning of the non-protected classes. Anything that touches a protected class is refused."""
    specs = dict(base or DEFAULT_SPECS)
    for name, changes in (overrides or {}).items():
        try:
            cls = WorkloadClass(name)
        except ValueError as error:
            raise ValueError(f"unknown workload class: {name}") from error
        if specs[cls].protected:
            raise ValueError(f"{name} is protected; its scheduling can't be changed by configuration")
        if not isinstance(changes, dict):
            raise ValueError(f"{name}: overrides must be an object")
        unknown = set(changes) - TUNABLE
        if unknown:
            raise ValueError(f"{name}: can't set {', '.join(sorted(unknown))}")
        specs[cls] = replace(specs[cls], **changes)
    errors = validate_specs(specs)
    if errors:
        raise ValueError("; ".join(errors))
    return specs


def assignments(extra: dict[str, str] | None = None) -> dict[str, WorkloadClass]:
    out = dict(DEFAULT_ASSIGNMENTS)
    for service, name in (extra or {}).items():
        cls = WorkloadClass(name)
        if service in ALWAYS_CRITICAL and cls is not WorkloadClass.CRITICAL_SAFETY:
            raise ValueError(f"{service} is a safety service and always runs as critical_safety")
        out[service] = cls
    return out


# ---------------------------------------------------------------- generation
def _slice_unit(spec: WorkloadSpec) -> str:
    lines = [
        "# Generated by hannah-robot-os resources units. Do not edit; change the config and regenerate.",
        "[Unit]",
        f"Description=HANNAH Robot OS: {spec.description}",
        "Before=slices.target",
        "",
        "[Slice]",
        f"CPUWeight={spec.cpu_weight}",
        f"IOWeight={spec.io_weight}",
    ]
    if spec.cpu_quota_pct is not None:
        lines.append(f"CPUQuota={spec.cpu_quota_pct}%")
    if spec.memory_min_mb:
        lines.append(f"MemoryMin={spec.memory_min_mb}M")
    if spec.memory_high_mb:
        lines.append(f"MemoryHigh={spec.memory_high_mb}M")
    return "\n".join(lines) + "\n"


def _service_dropin(service: str, spec: WorkloadSpec) -> str:
    lines = [
        "# Generated by hannah-robot-os resources units. Do not edit; change the config and regenerate.",
        "[Service]",
        f"Slice={spec.slice}",
        f"Nice={spec.nice}",
        f"OOMScoreAdjust={spec.oom_score_adjust}",
    ]
    if spec.protected:
        # systemd-oomd must never pick a protected unit.
        lines.append("ManagedOOMPreference=omit")
    return "\n".join(lines) + "\n"


def generate_units(specs: dict[WorkloadClass, WorkloadSpec] | None = None, services: dict[str, WorkloadClass] | None = None) -> dict[str, str]:
    """systemd files: one slice per class and a drop-in per service. Paths are relative to /etc/systemd/system."""
    specs = specs or DEFAULT_SPECS
    errors = validate_specs(specs)
    if errors:
        raise ValueError("; ".join(errors))
    services = services or DEFAULT_ASSIGNMENTS
    files = {
        "hannah.slice": "# Generated by hannah-robot-os resources units.\n[Unit]\nDescription=HANNAH Robot OS workloads\nBefore=slices.target\n",
    }
    for cls in ORDER:
        files[specs[cls].slice] = _slice_unit(specs[cls])
    for service, cls in sorted(services.items()):
        files[f"hannah-{service}.service.d/10-hannah-resources.conf"] = _service_dropin(service, specs[cls])
    return files


def cgroup_settings(spec: WorkloadSpec, period_us: int = 100_000, shed: bool = False) -> dict[str, str]:
    """The same limits as raw cgroup v2 files, for hosts that don't run systemd."""
    quota = spec.shed_cpu_quota_pct if shed and spec.sheddable and spec.shed_cpu_quota_pct is not None else spec.cpu_quota_pct
    if spec.protected:
        quota = None
    return {
        "cpu.weight": str(spec.cpu_weight),
        "io.weight": f"default {spec.io_weight}",
        "cpu.max": f"{int(period_us * quota / 100)} {period_us}" if quota is not None else f"max {period_us}",
        "memory.min": str((spec.memory_min_mb or 0) * 1048576),
        "memory.high": str(spec.memory_high_mb * 1048576) if spec.memory_high_mb and not spec.protected else "max",
    }
