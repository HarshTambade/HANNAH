# HANNAH Robotics — architecture (Block 1)

HANNAH Robotics is an intelligence and orchestration layer for robots. It is not an operating-system kernel and not a controller. It sits on top of the robot's operating system and robotics framework (ROS 2), tells a robot *what* to do in high-level terms, and leaves *how to move* to the robot's own planner and controller.

Read this first; the other documents in this folder go into each part.

| Document | What it covers |
|---|---|
| [HARDWARE_ABSTRACTION.md](./HARDWARE_ABSTRACTION.md) | The adapter interface between the runtime and a robot |
| [DEVICE_DATA_MODEL.md](./DEVICE_DATA_MODEL.md) | The robot registry: every stored field |
| [CAPABILITY_CONTRACT.md](./CAPABILITY_CONTRACT.md) | The operations a robot can be asked for |
| [SAFETY_GATEWAY.md](./SAFETY_GATEWAY.md) | Every check between a request and a moving robot; applicable standards |
| [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) | Identity, enrollment, signed commands, firmware-update design |
| [ROS2_GAZEBO_INTEGRATION.md](./ROS2_GAZEBO_INTEGRATION.md) | The ROS 2 adapter and the Gazebo robot (written, not yet run) |
| [TESTS.md](./TESTS.md) | What was tested, at which level, and what was not |
| [BLOCK2_PREREQUISITES.md](./BLOCK2_PREREQUISITES.md) | What has to be true before work with ROS 2, Gazebo or hardware can go on |
| [ONBOARDING_AND_COMMISSIONING.md](./ONBOARDING_AND_COMMISSIONING.md) | Adding a robot; the eleven commissioning steps before a physical robot may move |
| [NAVIGATION_AND_MISSIONS.md](./NAVIGATION_AND_MISSIONS.md) | Destinations, a mission's life, pause and resume, worlds and scenarios |
| [SENSORS_AND_PERCEPTION.md](./SENSORS_AND_PERCEPTION.md) | Readings, sensor health, what the range sensor detects |
| [FLEET.md](./FLEET.md) | Choosing a robot, conflicts, condition and maintenance |
| [MANIPULATION.md](./MANIPULATION.md) | Arms: a pick and place in the built-in arm simulator; MoveIt 2 not started |
| [DEVELOPER_SDK.md](./DEVELOPER_SDK.md) | Adding robots, capabilities, worlds and packages; the HTTP API; the JavaScript client; webhooks |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Putting the runtime on a robot's computer; the health check; the service unit |
| [REFERENCE_ROBOT.md](./REFERENCE_ROBOT.md) | What a first physical robot has to provide, by function |
| [INDUSTRIAL_AND_IOT.md](./INDUSTRIAL_AND_IOT.md) | An evaluation of Home Assistant, MQTT, Modbus, OPC UA, PLCs and CAN. MQTT and Modbus TCP have since been built in the device hub (`hannah-os/`); the rest are not |
| [robotics/PROGRESS.md](../../robotics/PROGRESS.md) | **Start here for what works:** every requirement with its real state, tests and blockers; milestones; known limitations |

## 1. The one rule

**A language model never controls an actuator.** It can only choose among named capabilities and fill in their inputs. Everything between that choice and a wheel turning is code that does not involve a model:

```
A person's request
  → the model picks a capability and its inputs            (client: Robot Agent, or any agent with robot tools)
  → Action Engine: permission level, standing grants        (server/actions)
  → Safety Gateway, server side: valid for this robot? ready?   (server/robotics/safety.js)
  → approval by a signed-in person, when required
  → Safety Gateway again, at the moment of sending
  → a signed command that expires in seconds                (server/robotics/service.js)
  ─────────────── network; the robot opens the connection ───────────────
  → signature, robot id, expiry, sequence                   (runtime: protocol.py)
  → Safety Gateway, robot side: the robot's own limits      (runtime: safety.py)
  → the robot's planner and controller                      (Nav2, or the built-in simulator's navigator)
  → the base controller's own speed, acceleration and timeout limits
  → motion
  → state reports → the server checks the result against the goal → the person is told what was verified
```

