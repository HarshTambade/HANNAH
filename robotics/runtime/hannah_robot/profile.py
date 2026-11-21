"""A robot's profile: the file on the robot that says what it is and what its limits are.

The limits in this file are the ones the runtime enforces. HANNAH's server
receives a copy and may be stricter; it can't change this file.
"""
from __future__ import annotations

import json
import os
import platform
import socket

from . import PROTOCOL, __version__
from .hal.base import RobotAdapter
from .safety import LocalSafety

DEFAULT_PROFILE = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "profiles", "sim-diffdrive.json"))


class ProfileError(Exception):
    pass


def load_profile(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            profile = json.load(handle)
    except OSError as error:
        raise ProfileError(f"The profile {path} can't be read ({type(error).__name__}).") from None
    except ValueError:
        raise ProfileError(f"The profile {path} isn't valid JSON.") from None
    if profile.get("adapter") not in ("kinematic", "ros2"):
        raise ProfileError("The profile's adapter must be 'kinematic' or 'ros2'.")
    profile["_dir"] = os.path.dirname(os.path.abspath(path))
    return profile


def _world(profile: dict) -> dict:
    reference = profile.get("world")
    if isinstance(reference, dict):
        return reference
    if not reference:
        raise ProfileError("The profile names no world file.")
    path = reference if os.path.isabs(reference) else os.path.join(profile["_dir"], reference)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        raise ProfileError(f"The world file {path} can't be read.") from None


def build_adapter(profile: dict, sim_speed: float = 1.0, state_dir: str | None = None) -> RobotAdapter:
    if profile["adapter"] == "kinematic":
        from .hal.kinematic import KinematicSimAdapter
        world = _world(profile)
        limits = dict(profile.get("limits") or {})
        limits.setdefault("keepOut", world.get("keepOut", []))
        return KinematicSimAdapter(world, limits, profile.get("robot"), profile.get("simulation"), time_factor=sim_speed, inputs_path=os.path.join(state_dir, "sim-inputs.json") if state_dir else None)
    from .hal.ros2 import Ros2Adapter  # needs a sourced ROS 2 environment
    return Ros2Adapter(profile)


def descriptor(profile: dict, adapter: RobotAdapter) -> dict:
    """What the robot tells HANNAH about itself at enrollment."""
    described = adapter.describe()
    identity = profile.get("identity") or {}
    return {
        "manufacturer": identity.get("manufacturer", ""), "model": identity.get("model", ""),
        "os": identity.get("os") or f"{platform.system()} {platform.release()}", "compute": identity.get("compute") or platform.machine(),
        "softwareVersion": identity.get("softwareVersion", ""), "firmwareVersion": identity.get("firmwareVersion", ""),
        "rosDistro": described.get("rosDistro") or identity.get("rosDistro", ""),
        "runtimeVersion": __version__, "adapter": adapter.name, "hostname": socket.gethostname()[:80],
        **{key: described.get(key) for key in ("robotType", "protocols", "sensors", "actuators", "devices", "capabilities", "places", "dock", "world", "limits", "simulation")},
        "protocols": described.get("protocols") or [PROTOCOL],
    }


def local_safety(adapter: RobotAdapter) -> LocalSafety:
    described = adapter.describe()
    return LocalSafety(described["limits"], described["capabilities"], described.get("world"), described["limits"].get("robotRadius", 0.2), described.get("devices"), described.get("dock"))
