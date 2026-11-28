# HANNAH Robot OS

This directory contains the HANNAH Robot OS foundation: onboard Linux service definitions, Python core managers, hardware profiles, ROS2 integration templates, image build manifests, and tests.

## Status

**Experimental / in development.** No physical hardware validation. The disk image below has a build definition and a CI build-and-boot check, but **no image has been built or booted yet**: the definition was written on a Mac without Docker, QEMU or mkosi, and it stays unverified until `robot-os-image-ci.yml` (or the owner) runs it on Linux. Not safety certified. The motor controller drivers below have been tested against protocol byte vectors and fake transports only. None has been run on a real motor.

## What is implemented

- Core Python package `hannah_robot_os` (config, audit, hardware registry, motor controller manager + sim adapter, safety gateway, sensor manager, service health, update manifest verification, CLI).
- Motor controller drivers for ODrive, Dynamixel and VESC, plus HANNAH's own framed serial protocol, chosen by the hardware profile (see "Motor controller drivers"). They are tested against protocol vectors and fake transports only.
- Unit tests for core safety/motor/sensor/health/update logic.
- Systemd service unit templates.
- Image profile manifests and manifest validation tool.
- A bootable disk image definition (mkosi, Debian 13) for x86_64 UEFI, generic arm64 UEFI and Raspberry Pi 4/5, with first-boot setup and A/B update bookkeeping. See "Disk image".
- Default config and hardware profile examples.

## Quick checks