The robot stays safe with everything above the dashed line gone. That is why there are two gateways: the server's exists so a bad request is refused early and explained; the robot's exists because the robot must not rely on the server.

## 2. Modules

The directive names seven. Here is where each lives and how far Block 1 took it.

| Module | Where | State after Block 1 |
|---|---|---|
| **A. Robotics intelligence** (language understanding, task interpretation, model routing, planning, orchestration, memory) | Existing HANNAH: the model gateway, `Orchestrator.ts`, `AgentRouter.ts`, memory. New: four robot agents in `SpecialistAgents.ts` and 21 robot tools in `client/src/services/Robotics.ts` | Working with a scripted server; no live model has driven them. Mission planning is single-step (one capability per request, or a list of points); multi-step plans come from the existing Team orchestrator |
| **B. Robotics runtime** (lifecycle, state, capability registration, task execution, monitoring, local operation) | `robotics/runtime/hannah_robot/` (Python, standard library only) | Working, tested with the built-in simulator |
| **C. Hardware abstraction layer** (drivers, sensor and actuator adapters, discovery, capability descriptions) | `robotics/runtime/hannah_robot/hal/` | Interface and three adapters (mobile-robot simulator, arm simulator, ROS 2). Discovery is the adapter describing itself at enrollment; there is no network scan |
| **D. ROS 2 integration** (nodes, topics, services, actions, state, lifecycle, health) | `hal/ros2.py`, `hal/ros2_watchdog.py`, `robotics/ros2_ws/src/hannah_sim` | **Written, never run.** Lifecycle management is limited to checking that Nav2's action server is available |
| **E. Safety and permission gateway** | `server/robotics/safety.js`, `server/actions/permissions.js`, runtime `safety.py` and `runtime.py` | Working, both sides |
| **F. Simulation and digital twin** (simulation, robot models, simulated sensors, environment, task simulation, state comparison) | `hal/kinematic.py`, `robotics/worlds/workcell.json`, `tools/build_world.py` | Built-in simulator working. Gazebo robot written, never run. State comparison: the built-in simulator reports ground truth beside the robot's own estimate, and the server refuses to confirm an arrival the ground truth contradicts |
| **G. Fleet management** (identity, enrollment, health, connectivity, task allocation, telemetry, firmware and configuration) | `server/robotics/service.js`, `server/robotics/fleet.js`, the Robots screen | Identity, enrollment, health, connectivity, telemetry, owner-side limits and choosing a robot for a task: working. Mission queues and traffic management: not started. Firmware updates: design only |

## 3. Three programs

```
┌──────────── HANNAH app (browser, desktop, phone) ────────────┐
│ Robots screen · chat · Robot Agent · robot tools             │   never talks to a robot
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTPS, the account's session or key
┌───────────────────────────▼──────────────────────────────────┐
│ HANNAH server (Node)                                         │
│  Action Engine + permission manager     server/actions       │
│  Robot registry, missions, telemetry    server/robotics      │
│  Safety Gateway (server side)                                │
└───────────────────────────▲──────────────────────────────────┘
                            │ HTTPS opened BY THE ROBOT; every request signed
┌───────────────────────────┴──────────────────────────────────┐
│ HANNAH Robotics Runtime (Python, on the robot's computer)    │
│  command guard → local safety → missions → link watchdog     │
│  hardware abstraction layer                                  │
│    ├─ kinematic adapter: built-in simulator                  │
│    └─ ROS 2 adapter ──► Nav2 ──► controller ──► motors       │
└──────────────────────────────────────────────────────────────┘
```

The existing desktop (Electron) and mobile (Capacitor) architectures are unchanged. Robot control does not pass through them: an app that is closed, asleep or offline must not be able to affect a moving robot, and it can't.

## 4. Architecture decisions

