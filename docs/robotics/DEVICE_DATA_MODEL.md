# Robot device data model

Migrations 18 and 19 (`server/db/migrations.js`) add six tables. Both are additive. Every row belongs to one account; a robot belongs to exactly one account.

## `hannah_robots` — the registry

| Directive field | Stored as | Set by |
|---|---|---|
| Unique device ID | `id` (`rb_` + 18 hex characters, unique across all accounts) | Server, at creation |
| Robot name | `name` (unique per account) | Owner |
| Manufacturer, model | `profile.manufacturer`, `profile.model` | Robot, at enrollment |
| Hardware category | `profile.category` (mobile-base, manipulator, mobile-manipulator, aerial, stationary-sensor, other) | Derived from the robot type |
| Robot type | `profile.robotType` (differential-drive, omnidirectional, ackermann, legged, manipulator-arm, mobile-manipulator, multirotor, sensor-station, other) | Robot |
| Operating system, compute platform | `profile.os`, `profile.compute` | Robot |
| ROS distribution | `profile.rosDistro` (empty when the robot doesn't run ROS) | Robot |
| Supported protocols | `profile.protocols` | Robot |
| Connected sensors | `profile.sensors` `[{id, type, description}]` | Robot |
| Available actuators | `profile.actuators` `[{id, type, description}]`, `profile.devices` (switchable on/off devices) | Robot |
| Registered capabilities | `capabilities` (ids accepted against the contract); `profile.refusedCapabilities` with the reason for each one refused | Robot offers, server decides |
| Network connection details | `profile.network` (transport, exchange interval), `profile.hostname`, `last_seen_at` | Robot and server |
| Safety configuration | `safety` = `{reported, owner, reportedAt}`: the robot's own limits, the owner's tighter ones | Robot and owner |
| Software, firmware, runtime version | `profile.softwareVersion`, `profile.firmwareVersion`, `profile.runtimeVersion`, `profile.adapter` | Robot |
| Device ownership | `user_id` | Server |
| Permission configuration | `permissions` = `{disabled: [capability ids], alwaysAsk: [capability ids]}`; the account's level for the Robots service is in `hannah_permissions` | Owner |
| Current operating state | `status` (pending, enrolled, revoked), `mode` (idle, navigating, holding, stopping, docked, estopped, fault), `state` (the last full report), `last_seen_at` | Server and robot |

Also stored: `simulated` (what the owner declared) and `simulator` (what the runtime reported, for example `hannah-kinematic`); `profile.places`, `profile.dock`, `profile.world` (an outline for the map view); `enroll_hash` and `enroll_expires_at` (a pending one-time code, as a hash); `key_id`, `wrapped_key`, `ciphertext` (the robot's secret, sealed by the vault); `counter` (the last request number accepted from the robot); `created_at`, `enrolled_at`, `revoked_at`.

The profile is a JSON document, so a new kind of robot adds fields without a migration. Nothing in the schema names a manufacturer.

**Derived, never stored:** `connection` (awaiting-enrollment, never-connected, online, offline, revoked) and `online`. A robot is online when it reported in the last 12 seconds. An offline robot's `mode` is shown as `offline`, whatever it last said.

## `hannah_robot_missions`

One row per command sent or queued for a robot.

| Column | Meaning |
|---|---|
| `id`, `robot_id`, `capability`, `params` | What was asked. `params` are the values sent: places resolved to coordinates, the speed ceiling applied |
| `status` | queued, sent, accepted, succeeded, unverified, failed, cancelled, rejected, timed-out. `expired` and `lost` are computed when read and written at the next exchange |
| `action_id` | The Action Engine record that started it: who asked, the permission decision, the approval |
| `seq`, `nonce` | The command's sequence number and nonce |
| `issued_at`, `expires_at` | When the command stops being valid if not yet accepted |
| `deadline_at` | When the mission must have finished |
| `sent_at`, `accepted_at`, `finished_at`, `cancel_requested_at` | What happened, when |
| `progress`, `result` | What the robot reported |
| `verification` | `{confirmed, evidence, checkedAt}`: the server's own check of the result |
| `error` | The reason for a refusal, failure or cancellation |

## `hannah_robot_telemetry`

`(robot_id, at)` → a sample: position, heading, linear and angular speed, battery, mode, emergency-stop state. One sample every three seconds while the robot reports; two hours are kept. The full last report is in `hannah_robots.state`, not here.

## `hannah_robot_events`

What a robot or the server recorded about a robot: created, enrolled, an enrollment refused, emergency stop engaged or released, a fault, a command the robot refused, link lost and restored, stop requested, revoked. Each has a time, a severity, a message and its source (`robot` or `server`). Thirty days are kept.

## Retention

| Data | Kept |
|---|---|
| Robot record | Until the owner removes it |
| Missions | 180 days |
| Events | 30 days |
| Telemetry samples | 2 hours |
| Action Engine records for robot actions | 180 days (the engine's rule) |

Removing a robot deletes its missions, events and telemetry. The Action Engine's records of what was asked remain in the account's history.

## Added by migration 19

| Where | What |
|---|---|
| `hannah_robots.commissioning` | A physical robot's commissioning record: when it started, each confirmed step with its time, note and the facts seen, and the reason if it was withdrawn |
| `hannah_robots.config_version` | The **device configuration version**: goes up with every change a person makes (limits, capabilities, destinations) |
| `profile.serialNumber`, `profile.fingerprint` | The serial number the robot reports; a short fingerprint of its secret, shown on both sides |
| `hannah_robot_destinations` | A destination a person defined or approved: name, **map**, **frame**, x, y, heading, source (`owner` or `robot-profile`) |
| `hannah_robot_missions.pause_requested_at`, `resume_requested_at`, `paused_at`, `control_nonce` | Pause and resume. A mission's status can also be `paused` |
| `hannah_robot_maintenance` | A maintenance log: time, kind, note |

Not stored anywhere: maps themselves (the robot holds its map; HANNAH stores an outline for display and the map's name), sensor recordings, camera images, firmware metadata. There is no object storage or time-series database for robots.
