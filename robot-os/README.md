# HANNAH Robot OS

This directory contains the HANNAH Robot OS foundation: onboard Linux service definitions, Python core managers, hardware profiles, ROS2 integration templates, image build manifests, and tests.

## Status

**Experimental / in development.** No physical hardware validation. No OS image boot validation in this dev environment.

## What is implemented

- Core Python package `hannah_robot_os` (config, audit, hardware registry, motor controller manager + sim adapter, safety gateway, sensor manager, service health, update manifest verification, CLI).
- Unit tests for core safety/motor/sensor/health/update logic.
- Systemd service unit templates.
- Image profile manifests and manifest validation tool.
- Default config and hardware profile examples.

## Quick checks

```bash
cd robot-os
python3 -m pytest tests/unit -q
PYTHONPATH=src python3 -m hannah_robot_os doctor
PYTHONPATH=src python3 -m hannah_robot_os sim
python3 tools/validate_manifests.py
./images/build.sh --profile robotos-dev-x86_64
```

## Layout

- `src/hannah_robot_os/` - core service logic
- `systemd/` - systemd units
- `image-profiles/` - image target manifests
- `config/` - default configs and hardware profiles
- `ros2/` - ROS2/ros2_control templates
- `tools/` - build/validation tools
- `tests/` - unit/integration/sim tests

## Safety

HANNAH Robot OS does not allow raw AI/UI commands to directly drive actuators. Motion commands pass through deterministic validation, limits, watchdog, and controller interfaces. Physical E-stop hardware is required for physical robots; software stop is not a safety-rated E-stop.

Speed-ups are limited to `safety.max_acceleration_mps2`; slowing down and stopping are never limited. With `safety.estop_latched` (the default), releasing the emergency stop leaves the robot stopped until an operator reset is recorded. `hannah-robot-os ready` passes only when every required service's status file is recent (within 5 s) and records that service as ready.

The safety-gateway service is the only process that changes the safety state. It publishes the state to `<data_dir>/safety/state.json` every tick, and the motor-controller service follows it: an engaged or latched stop, a fault, or a state the gateway stopped writing (older than four watchdog periods) stops the motors. Ask the gateway with `hannah-robot-os safety engage|release|status`, and `hannah-robot-os safety reset --operator <name>` after a release. This is coordination between processes on one computer, not a safety-rated stop.
