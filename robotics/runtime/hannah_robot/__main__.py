"""Command line for the HANNAH Robotics Runtime.

    python3 -m hannah_robot describe [--profile FILE]
    python3 -m hannah_robot enroll --server https://… --code XXXXX-XXXXX [--profile FILE] [--state-dir DIR]
    python3 -m hannah_robot run [--profile FILE] [--state-dir DIR] [--sim-speed N]
    python3 -m hannah_robot doctor [--profile FILE] [--state-dir DIR] [--json]

Enrollment exchanges the one-time code from HANNAH's Robots screen for this
robot's secret and stores it in the state directory, readable only by this
user. `run` then keeps the robot connected until it is interrupted. `doctor`
checks that this computer is ready to run it; it moves nothing.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys

from . import __version__
from .link import Link, LinkError, check_server_url, enroll
from .profile import DEFAULT_PROFILE, ProfileError, build_adapter, descriptor, load_profile, local_safety
from .protocol import CommandGuard, fingerprint
from .runtime import Runtime, json_logger, run


def _state_dir(args) -> str:
    path = args.state_dir or os.path.join(os.path.expanduser("~"), ".hannah-robot", os.path.splitext(os.path.basename(args.profile))[0])
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def _credentials_path(state_dir: str) -> str:
    return os.path.join(state_dir, "credentials.json")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="hannah_robot", description=f"HANNAH Robotics Runtime {__version__}")
    parser.add_argument("command", choices=["describe", "enroll", "run", "doctor"])
    parser.add_argument("--profile", default=DEFAULT_PROFILE, help="The robot's profile file (default: the simulated differential-drive robot).")
    parser.add_argument("--state-dir", help="Where this robot's credentials and replay state are kept.")
    parser.add_argument("--server", help="HANNAH's address, for enroll.")
    parser.add_argument("--code", help="The one-time enrollment code, for enroll.")
    parser.add_argument("--allow-insecure", action="store_true", help="Allow http:// to another computer. Only for a closed development network.")
    parser.add_argument("--sim-speed", type=float, default=1.0, help="Simulated seconds per real second (built-in simulator only).")
    parser.add_argument("--sync-interval", type=float, default=None, help="Seconds between exchanges with the server (default: what the server asks for).")
    parser.add_argument("--resources-file", default=None, help="The Robot OS Edge Resource Manager's latest report to forward (default: /var/lib/hannah-robot-os/resources/latest.json when it exists).")
    parser.add_argument("--json", action="store_true", help="For doctor: print the checks as JSON.")
    args = parser.parse_args(argv)
    if args.command == "doctor":
        from .doctor import checks, report
        state_dir = args.state_dir or os.path.join(os.path.expanduser("~"), ".hannah-robot", os.path.splitext(os.path.basename(args.profile))[0])
        found = checks(args.profile, state_dir, args.allow_insecure)
        print(json.dumps(found, indent=2) if args.json else report(found))
        return 1 if any(item["ok"] is False for item in found) else 0
    log = json_logger()
    try:
        profile = load_profile(args.profile)
        state_dir = _state_dir(args)
        adapter = build_adapter(profile, sim_speed=args.sim_speed, state_dir=state_dir)
        if args.command == "describe":
            print(json.dumps(descriptor(profile, adapter), indent=2))
            return 0
        if args.command == "enroll":
            if not args.server or not args.code:
                parser.error("enroll needs --server and --code")
            server = check_server_url(args.server, args.allow_insecure)
            answer = enroll(server, args.code, descriptor(profile, adapter))
            path = _credentials_path(state_dir)
            handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(handle, "w", encoding="utf-8") as out:
                json.dump({"server": server, "robotId": answer["robotId"], "secret": answer["secret"], "name": answer.get("name", "")}, out)
            os.chmod(path, 0o600)
            # A new secret starts a new command sequence.
            guard_path = os.path.join(state_dir, "guard.json")
            if os.path.exists(guard_path):
                os.remove(guard_path)
            # Computed here from the secret, not taken from the server's answer: compare it with the one HANNAH shows.
            log("enrolled", robot=answer["robotId"], name=answer.get("name", ""), fingerprint=fingerprint(answer["secret"]), capabilities=answer.get("capabilities"), refused=answer.get("refused") or None)
            return 0
        # run
        try:
            with open(_credentials_path(state_dir), "r", encoding="utf-8") as handle:
                credentials = json.load(handle)
        except (OSError, ValueError):
            print("This robot isn't enrolled yet. Run: python3 -m hannah_robot enroll --server … --code …", file=sys.stderr)
            return 2
        server = check_server_url(credentials["server"], args.allow_insecure)
        try:
            adapter.start()
        except ImportError as error:
            print(f"The {adapter.name} adapter can't start: {error.name or 'a ROS 2 package'} isn't available. Source your ROS 2 environment first (for example: source /opt/ros/jazzy/setup.bash).", file=sys.stderr)
            return 3
        except RuntimeError as error:
            print(str(error), file=sys.stderr)
            return 3
        safety = local_safety(adapter)
        guard = CommandGuard(credentials["secret"], credentials["robotId"], os.path.join(state_dir, "guard.json"))
        runtime = Runtime(adapter, guard, safety, link_timeout=float(safety.limits.get("linkTimeoutS", 5)), log=log, descriptor=descriptor(profile, adapter))
        from .resources import reader_from_env
        runtime.resources = reader_from_env(args.resources_file)
        for name in (signal.SIGINT, signal.SIGTERM):
            signal.signal(name, lambda *_: runtime.stop())
        log("running", robot=credentials["robotId"], adapter=adapter.name, simulation=(adapter.describe().get("simulation") or {}).get("kind"), server=server)
        run(runtime, Link(server, credentials["robotId"], credentials["secret"]), sync_interval=args.sync_interval)
        log("stopped")
        return 0
    except (ProfileError, LinkError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
