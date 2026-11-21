"""`python3 -m hannah_robot doctor`: is this robot's computer ready to run the runtime?

It checks what can be checked without touching the robot or its account: the
Python version, the profile, the limits the runtime will enforce, the state
directory and the credentials file's permissions, the server address, that
the server answers, and that this computer's clock is close enough to the
server's for signed requests and expiring commands to work.

It does not move anything, does not start the adapter, and does not make a
signed request: a signed request would use up a request number that a running
runtime needs. So "everything ok" means "ready to start", not "connected".
"""
from __future__ import annotations

import email.utils
import importlib.util
import json
import os
import stat
import sys
import time
import urllib.error
import urllib.request

from .link import LinkError, check_server_url
from .profile import ProfileError, build_adapter, load_profile
from .protocol import fingerprint

HEALTH_PATH = "/api/health"
SKEW_LIMIT_S = 60.0   # the server refuses a request whose time is further off than this
SKEW_WARN_S = 20.0


def http_date(url: str, timeout: float = 5.0):
    """GET a URL; return (status, the server's clock as epoch seconds or None)."""
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": "hannah-robot-doctor"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        stamp = response.headers.get("Date")
        when = email.utils.parsedate_to_datetime(stamp).timestamp() if stamp else None
        return response.status, when


def checks(profile_path: str, state_dir: str, allow_insecure: bool = False, fetch=http_date, clock=time.time) -> list[dict]:
    """Every check as {id, ok, message}. ok is True, False, or None for a warning."""
    found = []

    def add(name: str, ok, message: str) -> None:
        found.append({"id": name, "ok": ok, "message": message})

    add("python", sys.version_info >= (3, 9), f"Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}" + ("" if sys.version_info >= (3, 9) else "; the runtime needs 3.9 or newer"))

    profile = None
    try:
        profile = load_profile(profile_path)
        add("profile", True, f"{profile_path}: adapter '{profile['adapter']}'")
    except ProfileError as error:
        add("profile", False, str(error))
    if profile is not None:
        if profile["adapter"] == "ros2" and importlib.util.find_spec("rclpy") is None:
            add("ros", False, "The ROS 2 adapter needs rclpy, which isn't importable. Source your ROS 2 environment first (for example: source /opt/ros/jazzy/setup.bash).")
        else:
            try:
                described = build_adapter(profile).describe()
                kind = (described.get("simulation") or {}).get("kind")
                add("kind", True, f"A SIMULATION ({kind}). Nothing physical will move." if kind else "A PHYSICAL robot. It must be commissioned in HANNAH before it may move, and it needs its own hardware emergency stop.")
                limits = described.get("limits") or {}
                missing = [key for key in ("linkTimeoutS", "commandTtlS") if not isinstance(limits.get(key), (int, float))]
                if any(name in described.get("capabilities", []) for name in ("navigate_to", "return_to_dock", "inspect_area")) and not isinstance(limits.get("maxLinearSpeed"), (int, float)):
                    missing.append("maxLinearSpeed")
                if not (limits.get("workspace") or {}).get("polygon"):
                    missing.append("workspace")
                add("limits", not missing, "The profile gives the limits the runtime enforces: " + ", ".join(f"{key} {limits[key]}" for key in ("maxLinearSpeed", "maxJointSpeed", "linkTimeoutS", "commandTtlS") if key in limits) + "." if not missing else f"The profile is missing: {', '.join(missing)}. HANNAH won't move a robot without them.")
                if not kind and not (limits.get("estop") or {}).get("hardware"):
                    add("estop", None, "The profile doesn't declare a hardware emergency stop. HANNAH's Stop is a software request and is not one.")
            except Exception as error:  # noqa: BLE001 - whatever stops the adapter being built is the finding
                add("adapter", False, f"The adapter can't be set up from this profile ({type(error).__name__}: {error}).")

    credentials = None
    path = os.path.join(state_dir, "credentials.json")
    try:
        mode = stat.S_IMODE(os.stat(state_dir).st_mode)
        add("state-dir", None if mode & 0o077 else True, f"{state_dir}" + (f" is accessible to other users (mode {mode:o}). Run: chmod 700 {state_dir}" if mode & 0o077 else " is private to this user"))
    except OSError:
        add("state-dir", False, f"{state_dir} doesn't exist. Enroll first.")
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
        with open(path, "r", encoding="utf-8") as handle:
            credentials = json.load(handle)
        if not all(isinstance(credentials.get(key), str) and credentials.get(key) for key in ("server", "robotId", "secret")):
            credentials = None
            add("credentials", False, f"{path} is incomplete. Enroll again with a new code.")
        elif mode & 0o077:
            add("credentials", False, f"{path} holds this robot's secret and is readable by other users (mode {mode:o}). Run: chmod 600 {path}")
        else:
            add("credentials", True, f"Enrolled as {credentials['robotId']}. Fingerprint {fingerprint(credentials['secret'])}: it must match the one HANNAH shows for this robot.")
    except FileNotFoundError:
        add("credentials", False, "This robot isn't enrolled. Run: python3 -m hannah_robot enroll --server … --code …")
    except (OSError, ValueError):
        add("credentials", False, f"{path} can't be read. Enroll again with a new code.")

    if credentials is not None:
        try:
            server = check_server_url(credentials["server"], allow_insecure)
            add("server-address", True, server)
        except LinkError as error:
            server = None
            add("server-address", False, str(error))
        if server is not None:
            try:
                status, server_time = fetch(server + HEALTH_PATH, 5.0)
                add("server", status == 200, f"{server} answered" if status == 200 else f"{server} answered with status {status}")
                if server_time is None:
                    add("clock", None, "The server sent no time, so this computer's clock couldn't be compared with it.")
                else:
                    skew = abs(clock() - server_time)
                    add("clock", False if skew > SKEW_LIMIT_S else None if skew > SKEW_WARN_S else True,
                        f"This computer's clock is {skew:.0f} s from the server's. " + ("Signed requests are refused beyond 60 s and commands will look expired: set the clock (for example with NTP)." if skew > SKEW_LIMIT_S else "That is close to the 60 s limit: set the clock." if skew > SKEW_WARN_S else "Within the 60 s the server allows."))
            except (urllib.error.URLError, OSError, ValueError) as error:
                add("server", False, f"{server} couldn't be reached ({getattr(error, 'reason', None) or type(error).__name__}). The runtime keeps the robot holding and retries; nothing moves without the server.")
    return found


def report(found: list[dict]) -> str:
    marks = {True: "ok  ", False: "FAIL", None: "warn"}
    lines = [f"{marks[item['ok']]}  {item['id']}: {item['message']}" for item in found]
    failed = sum(1 for item in found if item["ok"] is False)
    warned = sum(1 for item in found if item["ok"] is None)
    lines.append("")
    lines.append(f"{failed} problem{'s' if failed != 1 else ''} to fix before starting the runtime." if failed else f"Ready to start{f', with {warned} warning' + ('s' if warned != 1 else '') if warned else ''}. This checked the computer, not the robot: nothing was moved and no signed request was made.")
    return "\n".join(lines)