**1. An onboard runtime, separate from the app and the server.**
Why: the robot must hold its limits and stop itself with the internet, the server, the model provider and the app all unavailable. Alternative rejected: driving the robot from the server or from a browser tab (the existing `HardwareAdapter.ts` does that for small devices; it has no safety story for a machine that moves).

**2. The robot opens the connection.**
Why: works behind NAT and firewalls, leaves no listening port on the robot, and works with the serverless deployment. Cost: commands arrive at the next exchange (one second by default), so HANNAH is not suitable for anything that needs a reaction faster than that. It is not meant to be: reactions belong to the robot's controller.

**3. Robot capabilities are Action Engine actions.**
Why: one permission system, one approval flow, one history, and every existing caller (chat, voice, Team, workflows, MCP hosts) can use a robot with no new code. Cost: the engine's "done" had to be defined for something that takes minutes — see decision 4.

**4. "Done" for a movement means the robot accepted the mission.**
The engine's action is "start this mission". Arrival is the mission's own record, verified from the robot's reported state. Every text the model and the person see says "started, not finished" until then.

**5. Stopping is always allowed.**
A new, narrow rule in the permission evaluator: an action defined as `deescalates` is allowed at every permission level and while the account's emergency stop is on. Stopping, pausing and cancelling use it (`stop_motion`, `pause_mission`, `cancel_mission`); nothing that starts or resumes motion can. Without this, the emergency stop would have blocked stopping a robot.

**6. Limits flow one way.**
The robot reports its limits from a file on the robot. A person can tighten them on the server. Nothing on the server can loosen what the robot enforces, and a command can lower a speed but never raise it.

**7. A physical robot's movement always asks.**
Whatever the permission level and whatever standing permission exists. Block 1 has not run on hardware; this rule stays until it has, with evidence.

**8. Simulation is declared twice and must agree.**
The person says "simulated" or "physical" when creating the record; the runtime says which it is when enrolling. A mismatch refuses the enrollment. The label then follows the robot everywhere it appears.

**9. ROS 2 Jazzy with Gazebo Harmonic.**
The pairing Gazebo's own table recommends; every framework in the directive has a release for it. What was checked against the official tables, and what could not be, is recorded in `robotics/ros2_ws/VERSIONS.yaml`.

**10. A built-in simulator, labelled as not Gazebo.**
ROS 2 and Gazebo could not be installed on the development machine. Rather than leave the pipeline untested, the first adapter is a small kinematic simulator that needs only Python. It computes real motion, sensing, planning and failures; it is not a physics engine and is never called Gazebo. The Gazebo robot is written beside it and awaits its first run.

**11. HMAC, not public-key signatures, for robots.**
Why: the runtime should need nothing beyond the Python standard library, which has HMAC-SHA256 and no elliptic curves. The cost is that the server holds each robot's secret (sealed in the vault). See the security document for the trade-off and the upgrade path.

## 5. What Block 1 did not include

As Block 1 ended. Section 6 lists what was added afterwards.

- Any run on physical hardware.
- Any run of Gazebo, Nav2 or the ROS 2 adapter.
- Arms, grippers, cameras, following a target (in the contract; no runtime).
- micro-ROS, ros2_control configuration, MoveIt 2, Isaac ROS (design notes only, in the ROS 2 document).
- Fleet task allocation, firmware updates, multi-user roles on one robot.
- Any safety certification. HANNAH is not safety-certified and Block 1 makes no step towards certification.

## 6. Added after Block 1

Commissioning for physical robots, destinations bound to a map, pause and resume, more sensors with fault injection, perception from the range sensor, a second world and scenarios, fleet assignment, diagnostics and a maintenance log, signed robot packages, three more agents, and an arm with a gripper in a second built-in simulator (move, grasp, release). All verified with the built-in simulators or on the server; none with ROS 2, Gazebo, MoveIt 2 or hardware. The rest of section 5 still holds: no physical robot, no Gazebo run, no cameras, no following a target, no firmware updates, no certification.
