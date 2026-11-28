"""Operating modes, robot side: the same table the server enforces, enforced again here.

The server keeps a robot's operating mode and sends it as a signed command.
The runtime keeps its own copy and refuses any command its current mode does
not allow, and any change of mode the table does not allow, whatever the
server sent. So a server that is wrong, out of date or compromised still
cannot send a mission to a robot in Manual or Safety Stop.

These are software states. Safety Stop is reached through the runtime's own
hold (and on Robot OS, the latched software stop); it does not replace the
robot's emergency stop circuit, which works with this program stopped.
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

TELEOP_MODES = frozenset({"manual", "assisted", "maintenance"})
MAINTENANCE_SPEED = {"linear": 0.2, "angular": 0.5}

STOP = frozenset({"stop_motion"})
OBSERVE = frozenset({"capture_image", "report_robot_state", "read_sensor", "report_surroundings", "report_battery_state"})
ACTUATE = frozenset({"set_supported_device_state"})


def default_mode(simulated: bool) -> str:
    return "mission" if simulated else "supervised"


def command_class(capability: str) -> str:
    if capability in STOP:
        return "stop"
    if capability in OBSERVE:
        return "observe"
    if capability in ACTUATE:
        return "actuate"
    return "motion"


def refusal(mode: str, capability: str, origin: str | None = None) -> str:
    """Why this mode doesn't take this command, or "" when it does. `origin` is where the server says it came from."""
    kind = command_class(capability)
    if mode not in MODES:
        return "the robot's operating mode is unknown"
    if kind in ("stop", "observe"):
        return ""
    if mode == "safety_stop":
        return "the robot is in Safety Stop: only stopping and reading"
    if kind == "actuate":
        return "the robot is in Manual mode" if mode == "manual" else ""
    if mode == "manual":
        return "the robot is in Manual mode: only an operator's manual control"
    if mode == "maintenance":
        return "the robot is in Maintenance mode: no missions"
    if mode == "assisted" and origin not in ("person",):
        return "the robot is in Assisted mode: only a person on the Robots screen may send it a mission"
    if mode == "supervised" and origin == "plan":
        return "the robot is in Supervised Autonomy: plans don't run"
    return ""


def transition_refusal(current: str, target: str) -> str:
    if target not in MODES:
        return f"there is no operating mode called {target!r}"
    if target == current:
        return ""
    if target not in TRANSITIONS.get(current, ()):
        return f"{current} can't change straight to {target}"
    return ""


__all__ = ["MAINTENANCE_SPEED", "MODES", "TELEOP_MODES", "TRANSITIONS", "command_class", "default_mode", "refusal", "transition_refusal"]
