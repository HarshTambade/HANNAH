# HANNAH Robotics — Block 1 audit of the existing codebase

Date: 2026-11-21. Written before any robotics code, from the source at commit `1f9f1a1` (version 1.7.0, `main` equal to `origin/main`). Everything below was read in source; nothing is taken from older documents.

## 1. What HANNAH is today

| Part | Where | What it is |
|---|---|---|
| Server | `server/` (Node, Express, CommonJS) | The API, accounts, the model gateway, workflows, the Action Engine, the coding service. Runs as one process, or as Vercel functions for hannah.eliteforums.in. |
| App | `client/` (React, TypeScript, Vite) | One web app; the same build runs in the browser, as a PWA, in Electron (desktop) and in Capacitor (Android, iOS). |
| Database | `server/db/` | SQLite locally, Postgres in production (Neon). 17 numbered migrations in `server/db/migrations.js`. |
| Older Python service | `backend/` | A FastAPI service from an earlier design, tested in CI (`pytest backend/tests`). Not used by the app's main paths. |
| Others | `cli/`, `sdk/js`, `e2e/`, `apps/`, `ebpf/` | A command-line client, the JavaScript SDK, Playwright browser tests, older app shells, an experiment. |

CI (`.github/workflows/build.yml`) runs a secret scan, licence check, dependency audit, lint, typecheck, client tests (vitest), server tests (`node --test`), the Python backend tests, the Playwright suite, and the web, Electron, Android and iOS builds.

## 2. The parts robotics must reuse

### Action Engine — `server/actions/engine.js`
One path for anything HANNAH does in the world: permission → approval → execute once → verify → record. An action is a definition with `normalize`, `assess`, `preview`, `execute` and `verify`. "done" means the destination confirmed it; "unverified", "failed" and "unknown" are separate states. Idempotency keys prevent a second execution.

**For robotics:** every robot capability becomes an engine action. Robots get no second permission system and no second history.

**Gap found:** an action's execution is expected to finish inside one request. A robot mission runs for minutes. Missions need their own durable record (as coding tasks have in `hannah_coding_tasks`); the engine action is "start this mission", confirmed when the robot accepts it.

### Permission manager — `server/actions/permissions.js`
Nine services, five levels each (default: approve each action), standing grants limited by action, resource, daily count, hours and end date. Deleting and paying always ask. A flag raised by an action's own checks forces approval; a `forbidden:` flag refuses. The emergency stop denies everything but reading.

**For robotics:** a tenth service, `robots`. Grants scoped to one robot id work with the existing resource matching.

**Gap found:** while the emergency stop is on, every non-read action is denied, which would also deny "stop the robot". Stopping must always be allowed. The evaluator needs one new, narrow rule for actions that only reduce what is happening.

### Who may approve — `server/actions/router.js`
A signed-in person or a developer key can ask for actions and read history. Only a signed-in person can approve, change levels, add grants or resume from a stop.

**For robotics:** the same split. Only a signed-in person can enroll, reconfigure or remove a robot.

### Paired-device precedent — `server/phone-bridge.js`
The closest existing pattern to a robot: a one-time pairing code stored as a hash, a device key, requests signed over id, time, method, path and body hash, 60-second command expiry, a nonce per command, a device counted offline after 45 seconds, results accepted once and only in a valid order, and states limited to what can be verified.

**For robotics:** the same design, with two differences. A robot is not signed in to an account, so its requests carry their own authentication. And a robot's runtime should need nothing beyond the Python standard library, which has HMAC but no elliptic-curve signatures, so robots use a per-device secret and HMAC-SHA256 instead of P-256.

### Secret storage — `server/vault.js`
Envelope encryption (AES-256-GCM) bound to the owning user and a provider id. Already used for provider keys and the GitHub token.

**For robotics:** the per-robot secret is sealed here. A server without a vault key refuses enrollment.

### Agents and tools — `client/src/services/`
- `DeviceTools.ts`: `executeHANNAHTool` is the single tool entry. A tool with `engine: { action, params }` runs through the Action Engine for a signed-in account.
- `Operator.ts`: the engine's client and the tools built on it.
- `SpecialistAgents.ts`: four specialists (research, coding, memory, tasks), each a name, instructions and a tool list.
- `AgentRouter.ts`: picks tool families for a request by pattern.
- `server/orchestrate.js`: the Team orchestrator that delegates to specialists.

**For robotics:** robot tools are engine tools; the Robot Agent is a fifth specialist. Nothing else is needed for the orchestrator to delegate to it.

### Workflows and MCP — `server/workflows/`, `server/mcp-core.mjs`
The workflow node `action.run` and the MCP tool `hannah_action` already call any engine action. Robot capabilities become available to both with no new code, under the same permissions.

