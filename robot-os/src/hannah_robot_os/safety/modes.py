"""Operating modes on Robot OS: the same table HANNAH's server and robot runtime use.

The safety gateway holds the robot's operating mode, publishes it with the
rest of its state (shared.py) so every service process follows it, and checks
each motor command's source against it:

  safety_stop   no motion at all. Entering it engages the gateway's latched
                software stop; leaving it needs an operator, a released stop
                input, and the latch reset (the existing reset path).
  manual        only an operator's manual control (source "teleop").
  assisted      manual control, and the navigation stack.
  supervised,
  mission       the navigation stack; no manual control.
  maintenance   only slow manual jogging (MAINTENANCE_SPEED).

These are software states on a general-purpose computer, not a safety
function: the hardware emergency stop circuit stays independent of them.
"""
from __future__ import annotations

MODES = ("manual", "assisted", "supervised", "mission", "maintenance", "safety_stop")

TRANSITIONS = {
    "manual": ("assisted", "supervised", "maintenance", "safety_stop"),
    "assisted": ("manual", "supervised", "maintenance", "safety_stop"),
    "supervised": ("manual", "assisted", "mission", "maintenance", "safety_stop"),
    "mission": ("supervised", "manual", "safety_stop"),
    "maintenance": ("manual", "safety_stop"),
    "safety_stop": ("manual", "maintenance"),
}

DEFAULT_MODE = "supervised"  # Robot OS runs on physical hardware
TELEOP_SOURCES = frozenset({"teleop"})
MAINTENANCE_SPEED = {"linear": 0.2, "angular": 0.5}


def transition_refusal(current: str, target: str) -> str:
    if target not in MODES:
        return f"unknown operating mode {target!r}"
    if target == current:
        return "already in that mode"
    if target not in TRANSITIONS.get(current, ()):
        return f"{current} can't change straight to {target}"
    return ""


def motion_refusal(mode: str, source: str, linear: float = 0.0, angular: float = 0.0) -> str:
    """Why a motor command from `source` may not run in `mode`, or "" when it may."""
    manual = source in TELEOP_SOURCES
    if mode not in MODES:
        return "unknown operating mode"
    if mode == "safety_stop":
        return "safety stop: no motion"
    if mode == "manual" and not manual:
        return "manual mode: only an operator's manual control"
    if mode in ("supervised", "mission") and manual:
        return f"{mode} mode: no manual control"
    if mode == "maintenance":
        if not manual:
            return "maintenance mode: no autonomous motion"
        if abs(linear) > MAINTENANCE_SPEED["linear"] + 1e-9 or abs(angular) > MAINTENANCE_SPEED["angular"] + 1e-9:
            return "maintenance mode: faster than jogging speed"
    return ""
