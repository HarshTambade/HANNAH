# HANNAH ROBOT OS — Architecture

**Status:** IN_PROGRESS (Phase 0/1)  
**Updated:** 2026-11-23  
**Product identity:** HANNAH Robot OS — "The intelligence and operating system behind the next generation of robots."

> HANNAH Robot OS is a Linux-based, AI-native robot operating environment. It is not a ROS 2 connector, dashboard, or chatbot. ROS 2 is one robotics middleware component inside a broader OS that manages boot, hardware, motor controllers, sensors, safety, AI, networking, updates, recovery, and integration with the parent HANNAH OS.

## 1. Audit summary (Phase 0)

### Existing HANNAH assets reused

| Existing system | Location | Reuse in Robot OS |
|---|---|---|
| Universal AI Model Gateway | `server/gateway/`, `server/gateway.test.js` | Cloud/local model routing; Robot OS uses it through parent HANNAH API, never for safety-critical control |
| Agent Orchestrator / Specialist Agents | `client/src/services/Orchestrator.ts`, `SpecialistAgents.ts`, `AgentRouter.ts` | Robot mission/navigation/perception/manipulation/maintenance agent coordination |
| Memory Engine | server/client memory services | Mission/config/maintenance history context; no credentials in AI context |
| Voice Engine | existing voice pipeline | "Hey HANNAH" and natural language requests routed through Action Engine/safety |
| Device Registry / Capability Registry | `server/devices/`, `hannah-os/runtime` | Extended for robot hardware components, motor controllers, sensors |
| No-Code Device Onboarding / Hardware Studio | `client/src/components/DevicesPage.tsx`, `HardwareStudio*`, `server/devices/` | Robot Management Wizard extends same no-code pattern |
| Workflow Engine / Webhooks | `server/workflows/`, `server/webhooks/` | Approved automations, robot events, maintenance workflows |
| Security Architecture | `server/vault.js`, `server/devices/safety.js`, `docs/robotics/SECURITY_ARCHITECTURE.md` | Signed commands, vault secrets, permission checks, audit logs |
| API Infrastructure | `server/` Node API | Secure versioned Robot OS <-> parent HANNAH API |
| Robotics Runtime | `robotics/runtime/hannah_robot/` | Base for onboard runtime; extended into Robot OS managed services |
| Robotics Safety Gateway | `server/robotics/safety.js`, `robotics/runtime/hannah_robot/safety.py` | Dual server+robot safety checks preserved and extended |
| ROS2/Gazebo skeleton | `robotics/ros2_ws/`, `robotics/Dockerfile.gazebo` | ROS 2 integration baseline; not yet run on dev machine (blocker B1) |

### Gaps identified

- No installable Linux OS image/build pipeline for robot targets.
- No boot/init/service orchestration for full robot OS lifecycle.
- No dedicated Motor Controller Manager with MCU/controller adapters, watchdog, estop integration.
- No ros2_control hardware interface implementations for real controllers.
- No OS-level update/rollback/recovery image system.
- No unified Robot OS Administration Center.
- No hardware-in-the-loop or physical commissioning evidence.
- ROS 2/Gazebo/Nav2 not run in this environment.

## 2. OS foundation decision

| Option | Evaluation | Decision |
|---|---|---|
| Ubuntu Server 24.04 LTS | Best for dev/ROS2 Jazzy compatibility, broad hardware support, systemd, apt, debugging | **Selected for Desktop/Edge, Robotics dev, Developer profiles** |
| Ubuntu Core 24 | Immutable/transactional updates, snap confinement, secure boot on supported hardware; more packaging work | **Selected target for IoT Gateway/Industrial unattended profiles; image build blocked until Linux build host/snapcraft available** |
| Yocto/OpenEmbedded | Maximum control for board-specific embedded images; high maintenance | **Deferred for specific board-family products after validated target exists** |

Version choices are based on project knowledge as of 2026-11-22/23 and must be re-checked against upstream release pages before first image build.

## 3. Target architecture

