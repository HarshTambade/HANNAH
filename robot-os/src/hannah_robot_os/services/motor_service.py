"""The motor-controller service's controllers: which driver, and keeping it safe.

With no hardware profile this is the simulated controller, as before. With one,
each `motor_controller` entry is built by motors/factory.py and registered with
the manager, which keeps the ramp, limit and watchdog checks.

Each tick, after the shared safety state has been mirrored:
- unsafe: every controller that has set_estop() gets it (zero speed, motors
  disengaged, held disabled), and the manager stops it;
- safe again: set_estop(False). A controller that is connected, has no fault
  and is not enabled is enabled again, as at start-up. Enabling does not move
  anything: motion needs a new command that passes the safety gateway and
  the manager. A latched stop stays unsafe until an operator reset.
- a controller that is disconnected or faulted is reconnected at most every
  reconnect_interval_ms, only while safe.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..common import AuditLog, now_ms
from ..config import RobotOSConfig
from ..hardware.models import HardwareDevice
from ..hardware.registry import HardwareRegistry
from ..motors.factory import MANUFACTURER, build_from_profile, effective_limits
from ..motors.manager import MotorControllerManager
from ..motors.sim import SimMotorController
from ..profiles.schema import validate_hardware_profile


class ProfileError(ValueError):
    def __init__(self, path: str, errors: list[str]) -> None:
        super().__init__(f"invalid hardware profile {path}: {errors}")
        self.path, self.errors = path, errors


def load_profile(path: str) -> dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ProfileError(path, ["profile must be a JSON object"])
    errors = validate_hardware_profile(data)
    if errors:
        raise ProfileError(path, errors)
    return data


@dataclass
class MotorService:
    audit: AuditLog
    cfg: RobotOSConfig
    hw: HardwareRegistry
    profile_path: str = ""
    reconnect_interval_ms: int = 2000
    clock: Callable[[], int] = now_ms
    build_kwargs: dict[str, Any] = field(default_factory=dict)
    motors: MotorControllerManager | None = None
    controllers: list = field(default_factory=list)
    _was_safe: bool = True
    _last_attempt: dict[str, int] = field(default_factory=dict)

    def setup(self) -> MotorControllerManager:
        profile = load_profile(self.profile_path) if self.profile_path else None
        limits = effective_limits(self.cfg.safety, profile)
        self.motors = MotorControllerManager(audit=self.audit, limits=limits)
        if profile is None:
            self.controllers = [SimMotorController(controller_id="sim-motor-1")]
        else:
            self.controllers = build_from_profile(profile, limits, **self.build_kwargs)
        entries = {e["controller_id"]: e for e in (profile or {}).get("controllers", [])}
        for ctrl in self.controllers:
            self.motors.register_controller(ctrl)
            entry = entries.get(ctrl.controller_id, {})
            driver = entry.get("driver", "sim")
            self.hw.register(HardwareDevice(
                device_id=ctrl.controller_id, kind="motor_controller",
                manufacturer=MANUFACTURER.get(driver, "HANNAH"), model=entry.get("model", "SIM-MC" if driver == "sim" else driver),
                interface=entry.get("interface", "sim"), driver=driver, capabilities=list(entry.get("capabilities", [])),
            ))
            self._bring_up(ctrl.controller_id)
        self.audit.emit("motor-controller", "controllers_configured", profile=self.profile_path or None,
                        controllers=[c.controller_id for c in self.controllers])
        return self.motors

    def _bring_up(self, cid: str) -> None:
        assert self.motors is not None
        self._last_attempt[cid] = self.clock()
        try:
            self.motors.connect(cid)
            self.motors.enable(cid, True)
        except Exception as error:
            self.audit.emit("motor-controller", "controller_unavailable", severity="error", controller_id=cid, error=str(error))

    def tick(self, safe: bool, reason: str = "") -> None:
        assert self.motors is not None
        for ctrl in self.controllers:
            cid = ctrl.controller_id
            set_estop = getattr(ctrl, "set_estop", None)
            if not safe:
                if set_estop and self._was_safe:
                    set_estop(True)
                st = self.motors.status(cid)
                # Stop on the change to unsafe, then again only if something still turns.
                if self._was_safe or (st.velocity_left_mps or 0) or (st.velocity_right_mps or 0):
                    self.motors.stop(cid, reason=f"safety: {reason}")
            else:
                if set_estop and not self._was_safe:
                    set_estop(False)
                self._recover(cid)
            self.motors.watchdog_check(cid)
        self._was_safe = safe

    def _recover(self, cid: str) -> None:
        assert self.motors is not None
        st = self.motors.status(cid)
        if not st.connected or st.fault:
            if self.clock() - self._last_attempt.get(cid, 0) >= self.reconnect_interval_ms:
                self.audit.emit("motor-controller", "controller_reconnecting", severity="warning", controller_id=cid, fault=st.fault)
                self._bring_up(cid)
            return
        if not st.enabled and not st.estop_active:
            try:
                self.motors.enable(cid, True)
                self.audit.emit("motor-controller", "controller_reenabled", controller_id=cid)
            except Exception as error:
                self.audit.emit("motor-controller", "controller_enable_failed", severity="error", controller_id=cid, error=str(error))
