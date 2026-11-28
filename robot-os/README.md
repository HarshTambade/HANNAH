# HANNAH Robot OS

This directory contains the HANNAH Robot OS foundation: onboard Linux service definitions, Python core managers, hardware profiles, ROS2 integration templates, image build manifests, and tests.

## Status

**Experimental / in development.** No physical hardware validation. No OS image boot validation in this dev environment. The motor controller drivers below have been tested against protocol byte vectors and fake transports only. None has been run on a real motor.

## What is implemented

- Core Python package `hannah_robot_os` (config, audit, hardware registry, motor controller manager + sim adapter, safety gateway, sensor manager, service health, update manifest verification, CLI).
- Motor controller drivers for ODrive, Dynamixel and VESC, plus HANNAH's own framed serial protocol, chosen by the hardware profile (see "Motor controller drivers"). They are tested against protocol vectors and fake transports only.
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

## Motor controller drivers

**These drivers have been tested against protocol byte vectors and fake transports (a fake CAN bus and fake serial lines) only. None has been run on a real motor or motor controller.** The first run on hardware must be done with the wheels off the ground and a physical emergency stop that cuts motor power.

The hardware profile picks the driver: `service motor-controller --profile <file>`, or `hardware_profile` in the config. With neither, the service uses the simulated controller, as before. `validate-profile` checks a profile, and the service refuses to start with an invalid one.

| `driver` | Controller | Link | Protocol source |
|---|---|---|---|
| `odrive_can` | ODrive, one CAN node per wheel | CAN (SocketCAN, or python-can) | ODrive docs, "CAN Protocol": Overview, Cyclic Messages, Watchdog, Messages; enum values from the API Reference |
| `odrive_ascii` | One two-axis ODrive | USB or UART serial | ODrive docs, "ASCII Protocol": Command Format, Command Reference |
| `dynamixel_p2` | Two Dynamixel X-series servos in velocity mode | TTL or RS-485 serial | Robotis e-Manual, "Protocol 2.0" sections 2, 3 and 5, and the XM430-W350 control table |
| `vesc_can` | Two VESCs (CAN status messages turned on) | CAN | VESC firmware source: `datatypes.h`, `comm/comm_can.c` |
| `vesc_uart` | A UART VESC, the other wheel reached through it over CAN (`COMM_FORWARD_CAN`) | UART serial | VESC firmware source: `datatypes.h`, `comm/packet.c`, `comm/commands.c` |
| `hannah_framed_serial` | A microcontroller running HANNAH's JSON-line protocol (`motors/protocol.py`), for example to drive hobby ESCs over PWM | serial | This repository. The microcontroller firmware is not part of it. |
| `sim`, `sim_serial_v1` | Simulated controller | none | |

Example profiles are in `config/hardware/`: `odrive-can-diffdrive.json`, `odrive-usb-diffdrive.json`, `dynamixel-diffdrive.json` and `vesc-can-diffdrive.json`. Their IDs, wheel sizes and ports are placeholders. Each real driver needs `drive` (`wheel_separation_m`, `wheel_radius_m`, optional `gear_ratio`, `invert_left`/`invert_right` and `max_wheel_speed_mps`) and driver `options` such as node IDs, servo IDs and pole pairs.

Every packet encoder and decoder has unit tests (`tests/unit/test_motor_protocol_vectors.py`). The Dynamixel tests use the e-Manual's own example packets, and the ODrive ASCII checksum test uses the docs' example. ODrive CAN and VESC publish no example frames, so those vectors were built by hand from the documented field layouts. They check that the code follows those layouts. They don't show that a real device agrees.

How the drivers stay inside the limits. The manager's ramp, limit checks and watchdog are unchanged, and a driver adds:

- **Limits.** Each driver clamps every command to the speed limits and each wheel to the wheel speed limit, even when called directly. Integer units are rounded toward zero. Where the controller has a speed limit of its own, the driver sets it at connect: ODrive `Set_Limits` / `vel_limit`, Dynamixel Velocity Limit. VESC has none here.
- **Stops.** On a watchdog timeout the manager's `stop()` sends zero speed. `stop()` never raises; a failed stop becomes a fault.
- **Emergency stop.** When the safety state is unsafe (engaged or latched stop, fault, or a gateway that stopped reporting), the service sends the driver's emergency stop and holds it disabled. That stop is ODrive `Estop`, Dynamixel torque off, or VESC zero current. When the state is safe again (after an operator reset for a latched stop), the service enables the controller as it does at start-up. Nothing moves until a new command passes the safety gateway and the manager.
- **Transport errors.** A timeout, a bad CRC or checksum, a closed port, or a lost ODrive heartbeat or VESC status stream faults the controller and disables it, and the driver tries once to stop. While the state is safe, the service tries to reconnect every 2 seconds. A driver's `connect()` always leaves the controller disabled. After a successful reconnect, the service enables it as it does at start-up, still at zero speed.
- **Controller faults.** A fault the controller reports itself is never cleared or retried automatically: an ODrive axis error, a Dynamixel hardware alert, a VESC fault code, or an ODrive that left closed loop. The motors stay off until a person clears the fault and restarts the service.

Optional libraries: SocketCAN uses the standard library (Linux only). `"backend": "python-can"` uses python-can, and `"backend": "pyserial"` uses pyserial. The default serial backend is the standard-library POSIX stream. The package imports, and its tests pass, with none of these installed.

Not done or not known: running on any real controller; ODrive firmware older than 0.6, where the error property names differ (see `options.error_property`); Dynamixel models other than X-series (the control table addresses are the X-series ones); VESC position feedback; a firmware for `hannah_framed_serial`; PWM output directly from the computer.

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
