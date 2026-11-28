"""Restarting Robot OS services, and reloading a validated configuration.

Only services that take no part in motion or safety may be restarted
remotely. The parent HANNAH keeps the same list (server/diagnostics/recovery.js);
this one is the robot's own and is what counts: a signed, approved command
naming another service is refused here.

The restart goes through the init system (systemd: `systemctl restart
hannah-<name>.service`). The runner is injectable so tests never touch the
host's services. On a disk image the unprivileged service account needs a
polkit rule (or sudoers entry) allowing exactly these units; without it the
restart fails and the command is answered as failed.

A configuration reload validates the file first (it must load as a
RobotOSConfig) and refuses when its safety section differs from the running
one: speed, acceleration, command expiry and watchdog limits change only by
commissioning and a restart of the safety services by a person, never as a
remote recovery.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol, Sequence

from ..common import AuditLog
from ..config import RobotOSConfig

RESTARTABLE_SERVICES = frozenset({"telemetry", "update-manager", "ai-runtime", "remote-gateway"})
CRITICAL_SERVICES = frozenset({"safety-gateway", "motor-controller", "hardware-manager", "sensor-manager", "ros2-runtime"})


class ServiceManager(Protocol):
    def restart(self, name: str) -> tuple[bool, str]: ...


def _run(argv: Sequence[str]) -> tuple[int, str]:
    done = subprocess.run(list(argv), capture_output=True, text=True, timeout=30, check=False)
    return done.returncode, (done.stderr or done.stdout or "").strip()[:300]


@dataclass
class SystemdServiceManager:
    """Restarts hannah-<name>.service through systemctl. `runner` is replaced in tests."""

    runner: Callable[[Sequence[str]], tuple[int, str]] = _run
    unit_prefix: str = "hannah-"

    def restart(self, name: str) -> tuple[bool, str]:
        if name not in RESTARTABLE_SERVICES:
            return False, f"{name} is not restartable remotely"
        try:
            code, output = self.runner(["systemctl", "restart", "--no-block", f"{self.unit_prefix}{name}.service"])
        except (OSError, subprocess.SubprocessError) as error:
            return False, f"service manager unavailable: {type(error).__name__}"
        return (True, "restart requested") if code == 0 else (False, f"systemctl exited {code}: {output}")


def check_restart(name: str) -> tuple[bool, str]:
    """The robot's own rule, before anything is asked of the service manager."""
    if name in CRITICAL_SERVICES:
        return False, f"{name} carries motion or safety; it is never restarted remotely"
    if name not in RESTARTABLE_SERVICES:
        return False, f"unknown or non-restartable service: {name or '(none)'}"
    return True, "allowed"


@dataclass
class ConfigReloader:
    """Validate the configuration file; apply it to the non-critical services only."""

    config_path: Path
    running: RobotOSConfig
    services: ServiceManager
    audit: AuditLog
    applies_to: tuple[str, ...] = ("telemetry", "ai-runtime", "remote-gateway")
    _last: dict = field(default_factory=dict)

    def reload(self) -> tuple[bool, str]:
        try:
            candidate = RobotOSConfig.load(self.config_path)
        except (OSError, ValueError, TypeError) as error:
            self.audit.emit("config", "reload_refused", severity="warning", reason=f"invalid: {type(error).__name__}")
            return False, f"configuration invalid: {type(error).__name__}"
        if candidate.safety.__dict__ != self.running.safety.__dict__:
            self.audit.emit("config", "reload_refused", severity="warning", reason="safety section changed")
            return False, "safety settings differ from the running ones; they change only through commissioning"
        if candidate.robot_id != self.running.robot_id:
            return False, "the file names another robot"
        if list(candidate.required_services) != list(self.running.required_services):
            return False, "required services differ; that needs a restart by a person"
        failed = []
        for name in self.applies_to:
            ok, reason = self.services.restart(name)
            if not ok:
                failed.append(f"{name}: {reason}")
        if failed:
            self.audit.emit("config", "reload_partial", severity="warning", failed=failed)
            return False, "configuration valid; restart failed for " + "; ".join(failed)
        self.running = candidate
        self.audit.emit("config", "reloaded", services=list(self.applies_to))
        return True, f"configuration validated and applied to {', '.join(self.applies_to)}"
