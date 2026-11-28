"""Maintenance features from the motor controllers' own feedback.

Each tick the motor-controller service hands this window the ControllerStatus
of every controller. The window keeps, per controller and wheel, running
statistics (count, mean, min, max, standard deviation, last) of what the
driver actually reported in ControllerStatus.details (temperatures, currents,
supply voltage) and one derived value: the encoder disagreement, the
difference between the speed implied by the encoder positions and the speed
the controller reports. Nothing is estimated: a value the driver didn't
report is absent, not zero.

Every `window_ms` the window is closed into a payload for the parent HANNAH
(a "telemetry" bridge envelope with payload.maintenance), where predictive
maintenance turns it into series and baselines (server/maintenance/features.js).
Controller faults the drivers reported (not link faults) are listed as fault
codes: the only automatic route to a "confirmed fault" on the parent.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from ..motors.base import ControllerStatus
from ..motors.drivers.base import is_link_fault

# ControllerStatus.details keys a driver may report, and the name sent to HANNAH.
DETAIL_KEYS = {
    "temp_motor_c": "temperature_c",
    "temperature_c": "temperature_c",
    "temp_fet_c": "temp_fet_c",
    "motor_current_a": "current_a",
    "current_a": "current_a",
    "input_voltage_v": "input_voltage_v",
    "error_count": "error_count",
}
SIDES = ("left", "right")


@dataclass
class _Stats:
    n: int = 0
    mean: float = 0.0
    m2: float = 0.0
    min: float = math.inf
    max: float = -math.inf
    last: float = 0.0

    def add(self, value: float) -> None:
        self.n += 1
        delta = value - self.mean
        self.mean += delta / self.n
        self.m2 += delta * (value - self.mean)
        self.min = min(self.min, value)
        self.max = max(self.max, value)
        self.last = value

    def to_dict(self) -> dict[str, float]:
        std = math.sqrt(self.m2 / (self.n - 1)) if self.n > 1 else 0.0
        return {"n": self.n, "mean": round(self.mean, 4), "min": round(self.min, 4), "max": round(self.max, 4), "std": round(std, 4), "last": round(self.last, 4)}


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


@dataclass
class MaintenanceFeatureWindow:
    window_ms: int = 60_000
    simulated: bool = False
    _started_ms: int | None = None
    _stats: dict[str, dict[str, _Stats]] = field(default_factory=dict)
    _previous: dict[str, tuple[int, float | None, float | None]] = field(default_factory=dict)
    _faults: dict[tuple[str, str], int] = field(default_factory=dict)

    def _add(self, target: str, metric: str, value: Any) -> None:
        if _finite(value):
            self._stats.setdefault(target, {}).setdefault(metric, _Stats()).add(float(value))

    def add(self, status: ControllerStatus, now_ms: int) -> None:
        if self._started_ms is None:
            self._started_ms = now_ms
        cid = status.controller_id
        for key, metric in DETAIL_KEYS.items():
            value = (status.details or {}).get(key)
            if isinstance(value, (list, tuple)) and len(value) == 2:
                for side, item in zip(SIDES, value):
                    self._add(f"{cid}-{side}", metric, item)
            else:
                self._add(cid, metric, value)
        # Encoder disagreement: speed from encoder positions against the reported wheel speed.
        previous = self._previous.get(cid)
        if previous and status.last_feedback_ms and status.last_feedback_ms > previous[0]:
            dt = (status.last_feedback_ms - previous[0]) / 1000.0
            for side, now_pos, then_pos, speed in (("left", status.encoder_left, previous[1], status.velocity_left_mps), ("right", status.encoder_right, previous[2], status.velocity_right_mps)):
                if _finite(now_pos) and _finite(then_pos) and _finite(speed) and dt > 0:
                    self._add(f"{cid}-{side}", "encoder_residual_mps", abs((now_pos - then_pos) / dt - speed))
        if status.last_feedback_ms:
            self._previous[cid] = (status.last_feedback_ms, status.encoder_left, status.encoder_right)
        if status.fault and not is_link_fault(status.fault):
            self._faults[(cid, status.fault)] = now_ms

    def due(self, now_ms: int) -> bool:
        return self._started_ms is not None and now_ms - self._started_ms >= self.window_ms

    def close(self, now_ms: int) -> dict[str, Any] | None:
        """The window as a payload, or None when nothing was measured. Starts a new window."""
        if not self._stats and not self._faults:
            self._started_ms = None
            return None
        payload = {
            "window_ms": now_ms - (self._started_ms or now_ms),
            "simulated": self.simulated,
            "controllers": {target: {metric: stats.to_dict() for metric, stats in metrics.items()} for target, metrics in self._stats.items()},
            "fault_codes": [{"controller_id": cid, "fault": fault, "at_ms": at} for (cid, fault), at in self._faults.items()],
        }
        self._stats, self._faults, self._started_ms = {}, {}, None
        return payload