### Interface — `client/src/components/AppShell.tsx`, `client/src/routes.ts`
Screens are real paths. The shell has eight sections; the phone bar is a fixed eight-column grid.

**For robotics:** one new screen, `/robotics`, in the existing shell and design tokens.

## 3. Existing hardware code, and why robots don't build on it

| File | What it does | Finding |
|---|---|---|
| `client/src/services/HardwareAdapter.ts` | A WebSocket "HANNAH device protocol" from the browser straight to a device: hello, pairing code, command, ack. | Works for a speaker or sensor box near the app. Unsuitable for robots: the browser tab is the controller, there is no server record, no permission check, no safety validation, no command expiry, and it dies with the tab. |
| `HardwareBridgeService.ts`, `HardwarePartnershipRegistry.ts`, `HardwareSettings.tsx` | A thin wrapper, an in-memory device list, a pairing form. | In memory only. Kept as they are. |
| `client/src/services/KillSwitch.ts` | A flag in the browser's local storage. | Not a stop for any device. Not used for robots. |
| `DigitalTwinPanel.tsx` | Shows the personal knowledge graph. | Unrelated to robot digital twins despite the name. |

The directive says to keep the desktop and Capacitor architectures intact. None of these files is changed. Robot control does not pass through a browser tab.

## 4. What does not exist

- Any robot, ROS 2, Gazebo or simulation code.
- A device registry on the server (phones are the only enrolled devices).
- A capability contract (tools are described for the model, not as contracts with preconditions, risk, timeouts and verification).
- Authentication for a device that is not a person's signed-in session.
- A long-running job owned by a device.
- Any safety validation of a physical command.

## 5. Architectural changes robotics requires

1. **An onboard runtime.** A robot must stay safe with no internet, no HANNAH server and no model. So the last check before motion, the limits, the watchdog and the stop behaviour live on the robot's own computer, in a new program that is not part of the web app or the server.
2. **Outbound-only connection.** The robot calls the server (HTTPS, signed requests); the server never opens a connection to a robot. This works behind NAT and on the Vercel deployment, and leaves no listening port on the robot.
3. **Missions as durable records.** New tables for robots, missions, telemetry and device events (migration 18).
4. **A de-escalation rule in the permission evaluator**, so stopping is never blocked.
5. **Robot routes outside account auth.** The device endpoints authenticate the robot itself; `api-security.js` must let them through and nothing else.
6. **A second test language.** The onboard runtime is Python (ROS 2's own language), so CI gains a Python unit-test step and a test that runs server and runtime together.

## 6. This development machine

| Item | Found |
|---|---|
| OS, CPU | macOS 27.0.1, arm64, 16 GB RAM, 17 GB free disk |
| Python, Node | 3.14.6, 25.9.0 |
| Docker, Podman | Not installed |
| ROS 2, Gazebo, colcon, CMake | Not installed |

ROS 2 and Gazebo are not installed here, and the attempt to add a self-contained install (RoboStack through pixi) was refused by the session's permission rules. So no Gazebo or Nav2 run is claimed anywhere in Block 1. The ROS 2 and Gazebo files are written and marked "not run"; `robotics/README.md` gives the commands to run them.

## 7. Version choices checked against the official matrices (2026-11-21)

- Gazebo's ROS pairing table (gazebosim.org/docs/latest/ros_installation) recommends: Humble with Fortress, **Jazzy with Harmonic**, Kilted with Ionic, **Lyrical with Jetty**.
- ROS 2 distributions: Jazzy Jalisco (May 2024, supported to May 2029) and Lyrical Luth (May 2026, supported to May 2031) are the two current long-term releases; Kilted ends December 2026. (docs.ros.org refused automated reading; dates are from endoflife.date.)
- Nav2 builds binaries for Humble, Jazzy and Lyrical (its README's build table).
- NVIDIA's current Isaac ROS release (5.1) states it is tested with Lyrical.
- RoboStack publishes `ros-jazzy-ros-gz-sim` and `ros-jazzy-nav2-bringup` for macOS arm64 and Linux.
- Not confirmed: micro-ROS and MoveIt 2 on Lyrical (their pages could not be read today).

**Choice for Block 1: ROS 2 Jazzy with Gazebo Harmonic** on Ubuntu 24.04. It is the older of the two long-term pairs, every listed framework has a release for it, and its interfaces are the ones this code was written against. HANNAH's bridge uses only standard message and action types, so moving to Lyrical with Jetty is a packaging change. That move is a Block 2 decision, mainly because the current Isaac ROS targets Lyrical.
