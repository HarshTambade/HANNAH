# HANNAH ROBOT OS — Hardware Compatibility

Updated: 2026-11-23  
Status: INITIAL/UNVALIDATED. No physical hardware has been validated in this session.

## Compatibility policy

- **NOT_SUPPORTED**: no profile/adapter.
- **EXPERIMENTAL**: adapter/profile exists, sim or static validation only.
- **HIL_TESTED**: tested with hardware-in-loop controller/simulator.
- **PHYSICALLY_COMMISSIONED**: validated on real hardware with commissioning checklist and evidence.

## Target profiles

| Profile | Arch | Base OS | Status | Evidence | Notes |
|---|---|---|---|---|---|
| robotos-dev-x86_64 | amd64 | Ubuntu Server 24.04 LTS | EXPERIMENTAL | build definitions only | No image build/boot run |
| robotos-dev-arm64 | arm64 | Ubuntu Server 24.04 LTS | EXPERIMENTAL | build definitions only | No image build/boot run |
| robotos-rpi5-arm64 | arm64 | Ubuntu Server 24.04 LTS / Core eval | NOT_SUPPORTED | — | Requires board validation |
| robotos-rpi5-arm64 | arm64 | Ubuntu Server 24.04 LTS eval | NOT_SUPPORTED | profile entry added | Requires board/BSP validation and boot test |
| robotos-industrial-x86_64 | amd64 | Ubuntu Core 24 eval | NOT_SUPPORTED | profile entry added | Requires transactional update validation on target |
| robotos-jetson-orin-arm64 | arm64 | Ubuntu/NVIDIA L4T-based eval | NOT_SUPPORTED | profile entry added | Requires Jetson-specific BSP validation |
| robotos-industrial-x86_64 | amd64 | Ubuntu Core 24 eval | NOT_SUPPORTED | — | Requires transactional update validation |

## Motor controllers

| Controller | Interface | Adapter | Status | Evidence |
|---|---|---|---|---|
| Simulated Serial Motor Controller | serial/TCP sim | `sim_serial_v1` | IMPLEMENTED | unit tests planned |
| Generic ros2_control system interface | ros2_control | `ros2_control_generic` | IMPLEMENTED | config/static tests planned |
| ODrive/CANopen/Modbus controllers | CAN/USB/UART | — | NOT_SUPPORTED | requires hardware/docs |

## Sensors

| Sensor type | Adapter | Status | Notes |
|---|---|---|---|
| Camera (V4L2/ROS2) | planned | EXPERIMENTAL | config/templates only |
| LiDAR (ROS2 driver) | planned | EXPERIMENTAL | config/templates only |
| IMU | planned | EXPERIMENTAL |  |
| GPS/GNSS | planned | NOT_SUPPORTED |  |
| Battery monitor | planned | EXPERIMENTAL |  |
| Encoders | controller feedback | EXPERIMENTAL | through motor controller manager |

## Controller transport profiles

Hardware profiles now carry a validated `transport` block per controller:

| Kind | Required fields | Validation |
|---|---|---|
| `sim` | - | timeout_ms/retries bounds |
| `serial` | `path` | baudrate positive integer, timeout/retries |
| `can` | `interface` | channel 0-255, mtu >= 8, timeout/retries |

Profiles also validate `limits` (positive speed/acceleration values) and `safety` (`watchdog_timeout_ms <= command_ttl_ms`; physically commissioned profiles must declare `requires_physical_estop`). See `robot-os/src/hannah_robot_os/profiles/schema.py`.

## Physical commissioning record

None. All physical commissioning entries must include date, operator, hardware serials, checklist, test logs, and pass/fail evidence.
