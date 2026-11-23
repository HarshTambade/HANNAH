# HANNAH ROBOT OS — Deployment Guide

Updated: 2026-11-23  
Status: INITIAL/DRAFT. No physical deployment validated.

## Deployment profiles

| Profile | Intended use | Status |
|---|---|---|
| Developer | Dev workstation, simulators, debugging | EXPERIMENTAL |
| Mobile Robot | Differential/omni base with Nav2 | EXPERIMENTAL |
| Robotic Arm | MoveIt2/arm controllers | NOT_STARTED |
| Industrial Edge | Gateway/industrial protocols | NOT_STARTED |
| Inspection Robot | Sensors/nav/mission profiles | NOT_STARTED |

## Install flow (planned)

1. Select validated hardware profile.
2. Download signed HANNAH Robot OS image.
3. Verify checksum and signature.
4. Flash to target storage (explicit approval required).
5. Boot and run first-boot wizard.
6. Enroll device with parent HANNAH OS.
7. Configure motor controllers/sensors/network.
8. Run commissioning and safety checks.
9. Enable mission capabilities only after checks pass.

## First boot wizard

- Set device name, locale, timezone, network.
- Create admin/operator accounts.
- Enroll with HANNAH control plane.
- Import/select hardware profile.
- Verify safety devices (E-stop, watchdog, limits).
- Run diagnostics.

## Offline operation

- Local safety, motor control, sensor management, and approved local missions continue per policy.
- Telemetry and mission updates buffered for sync.
- No cloud dependency for physical safety.

## Administration over the bridge

- Enable `HANNAH_ROBOT_OS_BRIDGE=1` with `HANNAH_ROBOT_OS_BRIDGE_SECRETS` (per-robot shared secrets) and optionally `HANNAH_ROBOT_OS_BRIDGE_OWNERS`.
- Robot OS reports arrive as signed envelopes and are stored account-scoped; admins see them at `/robot-os`.
- Update stage, activation and rollback are Action Engine actions (`robotos.stage_update`, `robotos.activate_update`, `robotos.rollback_update`). They always need a signed-in person's approval; an agent key or standing grant cannot queue them.
- Activation refuses to promote a slot unless the robot's local READY gate passes. The signed-in admin sees every command and the robot's ack in the Command audit table on `/robot-os`.
- Commands expire, carry one-time nonces, and are refused by the robot if its E-stop/fault state or capability allow-list rejects them.

## Recovery

- Boot recovery slot/mode if health checks fail.
- Roll back to last known good version through an approved `robotos.rollback_update` action.
- Preserve audit logs and diagnostic bundle.
