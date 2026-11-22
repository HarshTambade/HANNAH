"""Command line for the hub.

    python3 -m hannah_edge enroll --server https://… --code ABCD-EFGH   once, with the code from HANNAH
    python3 -m hannah_edge run                                          every start after that
    python3 -m hannah_edge doctor                                       check this computer before or after enrolling
    python3 -m hannah_edge simulate                                     simulated devices to try HANNAH without hardware
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import stat
import sys
import time

from . import PROTOCOL, __version__, adapters
from .hub import Hub, describe
from .link import Link, LinkError, check_server_url, enroll
from .protocol import fingerprint, write_private
from .update import Updater

DEFAULT_STATE = os.path.expanduser("~/.hannah-hub")


def log(**fields) -> None:
    print(json.dumps({"at": int(time.time() * 1000), **fields}), flush=True)


def identity_path(state_dir: str) -> str:
    return os.path.join(state_dir, "identity.json")


def load_identity(state_dir: str) -> dict | None:
    try:
        with open(identity_path(state_dir), "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def _updated_env(state_dir: str) -> dict:
    env = os.environ.copy()
    current = os.path.abspath(os.path.join(state_dir, "updates", "current"))
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = current + (os.pathsep + existing if existing else "")
    return env


def _exec_current_update(args) -> None:
    state_dir = os.path.abspath(args.state_dir)
    command = [
        sys.executable, "-m", "hannah_edge", "run", "--state-dir", state_dir,
        "--sync-interval", str(args.sync_interval), "--tick", str(args.tick),
    ]
    # The current working directory is sys.path[0] for `python -m` and could
    # still contain the old checkout. Start in the state folder so the selected
    # updates/current package is the first importable hannah_edge package.
    os.chdir(state_dir)
    os.execvpe(sys.executable, command, _updated_env(state_dir))


def cmd_enroll(args) -> int:
    os.makedirs(args.state_dir, mode=0o700, exist_ok=True)
    try:
        server = check_server_url(args.server, args.allow_insecure)
        answer = enroll(server, args.code, describe())
    except LinkError as error:
        log(event="enroll-failed", message=str(error), reason=error.reason)
        return 1
    write_private(identity_path(args.state_dir), json.dumps({"hubId": answer["hubId"], "secret": answer["secret"], "server": server, "allowInsecure": bool(args.allow_insecure)}))
    log(event="enrolled", hubId=answer["hubId"], fingerprint=fingerprint(answer["secret"]), message="Compare this fingerprint with the one HANNAH shows for this hub.")
    return 0


def cmd_run(args) -> int:
    identity = load_identity(args.state_dir)
    if not identity:
        log(event="not-enrolled", message="This hub isn't enrolled. Run: python3 -m hannah_edge enroll --server … --code …")
        return 1
    try:
        server = check_server_url(identity["server"], identity.get("allowInsecure", False))
    except LinkError as error:
        log(event="bad-server", message=str(error))
        return 1
    updater = Updater(os.path.join(args.state_dir, "updates"))
    update = updater.status()
    if update.get("current") and update["current"] != __version__:
        if update.get("previous"):
            updater.rollback("The selected package version didn't load.")
            log(event="update-rolled-back", version=update["current"], reason="The selected package version didn't load.")
            _exec_current_update(args)
        log(event="update-version-mismatch", expected=update["current"], loaded=__version__)
        return 1
    if update.get("pending"):
        update = updater.on_start()
        if update.get("current") != __version__:
            log(event="update-rolled-back", version=update.get("last", {}).get("version"), reason=update.get("last", {}).get("reason", ""))
            _exec_current_update(args)
    hub = Hub(identity["hubId"], identity["secret"], args.state_dir, Link(server, identity["hubId"], identity["secret"]), sync_interval=args.sync_interval, log=log)
    signal.signal(signal.SIGTERM, lambda *_: hub.stop())
    log(event="started", hubId=identity["hubId"], software=__version__, protocol=PROTOCOL, adapters=sorted(adapters.ADAPTERS))
    try:
        hub.run(tick_s=args.tick)
    except KeyboardInterrupt:
        hub.close()
    if hub.restart_requested:
        log(event="update-restarting", version=hub.update_version)
        _exec_current_update(args)
    log(event="stopped")
    return 0


def cmd_simulate(args) -> int:
    from .sim.broker import Broker
    from .sim.devices import ModbusMeter, MqttRoom, Room
    broker = Broker("127.0.0.1", args.mqtt_port)
    room = MqttRoom(broker.host, broker.port, Room(), period=args.period, speed=args.speed)
    meter = ModbusMeter("127.0.0.1", args.modbus_port)
    log(event="simulating", note="SIMULATION. These devices are not models of any product.", mqtt={"host": broker.host, "port": broker.port}, modbus={"host": meter.host, "port": meter.port, "unit": 1},
        profiles=["org.hannah.sim.thermometer", "org.hannah.sim.fan", "org.hannah.sim.lamp", "org.hannah.sim.power-meter"])
    # Lines on standard input change the simulated room: "heat 8", "mute on", "stuck on", "daylight 20", "drop sim-fan".
    try:
        for line in sys.stdin:
            words = line.split()
            if len(words) != 2:
                continue
            name, value = words
            if name == "heat":
                room.room.heat = float(value)
            elif name == "daylight":
                room.room.daylight = float(value)
            elif name == "mute":
                room.thermo_muted = value == "on"
            elif name == "stuck":
                room.fan_stuck = value == "on"
            elif name == "drop":
                broker.drop_clients(value)
            log(event="sim-input", name=name, value=value, temperature=round(room.room.temperature, 2))
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        room.close()
        meter.close()
        broker.close()
    return 0


def checks(state_dir: str) -> list:
    """What `doctor` looks at. Each is (name, PASS|WARN|FAIL, detail). It sends nothing signed and changes nothing."""
    found = []
    version = sys.version_info
    found.append(("python", "PASS" if version >= (3, 9) else "FAIL", f"{version.major}.{version.minor}.{version.micro} (3.9 or newer is needed)"))
    found.append(("adapters", "PASS", ", ".join(sorted(adapters.ADAPTERS))))
    if not os.path.isdir(state_dir):
        found.append(("state-folder", "WARN", f"{state_dir} doesn't exist yet. Enrolling creates it."))
        return found
    mode = stat.S_IMODE(os.stat(state_dir).st_mode)
    found.append(("state-folder", "PASS" if not mode & 0o077 else "FAIL", f"{state_dir} mode {oct(mode)}" + ("" if not mode & 0o077 else ": other users can read it. Run chmod 700 on it.")))
    identity = load_identity(state_dir)
    if not identity:
        found.append(("identity", "WARN", "Not enrolled yet."))
        return found
    key_mode = stat.S_IMODE(os.stat(identity_path(state_dir)).st_mode)
    found.append(("identity", "PASS" if not key_mode & 0o077 else "FAIL", f"Enrolled as {identity.get('hubId')}; key file mode {oct(key_mode)}"))
    try:
        check_server_url(identity.get("server", ""), identity.get("allowInsecure", False))
        encrypted = str(identity.get("server", "")).startswith("https://")
        found.append(("server-address", "PASS" if encrypted else "WARN", identity.get("server", "") + ("" if encrypted else " (not encrypted: for development only)")))
    except LinkError as error:
        found.append(("server-address", "FAIL", str(error)))
    found.append(("clock", "PASS" if time.time() > 1_700_000_000 else "FAIL", "The clock must be set: signed requests carry the time."))
    return found


def cmd_doctor(args) -> int:
    found = checks(args.state_dir)
    if args.json:
        print(json.dumps([{"check": name, "result": result, "detail": detail} for name, result, detail in found], indent=2))
    else:
        for name, result, detail in found:
            print(f"{result:5} {name:15} {detail}")
    return 1 if any(result == "FAIL" for _name, result, _detail in found) else 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="hannah_edge", description="HANNAH Edge hub")
    parser.add_argument("--version", action="version", version=f"{__version__} ({PROTOCOL})")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("enroll", "run", "doctor"):
        sub = commands.add_parser(name)
        sub.add_argument("--state-dir", default=os.environ.get("HANNAH_HUB_STATE", DEFAULT_STATE))
        if name == "enroll":
            sub.add_argument("--server", required=True)
            sub.add_argument("--code", required=True)
            sub.add_argument("--allow-insecure", action="store_true")
        if name == "run":
            sub.add_argument("--sync-interval", type=float, default=2.0)
            sub.add_argument("--tick", type=float, default=0.5)
        if name == "doctor":
            sub.add_argument("--json", action="store_true")
    sim = commands.add_parser("simulate")
    sim.add_argument("--mqtt-port", type=int, default=18830)
    sim.add_argument("--modbus-port", type=int, default=15020)
    sim.add_argument("--period", type=float, default=1.0)
    sim.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args(argv)
    return {"enroll": cmd_enroll, "run": cmd_run, "doctor": cmd_doctor, "simulate": cmd_simulate}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
