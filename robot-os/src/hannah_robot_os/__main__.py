from __future__ import annotations

import argparse
import json
from pathlib import Path

from .common import AuditLog, ServiceState
from .config import RobotOSConfig
from .hardware.models import HardwareDevice
from .hardware.registry import HardwareRegistry
from .motors.manager import MotorControllerManager
from .motors.sim import SimMotorController
from .safety.gateway import SafetyGateway
from .sensors.manager import SensorManager
from .services.health import ServiceHealthManager


def cmd_doctor(args: argparse.Namespace) -> int:
    cfg = RobotOSConfig.load(args.config) if args.config else RobotOSConfig()
    checks = {
        "config": True,
        "profile": cfg.profile,
        "robot_id": cfg.robot_id,
        "required_services": cfg.required_services,
        "required_sensors": cfg.required_sensors,
        "offline_allowed": cfg.offline_allowed,
    }
    print(json.dumps({"ok": True, "checks": checks}, indent=2))
    return 0


def cmd_sim(args: argparse.Namespace) -> int:
    cfg = RobotOSConfig.load(args.config) if args.config else RobotOSConfig()
    audit = AuditLog()
    hw = HardwareRegistry(audit=audit)
    safety = SafetyGateway(audit=audit, limits=cfg.safety)
    motors = MotorControllerManager(audit=audit, limits=cfg.safety)
    sensors = SensorManager(audit=audit, registry=hw, required_sensor_ids=cfg.required_sensors)
    health = ServiceHealthManager(audit=audit, required_services=cfg.required_services)

    ctrl = SimMotorController(controller_id="sim-motor-1")
    motors.register_controller(ctrl)
    motors.connect(ctrl.controller_id)
    motors.enable(ctrl.controller_id, True)
    hw.register(HardwareDevice(device_id=ctrl.controller_id, kind="motor_controller", manufacturer="HANNAH", model="SIM-MC", interface="sim"))

    for name in cfg.required_services:
        health.set_state(name, ServiceState.READY)
    safety.heartbeat()

    print(json.dumps({
        "robot_ready": health.snapshot()["robot_ready"],
        "safety_state": safety.state.value,
        "motor_status": motors.status(ctrl.controller_id).__dict__,
        "sensor_status": sensors.status(),
    }, indent=2, default=str))
    return 0


def cmd_validate_config(args: argparse.Namespace) -> int:
    cfg = RobotOSConfig.load(args.config)
    print(json.dumps({"ok": True, "config": cfg.to_dict()}, indent=2))
    return 0


def cmd_ready(args: argparse.Namespace) -> int:
    """Print the boot READY marker only when mandatory services check out."""
    from .services.status_files import required_services_ready

    cfg = RobotOSConfig.load(args.config) if args.config else RobotOSConfig()
    status_dir = Path(args.status_dir) if args.status_dir else Path(cfg.data_dir) / "status"
    snapshot = required_services_ready(status_dir, cfg.required_services)
    if not snapshot["robot_ready"]:
        print(json.dumps(snapshot, indent=2))
        return 1
    print("HANNAH Robot OS READY")
    return 0


def cmd_recovery(args: argparse.Namespace) -> int:
    from .updates.recovery import RecoveryManager, RecoveryState

    state_path = Path(args.state)
    state = RecoveryState.load(state_path)
    recovery = RecoveryManager(state=state)

    if args.action == "enter":
        recovery.enter(args.reason, args.last_good_version)
        recovery.save(state_path)
        print(json.dumps(recovery.state.__dict__, indent=2))
        return 0
    if args.action == "exit":
        cfg = RobotOSConfig.load(args.config) if args.config else RobotOSConfig()
        status_dir = Path(args.status_dir) if args.status_dir else Path(cfg.data_dir) / "status"
        from .services.status_files import required_services_ready

        ready = required_services_ready(status_dir, cfg.required_services)["robot_ready"]
        try:
            recovery.exit(robot_ready=ready)
        except RuntimeError as exc:
            print(str(exc))
            return 1
        recovery.save(state_path)
        print(json.dumps(recovery.state.__dict__, indent=2))
        return 0
    print(json.dumps(recovery.state.__dict__, indent=2))
    return 0


