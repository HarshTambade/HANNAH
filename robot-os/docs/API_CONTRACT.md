# HANNAH Robot OS <-> Parent HANNAH API Contract (Draft)

Status: DRAFT/IMPLEMENTED-IN-PART (envelope/queue stubs). No production endpoint deployed.

## Principles

- Robot initiates outbound connection (NAT/firewall friendly).
- All commands signed, time-limited, nonce-protected.
- Telemetry/events buffered offline and synced when connected.
- AI/cloud never bypasses local safety gateway.

## Envelope

```json
{
  "envelope_id": "env_...",
  "robot_id": "robot-dev",
  "ts_ms": 1795412231982,
  "kind": "telemetry|event|command_ack|heartbeat|sync_request",
  "payload": {},
  "nonce": "...",
  "signature": "..."
}
```

## Flows

### Robot -> Parent
- `heartbeat`: liveness, service summary, safety state.
- `telemetry`: sensor/motor/nav/health metrics.
- `event`: alerts, faults, mission state changes.
- `command_ack`: accepted/rejected/completed/failed with evidence.

### Parent -> Robot (signed command)
- Implemented capabilities: `update.stage`, `update.activate`, `update.rollback`, `diagnostics.run`.
- Commands are queued only by Action Engine actions `robotos.stage_update`, `robotos.activate_update` and `robotos.rollback_update`; all `standing: false`, so a signed-in person must approve every one.
- `update.activate` promotes a staged slot only if the robot's own READY gate passes; the parent cannot claim the robot is healthy. Bootloader slot switching/reboot remains a separate, unimplemented image-integration step.
- Command signature: `HMAC-SHA256(secret, id\nrobotId\ncapability\nissuedAt\nexpiresAt\nnonce\nsha256(params))` (`server/robotics/robot_os_commands.js`, `network/command_guard.py`).
- Robot sends a signed `heartbeat` or `sync_request` envelope and receives pending commands in the response; it returns a `command_ack` envelope.
- Robot validates signature, expiry, nonce replay, capability allow-list, and local safety state before execution. No raw actuator command is accepted.
- Stored in `hannah_robot_os_commands` (migration 28); account list at `GET /api/robots/os/commands`.

## Offline behavior

- Local safety and approved local operations continue.
- Outbound envelopes queued in `OfflineQueue` (bounded).
- Sync replay uses idempotent envelope IDs.

## Security

- TLS + device identity.
- Envelope signature: `HMAC-SHA256(secret, robot_id\n ts_ms\n envelope_id\n kind\n sha256(payload))` (`server/robotics/robot_os_auth.js`).
- Verification checks clock skew (60s), signature before replay (bounded seen cache), and known robot secret.
- Endpoint `POST /api/robotos/bridge` is opt-in with `HANNAH_ROBOT_OS_BRIDGE=1` and a JSON secret map `HANNAH_ROBOT_OS_BRIDGE_SECRETS`; disabled returns 404.
- Secrets never included in AI context.
- No public ROS2 DDS exposure.
- Accepted envelopes are stored durably in `hannah_robot_os_envelopes` (migration 27), keyed by `envelope_id` (idempotent), linked to an owner from the robot registry or `HANNAH_ROBOT_OS_BRIDGE_OWNERS`.
- Account-scoped list: `GET /api/robots/os/envelopes?robot=&kind=&limit=`.
