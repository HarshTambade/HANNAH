"""`python3 -m hannah_robot blackbox …`: look at, prune, replay and export a recording on the robot itself."""
from __future__ import annotations

import json
import os
import sys

from ..scenarios import DEFAULT_DIR
from .config import RecorderConfig
from .recorder import Recorder
from .replay import load_recording, mission_timeline, reproduce, scenario_from_recording


def _directory(args) -> str:
    if args.blackbox_dir:
        return args.blackbox_dir
    state = args.state_dir or os.path.join(os.path.expanduser("~"), ".hannah-robot", os.path.splitext(os.path.basename(args.profile))[0])
    return os.path.join(state, "blackbox")


def main(args) -> int:
    directory = _directory(args)
    action = args.action or "list"
    if not os.path.isdir(directory):
        print(f"There is no recording in {directory}. Start the runtime with --record first.", file=sys.stderr)
        return 2
    if action in ("list", "sweep"):
        config = RecorderConfig.load(args.blackbox_config) if args.blackbox_config else RecorderConfig()
        recorder = Recorder(directory, "local", config, simulated=False)
        removed = recorder.sweep() if action == "sweep" else []
        print(json.dumps({"directory": directory, "removed": removed, "segments": recorder.segments(), "stats": recorder.stats()}, indent=2))
        return 0
    recording = load_recording(directory)
    label = "simulation" if recording["simulated"] else "recorded on the robot"
    if action == "timeline":
        if not args.mission:
            print("timeline needs --mission", file=sys.stderr)
            return 2
        print(json.dumps({"playback": True, "recording": label, **mission_timeline(recording["records"], args.mission)}, indent=2))
        return 0
    if action in ("scenario", "reproduce"):
        if not args.mission:
            print(f"{action} needs --mission", file=sys.stderr)
            return 2
        world_path = os.path.normpath(os.path.join(DEFAULT_DIR, args.world))
        try:
            with open(world_path, "r", encoding="utf-8") as handle:
                world = json.load(handle)
        except (OSError, ValueError):
            world = None
        try:
            if action == "scenario":
                scenario = scenario_from_recording(recording["records"], args.mission, world_ref=args.world, world=world, recorded_on="simulation" if recording["simulated"] else "physical robot")
                text = json.dumps(scenario, indent=2)
                if args.out:
                    with open(args.out, "x", encoding="utf-8") as handle:
                        handle.write(text + "\n")
                    print(f"Wrote {args.out}. Run it with: python3 -m hannah_robot.scenarios {args.out}")
                else:
                    print(text)
                return 0
            result = reproduce(recording["records"], args.mission, world_ref=args.world, base_dir=DEFAULT_DIR, world=world, recorded_on="simulation" if recording["simulated"] else "physical robot")
            print(json.dumps({key: result[key] for key in ("recorded", "reproduced", "same", "simulator", "note")}, indent=2))
            return 0 if result["same"] else 1
        except (ValueError, FileExistsError) as error:
            print(str(error), file=sys.stderr)
            return 2
    if action == "export-rosbag2":
        from .rosbag2 import Rosbag2Unavailable, export_segments

        if not args.out:
            print("export-rosbag2 needs --out (the bag directory to create)", file=sys.stderr)
            return 2
        paths = [os.path.join(folder, name) for folder, _dirs, files in os.walk(os.path.join(directory, "segments")) for name in files if name.endswith((".hbx", ".hbx.gz"))]
        try:
            print(json.dumps(export_segments(sorted(paths), args.out, args.storage), indent=2))
        except Rosbag2Unavailable as error:
            print(str(error), file=sys.stderr)
            return 3
        return 0
    print(f"Unknown blackbox action {action!r}: use list, sweep, timeline, scenario, reproduce or export-rosbag2.", file=sys.stderr)
    return 2


__all__ = ["main"]