```
┌──────────────────── HANNAH Clients (web/desktop/mobile/voice) ────────────────────┐
│ Robot Management Wizard · Robot OS Admin · chat/voice · missions · diagnostics     │
└───────────────────────────────┬───────────────────────────────────────────────────┘
                                │ HTTPS/WSS authenticated, versioned API
┌───────────────────────────────▼───────────────────────────────────────────────────┐
│ Parent HANNAH OS Control Plane (existing Node/server)                              │
│ Model Gateway · Agents · Memory · Voice · Workflows · Fleet · Registry · Audit     │
└───────────────────────────────▲───────────────────────────────────────────────────┘
                                │ outbound-only secure gateway from robot; signed
┌───────────────────────────────┴───────────────────────────────────────────────────┐
│ HANNAH Robot OS (Linux, onboard computer)                                          │
│  systemd / boot / recovery / updates / config / logs / telemetry                    │
│  ┌───────────────────────────────┐  ┌──────────────────────────────────────────┐  │
│  │ Deterministic Safety Boundary │  │ AI / Orchestration Boundary              │  │
│  │ E-stop input, watchdog,       │  │ Local/cloud model routing, NL intents,    │  │
│  │ motion limits, command expiry │  │ mission planning, memory, voice bridge    │  │
│  │ motor enable, fault states    │  │ NEVER directly drives PWM/torque          │  │
│  └───────────────┬───────────────┘  └──────────────────┬───────────────────────┘  │
│                  │                                     │                           │
│  Hardware Manager · Motor Controller Manager · Sensor Manager · ROS2 Runtime        │
│  Nav2/SLAM/perception · Robot Safety Gateway · Diagnostics · Update Manager        │
└───────────────┬───────────────────────────────────────────────────────────────────┘
                │ validated adapters: USB/serial/UART/CAN/Ethernet/I2C/SPI/GPIO
┌───────────────▼───────────────────────────────────────────────────────────────────┐
│ Embedded Motor/Actuator Controllers (MCU/RTOS/dedicated controllers)               │
│ deterministic control loops, encoder read, driver IO, watchdog, fault, enable      │
└───────────────┬───────────────────────────────────────────────────────────────────┘
                │ motor drivers / actuators / sensors / power / estop circuit
            Physical Robot Hardware
```

## 4. Service architecture (systemd-targeted)

| Service | Responsibility | Safety critical | Failure policy |
|---|---|---|---|
| `hannah-robot-os-firstboot.service` | first boot wizard, identity, secure enrollment | no | one-shot, requires operator |
| `hannah-hardware-manager.service` | discovery, hardware registry, driver/profile binding | partial | restart with backoff; no device activation without validation |
| `hannah-motor-controller.service` | controller comms, encoder feedback, limits, watchdog | **yes** | fail-safe stop; no stale commands; alert |
| `hannah-sensor-manager.service` | sensor init/calibration/health/timestamps | partial | degrade capabilities; block unsafe motion if required sensors missing |
| `hannah-ros2-runtime.service` | ROS 2 launch, lifecycle, node health | partial | controlled restart; motion blocked until ready |
| `hannah-navigation.service` | Nav2/SLAM/localization mission execution | partial | cancel/hold on fault |
| `hannah-perception.service` | camera/depth/lidar perception pipelines | no for safety-rated obstacle avoidance | degrade; deterministic obstacle detection remains independent |
| `hannah-safety-gateway.service` | command validation, limits, estop state, expiry | **yes** | independent, highest priority, minimal deps |
| `hannah-ai-runtime.service` | local model runtime, agent bridge, NL interface | no | isolated failure; must not affect safety services |
| `hannah-telemetry.service` | logs/metrics/audit/health export | no | buffered local store |
| `hannah-update-manager.service` | signed staged updates, rollback, recovery markers | partial | never unsafe reboot; rollback on health failure |
| `hannah-remote-gateway.service` | outbound secure parent connection, offline queue | no | local operation continues |

## 5. Boot sequence (profile-dependent)

1. Bootloader / firmware (secure boot where supported).
2. Linux kernel + initramfs.
3. Filesystem mount, integrity checks, A/B slot validation.
4. `hannah-safety-gateway` starts before motion-capable services.
5. Hardware discovery and identity validation.
6. Motor controller manager connects, verifies identity, reads limits/faults; motors remain disabled until checks pass.
7. Sensor manager initializes required sensors; required-sensor failures block READY.
8. ROS 2 runtime and controllers start; ros2_control verifies interfaces.
9. Navigation/perception start per profile.
10. AI runtime, voice, remote gateway, telemetry start.
11. System emits READY only when mandatory hardware, safety, and required profile checks pass.

## 6. Motor control boundary

- AI/cloud/UI **never** send raw PWM/torque/joint velocity directly to actuators.
- All motion requests flow: intent -> Action Engine/permission -> server safety -> signed command -> onboard safety gateway -> motor controller manager -> validated controller interface -> embedded controller.
- Embedded controller enforces deterministic limits, watchdog, enable, faults.
- Communication loss, stale command, watchdog timeout, estop, or invalid feedback => safe stop/fault state.

## 7. Data/config stores

- Hardware registry: local SQLite/Postgres-compatible schema or JSON+SQLite on edge; authoritative local state with sync to parent.
- Secrets: OS keyring/vault/file with restricted permissions; never in AI context.
- Telemetry: local append-only logs + rotating metrics; offline buffer.
- Updates: signed manifests, versioned slots, recovery markers.

## 8. Security model

- Secure enrollment with device identity keys.
- Signed commands, signed updates, signed profiles/packages.
- Least privilege systemd users/capabilities.
- Network segmentation: no public ROS2 DDS exposure; remote access through authenticated gateway.
- Treat AI output, manuals, packages, drivers, network messages as untrusted input.

## 9. Implementation status

See `HANNAH_ROBOT_OS_IMPLEMENTATION_TRACKER.md`. This architecture is being implemented incrementally; unverified items are explicitly marked.
