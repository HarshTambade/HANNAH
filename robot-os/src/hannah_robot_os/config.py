from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class SafetyLimits:
    max_linear_speed_mps: float = 0.5
    max_angular_speed_rps: float = 1.5
    max_acceleration_mps2: float = 0.8
    command_ttl_ms: int = 500
    watchdog_timeout_ms: int = 500
    estop_latched: bool = True


@dataclass
class RobotOSConfig:
    robot_id: str = "robot-dev"
    profile: str = "robotos-dev-x86_64"
    data_dir: str = "/var/lib/hannah-robot-os"
    log_dir: str = "/var/log/hannah-robot-os"
    config_dir: str = "/etc/hannah-robot-os"
    safety: SafetyLimits = field(default_factory=SafetyLimits)
    required_services: list[str] = field(
        default_factory=lambda: ["safety-gateway", "hardware-manager", "motor-controller"]
    )
    required_sensors: list[str] = field(default_factory=list)
    enable_ai_runtime: bool = True
    enable_remote_gateway: bool = True
    offline_allowed: bool = True
    # Hardware profile (JSON) that picks the motor drivers. Empty: simulated controller.
    hardware_profile: str = ""

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "RobotOSConfig":
        safety = data.get("safety", {})
        return RobotOSConfig(
            robot_id=data.get("robot_id", "robot-dev"),
            profile=data.get("profile", "robotos-dev-x86_64"),
            data_dir=data.get("data_dir", "/var/lib/hannah-robot-os"),
            log_dir=data.get("log_dir", "/var/log/hannah-robot-os"),
            config_dir=data.get("config_dir", "/etc/hannah-robot-os"),
            safety=SafetyLimits(**safety) if isinstance(safety, dict) else SafetyLimits(),
            required_services=list(data.get("required_services", ["safety-gateway", "hardware-manager", "motor-controller"])),
            required_sensors=list(data.get("required_sensors", [])),
            enable_ai_runtime=bool(data.get("enable_ai_runtime", True)),
            enable_remote_gateway=bool(data.get("enable_remote_gateway", True)),
            offline_allowed=bool(data.get("offline_allowed", True)),
            hardware_profile=str(data.get("hardware_profile") or ""),
        )

    @staticmethod
    def load(path: str | Path) -> "RobotOSConfig":
        p = Path(path)
        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("config must be a JSON object")
        return RobotOSConfig.from_dict(data)

    def to_dict(self) -> dict[str, Any]:
        return {
            "robot_id": self.robot_id,
            "profile": self.profile,
            "data_dir": self.data_dir,
            "log_dir": self.log_dir,
            "config_dir": self.config_dir,
            "safety": self.safety.__dict__,
            "required_services": list(self.required_services),
            "required_sensors": list(self.required_sensors),
            "enable_ai_runtime": self.enable_ai_runtime,
            "enable_remote_gateway": self.enable_remote_gateway,
            "offline_allowed": self.offline_allowed,
            "hardware_profile": self.hardware_profile,
        }