def _safety_dir(args: argparse.Namespace, cfg: RobotOSConfig) -> Path:
    """--safety-dir, else beside --status-dir (both normally live in the data directory), else <data_dir>/safety."""
    if getattr(args, "safety_dir", None):
        return Path(args.safety_dir)
    if getattr(args, "status_dir", None):
        return Path(args.status_dir).parent / "safety"
    return Path(cfg.data_dir) / "safety"


def cmd_safety(args: argparse.Namespace) -> int:
    """Ask the safety-gateway service to engage, release or reset the software stop, or show its state."""
    from .safety import shared

    cfg = RobotOSConfig.load(args.config) if args.config else RobotOSConfig()
    safety_dir = _safety_dir(args, cfg)
    if args.action == "status":
        data = shared.read(safety_dir)
        print(json.dumps(data or {"error": "the safety gateway hasn't published its state"}, indent=2))
        return 0 if data else 1
    try:
        path = shared.submit(safety_dir, args.action, args.operator or "", mode=getattr(args, "mode", "") or "")
    except ValueError as error:
        print(str(error))
        return 2
    print(json.dumps({"requested": args.action, "file": path.name, "note": "The safety gateway applies it on its next tick. This is a software stop, not a safety-rated emergency stop."}, indent=2))
    return 0


def cmd_validate_profile(args: argparse.Namespace) -> int:
    from .profiles.schema import validate_hardware_profile

    data = json.loads(Path(args.profile).read_text(encoding="utf-8"))
    errors = validate_hardware_profile(data)
    print(json.dumps({"ok": len(errors) == 0, "errors": errors}, indent=2))
    return 0 if not errors else 2


def cmd_service(args: argparse.Namespace) -> int:
    cfg = RobotOSConfig.load(args.config) if args.config else RobotOSConfig()
    audit = AuditLog()
    blackbox = None
    if getattr(args, "blackbox_dir", None):
        from .blackbox import OSBlackBox

        # Without a hardware profile the motors are the simulated controller: the recording says so.
        blackbox = OSBlackBox(str(Path(args.blackbox_dir) / args.name), cfg.robot_id, simulated=not (getattr(args, "profile", None) or cfg.hardware_profile), data_dir=cfg.data_dir)
        blackbox.sweep()
        audit.sinks.append(blackbox.sink)
    health = ServiceHealthManager(audit=audit, required_services=cfg.required_services)
    hw = HardwareRegistry(audit=audit)
    safety = SafetyGateway(audit=audit, limits=cfg.safety)
    sensors = SensorManager(audit=audit, registry=hw, required_sensor_ids=cfg.required_sensors)
    status_dir = Path(args.status_dir) if args.status_dir else Path(cfg.data_dir) / "status"
    status_path = status_dir / f"{args.name}.json"
    safety_dir = _safety_dir(args, cfg)
    from .safety import shared

    if args.name == "safety-gateway":
        # The operating mode it had before a restart, so a Safety Stop isn't lost by restarting the service.
        shared.restore(safety, safety_dir)

    def tick() -> None:
        safety.heartbeat()
        if args.name == "safety-gateway":
            # The one writer of the safety state every other service follows.
            shared.drain(safety, safety_dir)
            shared.publish(safety, safety_dir)
        if args.name == "motor-controller":
            # Follow the safety gateway's state; a stale or missing state stops the motors.
            # Stop on the change to unsafe, then again only if something still turns,
            # so a long stop doesn't write an audit entry every tick.
            safe = shared.mirror(safety, safety_dir, stale_after_ms=cfg.safety.watchdog_timeout_ms * 4)
            motor_service.tick(safe, reason=safety.fault or safety.state.value)
        if args.name == "sensor-manager":
            safety.set_required_sensors_ok(sensors.required_sensors_ok())
        if args.name == "edge-resources" and resources_due():
            resources.tick()
        if blackbox is not None and args.name == "telemetry":
            blackbox.sample_system()
        # other services: heartbeat/status only in this minimal runtime

    if args.name == "edge-resources":
        import time as _time

        from .resources import manager_from_config
        from .services.status_files import required_services_ready

        def service_status() -> list[dict]:
            names = sorted(set(cfg.required_services) | {"sensor-manager"})
            return required_services_ready(status_dir, names)["required"]

        try:
            resources = manager_from_config(cfg, service_status=service_status)
        except ValueError as error:
            print(json.dumps({"ok": False, "error": str(error)}, indent=2))
            return 2
        every_s = float((cfg.resources or {}).get("interval_s", 5.0))
        last = {"at": 0.0}

        def resources_due() -> bool:
            now = _time.monotonic()
            if last["at"] and now - last["at"] < every_s:
                return False
            last["at"] = now
            return True

    # The motor drivers come from the hardware profile; with none, the simulated controller.
    if args.name == "motor-controller":
        from .services.motor_service import MotorService, ProfileError

        motor_service = MotorService(audit=audit, cfg=cfg, hw=hw, profile_path=getattr(args, "profile", None) or cfg.hardware_profile)
        try:
            motor_service.setup()
        except (ProfileError, OSError, ValueError) as error:
            print(json.dumps({"ok": False, "error": str(error), "errors": getattr(error, "errors", [])}, indent=2))
            return 2

    from .services.runtime import ServiceRuntime

    runtime = ServiceRuntime(
        name=args.name,
        health=health,
        audit=audit,
        status_path=status_path,
        tick=tick,
        interval_s=float(args.interval),
        extra=(lambda: {"maintenance": motor_service.maintenance()}) if args.name == "motor-controller" else None,
    )
    try:
        runtime.run_forever(max_ticks=args.max_ticks)
    finally:
        if blackbox is not None:
            blackbox.flush()
    return 0


