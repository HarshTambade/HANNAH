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
PYTHONPATH=src python3 -m pytest tests/unit -q
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