```bash
cd robot-os
python3 -m pytest tests/unit -q
PYTHONPATH=src python3 -m hannah_robot_os doctor
PYTHONPATH=src python3 -m hannah_robot_os sim
python3 tools/validate_manifests.py
./images/build.sh --profile robotos-dev-x86_64 --dry-run   # assembles the mkosi project, builds nothing
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
- `image-profiles/` - image target manifests (each names its mkosi board, arch and kernel)
- `images/` - `build.sh`, the mkosi configuration (`images/mkosi`) and the QEMU boot check
- `config/` - default configs and hardware profiles
- `ros2/` - ROS2/ros2_control templates
- `tools/` - build/validation tools
- `tests/` - unit/integration/sim tests

## Safety

HANNAH Robot OS does not allow raw AI/UI commands to directly drive actuators. Motion commands pass through deterministic validation, limits, watchdog, and controller interfaces. Physical E-stop hardware is required for physical robots; software stop is not a safety-rated E-stop.

Speed-ups are limited to `safety.max_acceleration_mps2`; slowing down and stopping are never limited. With `safety.estop_latched` (the default), releasing the emergency stop leaves the robot stopped until an operator reset is recorded. `hannah-robot-os ready` passes only when every required service's status file is recent (within 5 s) and records that service as ready.

The safety-gateway service is the only process that changes the safety state. It publishes the state to `<data_dir>/safety/state.json` every tick, and the motor-controller service follows it: an engaged or latched stop, a fault, or a state the gateway stopped writing (older than four watchdog periods) stops the motors. Ask the gateway with `hannah-robot-os safety engage|release|status`, and `hannah-robot-os safety reset --operator <name>` after a release. This is coordination between processes on one computer, not a safety-rated stop.

## Disk image

`images/build.sh --profile <id>` builds a GPT disk image with [mkosi](https://github.com/systemd/mkosi) (version pinned in `images/mkosi/VERSIONS`, v25.3). mkosi was chosen over debos because it builds UEFI images with systemd-boot, unified kernel images, systemd-repart partitions and systemd-sysupdate-ready A/B slots from one declarative config, without Docker, and has its own GitHub Action. Yocto was ruled out as too heavy. Building needs Linux; on macOS use `--dry-run`, which assembles the project in `images/out/<profile>/project` and prints the mkosi command.

| Profile | Board | Kernel | CI |
| --- | --- | --- | --- |
| `robotos-dev-x86_64` | x86_64 UEFI | Debian standard | built and booted in QEMU on every image change |
| `robotos-industrial-x86_64` | x86_64 UEFI | Debian PREEMPT_RT (`linux-image-rt-amd64`) | manual dispatch (`rt`), booted, kernel checked |
| `robotos-dev-arm64` | arm64 UEFI (QEMU virt, Ampere, Jetson-style UEFI boards) | Debian standard | manual dispatch (`arm64`), boot attempt informational |
| `robotos-jetson-orin-arm64` | arm64 UEFI | Debian standard; **no NVIDIA L4T kernel**, so no GPU or camera drivers | not built in CI |
| `robotos-rpi5-arm64` | Raspberry Pi 4/5 firmware boot | Debian standard | manual dispatch (`arm64`), build only |

`--rt` switches any profile to the PREEMPT_RT kernel. Debian 13 is the base because it ships that kernel; Ubuntu's needs Ubuntu Pro. ROS 2 is not in the image (`hannah-ros2-runtime` is skipped when `/opt/ros/jazzy` is absent).

What the image does:

- **Partitions:** EFI system partition, root slot A (ext4, mounted read-only), root slot B (empty, `_empty`, same size, for `systemd-sysupdate`), and `/var`, the only writable partition. `/home` points into `/var`. Each root slot's `/etc/fstab` names its own slot.
- **Boot:** systemd-boot loads a unified kernel image. `hannah-boot-ready.service` waits for `hannah-robot-os ready`, prints `HANNAH Robot OS READY` and `HANNAH-BOOT-CHECK: PASS` on the console, and is required by `boot-complete.target`, so a boot that never gets READY is not marked good and systemd-boot's boot counting falls back after three tries. On the Raspberry Pi there is no UEFI or boot counting: the Pi boots slot A only.
- **Accounts:** `hannah` runs the services (no shell, no home, no sudo, in `dialout`). `hannah-admin` is the one login, SSH public keys only, passwordless sudo. Root is locked. No account has a password; a provisioning file that contains one is refused.
- **First boot** (`hannah-robot-os firstboot`): copy `hannah/provision.json` onto the EFI partition (or the Pi's firmware partition) before the first boot, for example `{"hostname": "rover-1", "ssh_authorized_keys": ["ssh-ed25519 AAAA... you@laptop"], "ssh_allow_from": ["192.168.1.0/24"], "enrollment": {"server": "https://...", "token": "..."}}`. All fields are optional. It sets the hostname and robot ID, installs the keys, makes this robot's SSH host key, opens SSH only from the listed networks, stores the enrollment token for the service user (0600), and deletes the file. Without keys there is no way to log in, by design.
- **Firewall:** nftables, inbound dropped except replies, ICMP essentials and DHCP; outbound allowed, matching the remote gateway's outbound-only connection. SocketCAN is not affected.
- **Motor controllers:** udev rules give `/dev/hannah/odrive`, `/dev/hannah/dynamixel` (U2D2, 1 ms FTDI latency) and `/dev/hannah/vesc`, plus `-<serial>` names that stay stable across ports, group `dialout`, mode 0660. The U2D2 (FTDI 0403:6014) and VESC (STM32 0483:5740) IDs are shared with other products. SocketCAN modules load at boot and `can*` interfaces come up at 500 kbit/s (`80-hannah-can.network`; ODrive ships at 250 kbit/s).
- **Hardening and limits:** journald capped (256 MB on disk), systemd pets the hardware watchdog (30 s), kernel sysctl hardening, no per-robot secret in the image (SSH host keys removed, empty machine ID), units sandboxed with `ProtectSystem=strict`.
- **Updates:** `hannah-update.timer` runs `systemd-sysupdate` with `Verify=yes` (GPG-signed `SHA256SUMS`) only when the image was built with `--update-url` and `--update-pubring`, and only while the software stop is engaged (`hannah-robot-os update gate`). It records the pending version in the existing `UpdateState`; after the reboot `hannah-robot-os update confirm` promotes it once READY passes, or records the rollback when the boot loader fell back.
- **Branding:** `os-release` (`NAME="HANNAH Robot OS"`, with `HANNAH_SAFETY_NOTICE`), motd, `/etc/issue` and a plymouth theme (`--splash`), all saying it is not safety certified.

Not done or not verified:

- No image has been built or booted. The CI boot check is the first test of the mkosi configuration, which was written from mkosi's documentation without running mkosi.
- No hardware boot: no PC, Raspberry Pi, Jetson or industrial computer. Jetson needs NVIDIA's L4T kernel, which the image doesn't have.
- PREEMPT_RT latency has not been measured; no CPU isolation is configured.
- A/B switching has not been exercised: there is no update server, no signing key and no published update payload (root partition and kernel image as `.xz`). On the Pi nothing switches slots.
- `/var` does not grow to fill a larger disk.
- The machine ID changes every boot (empty machine ID on a read-only root); the lasting identity is `/var/lib/hannah-system/robot-id`.
- Packages come from the live Debian archive unless `DEBIAN_SNAPSHOT` is set in `images/mkosi/VERSIONS`; the versions used are in the build's manifest.
- No secure boot, measured boot or disk encryption.