def cmd_firstboot(args: argparse.Namespace) -> int:
    """First-boot setup of a disk image: hostname, SSH keys (no passwords), firewall, enrollment."""
    from .image.firstboot import PROVISION_CANDIDATES, ProvisionError, run_firstboot

    try:
        report = run_firstboot(
            root=args.root,
            provision_paths=tuple(args.provision) if args.provision else PROVISION_CANDIDATES,
            generate_host_key=not args.no_host_key,
            chown=not args.no_chown,
        )
    except ProvisionError as error:
        print(json.dumps({"ok": False, "error": str(error)}, indent=2))
        return 2
    print(json.dumps(report, indent=2))
    return 0


def cmd_update(args: argparse.Namespace) -> int:
    """A/B update bookkeeping for the disk image (the image's update hook calls this)."""
    from .updates import boot
    from .updates.state import UpdateState

    state_path = Path(args.state)
    state = UpdateState.load(state_path)
    cfg = RobotOSConfig.load(args.config) if args.config else RobotOSConfig()

    if args.action == "status":
        print(json.dumps(state.__dict__, indent=2))
        return 0
    if args.action == "verify-package":
        from .updates.package import PackageError, load_trusted_keys, verify_package

        try:
            manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
            facts = json.loads(Path(args.facts).read_text(encoding="utf-8")) if args.facts else {}
            verified = verify_package(manifest, load_trusted_keys(args.trusted_keys), facts, args.artifact_dir)
        except (OSError, ValueError, KeyError, TypeError) as error:
            print(json.dumps({"ok": False, "error": str(error) if isinstance(error, PackageError) else f"{type(error).__name__}: {error}"}, indent=2))
            return 1
        print(json.dumps({"ok": True, **verified}, indent=2))
        return 0
    if args.action == "report":
        # The update_status event this robot sends HANNAH after a boot, with its health checks.
        from .services.status_files import required_services_ready

        status_dir = Path(args.status_dir) if args.status_dir else Path(cfg.data_dir) / "status"
        ready = required_services_ready(status_dir, cfg.required_services)["robot_ready"]
        outcome = {"healthy": "healthy", "rolled_back": "rolled-back", "failed": "failed"}.get(state.status, state.status)
        version = state.current_version if state.status == "healthy" else (state.pending_version or state.current_version)
        payload = {"type": "update_status", "outcome": outcome, "version": version, "lastGoodVersion": state.last_good_version, "checks": [{"id": "robot-ready", "ok": bool(ready), "detail": "READY gate passed" if ready else "READY gate not passed"}]}
        print(json.dumps(payload, indent=2))
        return 0
    if args.action == "gate":
        ok, reason = boot.gate(_safety_dir(args, cfg), stale_after_ms=cfg.safety.watchdog_timeout_ms * 4)
        print(json.dumps({"ok": ok, "reason": reason}, indent=2))
        return 0 if ok else 1
    if args.action == "stage":
        try:
            boot.stage(state, args.version or "", boot.read_boot_id(args.boot_id_file))
        except ValueError as error:
            print(json.dumps({"ok": False, "error": str(error)}, indent=2))
            return 2
        state.save(state_path)
        print(json.dumps(state.__dict__, indent=2))
        return 0
    if args.action == "confirm":
        from .services.status_files import required_services_ready

        status_dir = Path(args.status_dir) if args.status_dir else Path(cfg.data_dir) / "status"
        ready = required_services_ready(status_dir, cfg.required_services)["robot_ready"]
        running = args.version or boot.read_os_release_version(args.os_release)
        outcome = boot.confirm(state, running, boot.read_boot_id(args.boot_id_file), ready)
        if outcome not in {"not-ready", "unknown-version", "pending", "unchanged"}:
            state.save(state_path)
        print(json.dumps({"outcome": outcome, "state": state.__dict__}, indent=2))
        return 1 if outcome in {"not-ready", "unknown-version"} else 0
    return 2


