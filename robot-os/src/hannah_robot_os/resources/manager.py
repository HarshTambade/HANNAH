"""The Edge Resource Manager: sample, evaluate, respond, remember, report.

Each tick takes one real snapshot (metrics.ResourceProbe), evaluates it
(policy.evaluate), decides the predefined responses (policy.decide) and, when
the operator turned enforcement on, applies the quota changes through
systemd. With enforcement off (the default) the actions are recorded as
recommendations and nothing on the robot changes.

History is kept on disk as JSON lines with a bounded length, and the latest
report is written beside it so the robotics runtime can forward it to HANNAH
over its signed link. The same report can go out as a Robot OS bridge
telemetry envelope.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..common import AuditLog, new_id, now_ms
from ..network.bridge import BridgeEnvelope
from .metrics import SCHEMA, ResourceProbe
from .policy import PolicyConfig, Thresholds, check_action, decide, evaluate
from .workloads import DEFAULT_ASSIGNMENTS, DEFAULT_SPECS, WorkloadClass, WorkloadSpec

Executor = Callable[[list[str]], tuple[bool, str]]


def systemctl_executor(cmd: list[str]) -> tuple[bool, str]:
    if not shutil.which("systemctl"):
        return False, "systemctl is not available on this host"
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=10, check=True)
        return True, "applied"
    except (OSError, subprocess.SubprocessError) as error:
        return False, f"{type(error).__name__}"


def quota_commands(action: dict[str, Any], specs: dict[WorkloadClass, WorkloadSpec]) -> list[list[str]]:
    """The only commands any policy runs: runtime CPU quota changes on sheddable slices."""
    out = []
    policy = action.get("policy")
    for name in action.get("targets", []):
        spec = specs[WorkloadClass(name)]
        if spec.protected or not spec.sheddable:
            continue
        if policy == "shed_optional_load":
            quota = action.get("quota_pct", {}).get(name, spec.shed_cpu_quota_pct)
        elif policy == "restore":
            quota = spec.cpu_quota_pct
        else:
            continue
        value = f"CPUQuota={quota}%" if quota is not None else "CPUQuota="
        out.append(["systemctl", "set-property", "--runtime", spec.slice, value])
    return out


@dataclass
class EdgeResourceManager:
    probe: ResourceProbe
    audit: AuditLog = field(default_factory=AuditLog)
    thresholds: Thresholds = field(default_factory=Thresholds)
    config: PolicyConfig = field(default_factory=PolicyConfig)
    specs: dict[WorkloadClass, WorkloadSpec] = field(default_factory=lambda: dict(DEFAULT_SPECS))
    services: dict[str, WorkloadClass] = field(default_factory=lambda: dict(DEFAULT_ASSIGNMENTS))
    state_dir: str | Path | None = None
    history_limit: int = 720
    enforce: bool = False
    executor: Executor = systemctl_executor
    simulated_host: bool = False
    _history: list[dict[str, Any]] = field(default_factory=list)
    _shed: dict[str, Any] | None = None
    _clear_run: int = 0
    _last: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        if self.state_dir:
            self.state_dir = Path(self.state_dir)
            self._history = self._load_history()

    # ------------------------------------------------------------ files
    @property
    def history_path(self) -> Path | None:
        return Path(self.state_dir) / "history.jsonl" if self.state_dir else None

    @property
    def latest_path(self) -> Path | None:
        return Path(self.state_dir) / "latest.json" if self.state_dir else None

    def _load_history(self) -> list[dict[str, Any]]:
        path = self.history_path
        if not path or not path.exists():
            return []
        items = []
        for line in path.read_text(encoding="utf-8").splitlines()[-self.history_limit:]:
            try:
                items.append(json.loads(line))
            except ValueError:
                continue
        return items

    def _persist(self, report: dict[str, Any]) -> None:
        if not self.state_dir:
            return
        Path(self.state_dir).mkdir(parents=True, exist_ok=True)
        lines = [json.dumps(item, separators=(",", ":")) for item in self._history[-self.history_limit:]]
        hist = self.history_path
        tmp = hist.with_name(f".{hist.name}.tmp")
        tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
        os.replace(tmp, hist)
        latest = self.latest_path
        tmp = latest.with_name(f".{latest.name}.tmp")
        tmp.write_text(json.dumps(report), encoding="utf-8")
        os.replace(tmp, latest)

    # ------------------------------------------------------------ tick
    def tick(self) -> dict[str, Any]:
        snapshot = self.probe.sample()
        evaluation = evaluate(snapshot, self.thresholds, [h["snapshot"] for h in self._history if "snapshot" in h])
        actions = decide(evaluation, snapshot, self.config, self.specs)
        shed = next((a for a in actions if a["policy"] == "shed_optional_load"), None)
        if shed:
            self._clear_run = 0
            self._shed = shed
        elif self._shed is not None:
            self._clear_run += 1
            if self._clear_run >= self.thresholds.clear_samples:
                restore = {"policy": "restore", "targets": list(self._shed["targets"]), "reason": f"clear for {self._clear_run} samples"}
                check_action(restore, self.specs)
                actions.append(restore)
                self._shed = None
                self._clear_run = 0
        applied = [self._apply(action) for action in actions]
        report = {
            "schema": SCHEMA,
            "report_id": new_id("res"),
            "reported_at_ms": now_ms(),
            "simulated_host": bool(self.simulated_host),
            "snapshot": snapshot,
            "evaluation": evaluation,
            "actions": applied,
            "enforcement": "applied" if self.enforce else "recommend-only",
            "shed_active": self._shed is not None,
            # What the owner configured on the robot, so HANNAH's advice uses the same rules.
            "policy": {"approved_remote_resources": list(self.config.approved_remote_resources), "reasoning_privacy": self.config.reasoning_privacy},
            "workloads": self.workload_table(),
        }
        for warning in evaluation["warnings"]:
            self.audit.emit("edge-resources", f"{warning['kind']}_{warning['severity']}", severity="warning" if warning["severity"] == "warning" else "error", metric=warning["metric"], value=warning["value"])
        self._history.append({"at": snapshot["measured_at_ms"], "snapshot": snapshot, "status": evaluation["status"], "warnings": evaluation["warnings"]})
        self._history = self._history[-self.history_limit:]
        self._last = report
        self._persist(report)
        return report

    def _apply(self, action: dict[str, Any]) -> dict[str, Any]:
        check_action(action, self.specs)
        commands = quota_commands(action, self.specs)
        out = {**action, "commands": [" ".join(c) for c in commands]}
        if not commands:
            return {**out, "applied": None}
        if not self.enforce:
            return {**out, "applied": False, "detail": "recommend-only: enforcement is off in the Robot OS config"}
        results = [self.executor(cmd) for cmd in commands]
        ok = all(r[0] for r in results)
        self.audit.emit("edge-resources", f"policy_{action['policy']}", severity="warning", targets=action.get("targets", []), ok=ok)
        return {**out, "applied": ok, "detail": "; ".join(r[1] for r in results)}

    def workload_table(self) -> list[dict[str, Any]]:
        rows = []
        for cls in WorkloadClass:
            spec = self.specs[cls]
            rows.append({**spec.to_dict(), "services": sorted(s for s, c in self.services.items() if c is cls), "shed": bool(self._shed and cls.value in self._shed.get("targets", []))})
        return rows

    def history(self, limit: int = 100) -> list[dict[str, Any]]:
        return self._history[-limit:]

    # ------------------------------------------------------------ reporting
    def envelope(self, robot_id: str, report: dict[str, Any] | None = None) -> BridgeEnvelope:
        report = report or self._last or self.tick()
        return BridgeEnvelope(envelope_id=new_id("env"), robot_id=robot_id, ts_ms=now_ms(), kind="telemetry", payload={"type": "edge_resources", "report": report})


def manager_from_config(cfg: Any, root: str = "/", service_status: Callable[[], list[dict[str, Any]]] | None = None, simulated_host: bool = False) -> EdgeResourceManager:
    """Build the manager from RobotOSConfig.resources."""
    from .workloads import apply_overrides, assignments

    res = dict(getattr(cfg, "resources", {}) or {})
    paths = res.get("storage_paths") or ["/", cfg.data_dir]
    probe = ResourceProbe(root=root, storage_paths=[p for p in paths if p], service_status=service_status)
    return EdgeResourceManager(
        probe=probe,
        thresholds=Thresholds.from_dict(res.get("thresholds")),
        config=PolicyConfig.from_dict(res),
        specs=apply_overrides(res.get("workload_overrides")),
        services=assignments(res.get("assignments")),
        state_dir=Path(cfg.data_dir) / "resources",
        history_limit=int(res.get("history_limit", 720)),
        enforce=bool(res.get("enforce", False)),
        simulated_host=simulated_host,
    )
