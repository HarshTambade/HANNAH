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
    cfg = RobotOSConfig.load(args.config) if args.config else RobotOSConfig()
    audit = AuditLog()
    health = ServiceHealthManager(audit=audit, required_services=cfg.required_services)
    status_dir = Path(cfg.data_dir) / "status"
    for name in cfg.required_services:
        path = status_dir / f"{name}.json"
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if data.get("service") == name:
                    health.set_state(name, ServiceState.READY)
            except (OSError, ValueError):
                pass
    snapshot = health.snapshot()
    if not snapshot["robot_ready"]:
        print(json.dumps(snapshot, indent=2))
        return 1
    print("HANNAH Robot OS READY")
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
    health = ServiceHealthManager(audit=audit, required_services=cfg.required_services)
    hw = HardwareRegistry(audit=audit)
    safety = SafetyGateway(audit=audit, limits=cfg.safety)
    motors = MotorControllerManager(audit=audit, limits=cfg.safety)
    sensors = SensorManager(audit=audit, registry=hw, required_sensor_ids=cfg.required_sensors)
    status_dir = Path(args.status_dir) if args.status_dir else Path(cfg.data_dir) / "status"
    status_path = status_dir / f"{args.name}.json"

    def tick() -> None:
        safety.heartbeat()
        if args.name == "motor-controller":
            for c in list(getattr(motors, "_controllers", {}).keys()):
                motors.watchdog_check(c)
        if args.name == "sensor-manager":
            safety.set_required_sensors_ok(sensors.required_sensors_ok())
        # other services: heartbeat/status only in this minimal runtime

    # minimal simulated controller wiring for motor-controller service
    if args.name == "motor-controller":
        ctrl = SimMotorController(controller_id="sim-motor-1")
        motors.register_controller(ctrl)
        motors.connect(ctrl.controller_id)
        motors.enable(ctrl.controller_id, True)
        hw.register(HardwareDevice(device_id=ctrl.controller_id, kind="motor_controller", manufacturer="HANNAH", model="SIM-MC", interface="sim"))

    from .services.runtime import ServiceRuntime

    runtime = ServiceRuntime(
        name=args.name,
        health=health,
        audit=audit,
        status_path=status_path,
        tick=tick,
        interval_s=float(args.interval),
    )
    runtime.run_forever(max_ticks=args.max_ticks)
    return 0


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
    svc.add_argument("name", choices=["safety-gateway", "hardware-manager", "motor-controller", "sensor-manager", "ros2-runtime", "telemetry", "update-manager", "ai-runtime", "remote-gateway"])
    svc.add_argument("--config")
    svc.add_argument("--status-dir")
    svc.add_argument("--interval", type=float, default=0.1)
    svc.add_argument("--max-ticks", type=int)
    svc.set_defaults(func=cmd_service)

    vp = sub.add_parser("validate-profile", help="Validate a hardware profile JSON file")
    vp.add_argument("profile")
    vp.set_defaults(func=cmd_validate_profile)

    rd = sub.add_parser("ready", help="Print READY marker only when required services report ready")
    rd.add_argument("--config")
    rd.set_defaults(func=cmd_ready)

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