def cmd_resources(args: argparse.Namespace) -> int:
    """Edge Resource Manager: one real sample, the workload units, or a full evaluation."""
    from .resources import ResourceProbe, manager_from_config
    from .resources.workloads import apply_overrides, assignments, generate_units

    cfg = RobotOSConfig.load(args.config) if args.config else RobotOSConfig()
    res = cfg.resources or {}
    try:
        if args.action == "units":
            files = generate_units(apply_overrides(res.get("workload_overrides")), assignments(res.get("assignments")))
            out = Path(args.out)
            for name, text in files.items():
                target = out / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text, encoding="utf-8")
            print(json.dumps({"ok": True, "written": sorted(files), "into": str(out)}, indent=2))
            return 0
        if args.action == "sample":
            probe = ResourceProbe(root=args.root, storage_paths=res.get("storage_paths") or ["/"])
            print(json.dumps(probe.sample(), indent=2))
            return 0
        cfg.data_dir = args.state_dir or cfg.data_dir
        manager = manager_from_config(cfg, root=args.root)
        if args.state_dir is None:
            manager.state_dir = None  # a one-off evaluation doesn't write the service's history
        print(json.dumps(manager.tick(), indent=2))
        return 0
    except ValueError as error:
        print(json.dumps({"ok": False, "error": str(error)}, indent=2))
        return 2


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="hannah-robot-os")
    sub = p.add_subparsers(dest="command", required=True)

    d = sub.add_parser("doctor", help="Check local Robot OS configuration/readiness inputs")
    d.add_argument("--config")
    d.set_defaults(func=cmd_doctor)

    s = sub.add_parser("sim", help="Run a simulated Robot OS core smoke check")
    s.add_argument("--config")
    s.set_defaults(func=cmd_sim)

    v = sub.add_parser("validate-config", help="Validate a Robot OS config file")
    v.add_argument("config")
    v.set_defaults(func=cmd_validate_config)

    svc = sub.add_parser("service", help="Run a Robot OS service (foreground)")
    svc.add_argument("name", choices=["safety-gateway", "hardware-manager", "motor-controller", "sensor-manager", "ros2-runtime", "telemetry", "update-manager", "ai-runtime", "remote-gateway", "edge-resources"])
    svc.add_argument("--config")
    svc.add_argument("--status-dir")
    svc.add_argument("--safety-dir")
    svc.add_argument("--profile", help="hardware profile that picks the motor drivers (default: the config's hardware_profile, else the simulator)")
    svc.add_argument("--interval", type=float, default=0.1)
    svc.add_argument("--max-ticks", type=int)
    svc.add_argument("--blackbox-dir", help="keep a black box recording of this service's events (and, for telemetry, system readings) here")
    svc.set_defaults(func=cmd_service)

    vp = sub.add_parser("validate-profile", help="Validate a hardware profile JSON file")
    vp.add_argument("profile")
    vp.set_defaults(func=cmd_validate_profile)

    rd = sub.add_parser("ready", help="Print READY marker only when required services report ready")
    rd.add_argument("--config")
    rd.add_argument("--status-dir")
    rd.set_defaults(func=cmd_ready)

    sf = sub.add_parser("safety", help="Engage, release or reset the software stop through the safety gateway, or show its state")
    sf.add_argument("action", choices=["engage", "release", "reset", "mode", "status"])
    sf.add_argument("--mode", help="for mode: manual, assisted, supervised, mission, maintenance or safety_stop (all but safety_stop need --operator)")
    sf.add_argument("--operator", help="who is resetting (required for reset)")
    sf.add_argument("--config")
    sf.add_argument("--safety-dir")
    sf.set_defaults(func=cmd_safety)

    rec = sub.add_parser("recovery", help="Enter, exit, or inspect recovery mode")
    rec.add_argument("action", choices=["enter", "exit", "status"])
    rec.add_argument("--state", default="/var/lib/hannah-robot-os/recovery.json")
    rec.add_argument("--config")
    rec.add_argument("--status-dir")
    rec.add_argument("--reason", default="operator requested recovery")
    rec.add_argument("--last-good-version", default="")
    rec.set_defaults(func=cmd_recovery)

    fb = sub.add_parser("firstboot", help="First-boot setup of a HANNAH Robot OS disk image")
    fb.add_argument("--root", default="/", help="filesystem root (for testing)")
    fb.add_argument("--provision", action="append", help="provisioning file to look for (repeatable)")
    fb.add_argument("--no-host-key", action="store_true", help="don't generate the SSH host key")
    fb.add_argument("--no-chown", action="store_true", help="don't change file owners (for testing)")
    fb.set_defaults(func=cmd_firstboot)

    rs = sub.add_parser("resources", help="Edge Resource Manager: sample real metrics, write workload slices, or evaluate once")
    rs.add_argument("action", choices=["sample", "units", "evaluate"])
    rs.add_argument("--config")
    rs.add_argument("--root", default="/", help="filesystem root to read /proc and /sys from (for testing)")
    rs.add_argument("--out", default="/etc/systemd/system", help="units: where to write the slices and drop-ins")
    rs.add_argument("--state-dir", help="evaluate: keep history here (default: don't write any)")
    rs.set_defaults(func=cmd_resources)

    up = sub.add_parser("update", help="A/B image update state: status, gate, stage, confirm; verify a signed package; report update status")
    up.add_argument("action", choices=["status", "gate", "stage", "confirm", "verify-package", "report"])
    up.add_argument("--manifest", help="verify-package: a signed hannah-update.json")
    up.add_argument("--trusted-keys", default="/etc/hannah-robot-os/trusted-update-keys.json", help="verify-package: the publisher keys pinned on this robot")
    up.add_argument("--facts", help="verify-package: JSON with this robot's manufacturer, model, os, rosDistro, runtimeVersion, ...")
    up.add_argument("--artifact-dir", help="verify-package: folder with the package's files, to check their SHA-256")
    up.add_argument("--state", default="/var/lib/hannah-robot-os/update-state.json")
    up.add_argument("--version", help="stage: the version being installed; confirm: the running version (default: IMAGE_VERSION from os-release)")
    up.add_argument("--os-release", default="/usr/lib/os-release")
    up.add_argument("--boot-id-file", default="/proc/sys/kernel/random/boot_id")
    up.add_argument("--config")
    up.add_argument("--status-dir")
    up.add_argument("--safety-dir")
    up.set_defaults(func=cmd_update)

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
