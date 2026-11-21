# HANNAH Robotics — implementation tracker

Generated from `ROBOTICS_PROGRESS.json` by `robotics/tools/progress.py`. Edit the JSON, not this page.

Updated 2026-11-21. **Nothing here has run in Gazebo, with ROS 2, or on a physical robot.** "sim" means HANNAH's own built-in simulators. HANNAH is not safety-certified.

| Status | Count | Meaning |
|---|---|---|
| NOT_STARTED | 10 | Nothing exists |
| IN_PROGRESS | 0 | Being built; not usable yet |
| IMPLEMENTED | 4 | Code exists; it has not been run or has no test that proves it |
| TESTING | 0 | Tests exist and are not all passing |
| VERIFIED | 56 | Implemented and its tests pass, at the level named |
| BLOCKED_EXTERNAL_DEPENDENCY | 17 | Can't go further without something only the owner can provide |

## Stage 1 — Foundation

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 1.1 | Audit of the existing codebase | IMPLEMENTED | — | — | A document, so nothing to test. |
| 1.2a | Robot device registry | VERIFIED | server | `robotics.test.js`, `robotics.pglite.test.js` |  |
| 1.2b | Robot capability registry | VERIFIED | unit, server | `robotics.contract.test.js`, `robotics.test.js` |  |
| 1.2c | Hardware adapter registry and interface | VERIFIED | unit, sim | `test_adapters.py` | Three adapters chosen by the robot's profile: mobile-robot simulator, arm simulator, ROS 2 (see 2.2a). |
| 1.2d | Robotics Safety Gateway, server and robot side | VERIFIED | server, sim | `robotics.test.js`, `test_safety.py` |  |
| 1.2e | Task manager and state manager | VERIFIED | server, sim | `robotics.test.js`, `robotics.stage2.test.js`, `test_runtime.py` |  |
| 1.2f | Sensor registry | VERIFIED | sim | `robotics.sim.test.js`, `test_stage2.py` | Each sensor: id, type, description, frame, rate, resolution, message type, calibration, health. |
| 1.2g | Telemetry, events and audit records | VERIFIED | server, sim | `robotics.test.js`, `robotics.sim.test.js` |  |
| 1.3 | Robot device model | VERIFIED | server | `robotics.test.js` | Ownership is one account. HANNAH has no workspaces or organizations, so there is no workspace ownership. |
| 1.4 | Capability interface: schemas, preconditions, risk, timeout, cancel, verification | VERIFIED | unit | `robotics.contract.test.js` |  |
| 1.5 | Mission model with persisted states | VERIFIED | server | `robotics.test.js`, `robotics.stage2.test.js`, `robotics.stage2.pglite.test.js` | Plans, checkpoints and queues: see 5.2b and 7.5b. |
| 1.6 | Security foundation: device identity, signed requests and commands, revocation, audit | VERIFIED | server, unit | `robotics.test.js`, `test_protocol.py` |  |
| 1.7 | Migrations 18 to 21 on SQLite and Postgres | VERIFIED | server | `robotics.pglite.test.js`, `robotics.stage2.pglite.test.js`, `robotics.plans.pglite.test.js`, `robotics.camera.pglite.test.js` |  |

## Stage 2 — ROS 2, Gazebo and navigation

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 2.1 | Environment inspected; ROS 2 Jazzy with Gazebo Harmonic chosen | IMPLEMENTED | — | — | macOS arm64, no Docker, ROS 2, Gazebo or CMake. An install attempt was refused by the session's permission rules. |
| 2.2a | ROS 2 bridge: topics, tf, Nav2 action, feedback, cancel, timeouts | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Written, never run. Syntax-checked only. Blocked by B1. |
| 2.2b | ROS 2 bridge: lifecycle management, parameters, reconnection, diagnostics | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Not written. Writing more ROS code that can't be run would only add unverified code. Blocked by B1. |
| 2.3a | Differential-drive robot in HANNAH's built-in simulator | VERIFIED | sim | `test_kinematic.py`, `robotics.sim.test.js` | Kinematic, not a physics engine, and never called Gazebo. |
| 2.3b | Gazebo robot model: base, wheels, differential drive, lidar | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Written, never run. No ros2_control, camera or IMU on it yet. Blocked by B1. |
| 2.4 | Worlds with rooms, obstacles, a dock and named places with explicit coordinates | VERIFIED | sim, server | `test_stage2.py`, `robotics.stage2.test.js` | A name is usable only when it is on the robot's destination list; never inferred. |
| 2.5a | Navigation in the built-in simulator: planning, obstacles, re-planning, cancel, arrival check | VERIFIED | sim | `test_kinematic.py`, `test_stage2.py`, `robotics.sim.test.js` |  |
| 2.5b | Nav2: localization, planners, costmaps, recovery | BLOCKED_EXTERNAL_DEPENDENCY | — | — | The launch file uses Nav2's defaults; never run. Blocked by B1. |
| 2.6 | Sentence to verified arrival through the Robot Agent | VERIFIED | sim, browser | `robotics.sim.test.js`, `Robotics.test.ts`, `robotics.spec.ts` | With the built-in simulator. No live model has driven the agent (blocker B6). |
| 2.7 | Robots screen: identity, pose, map, route, mission, telemetry, sensors, errors | VERIFIED | browser | `robotics.spec.ts` |  |
| 2.8 | Stage 2 acceptance in Gazebo | BLOCKED_EXTERNAL_DEPENDENCY | — | — | The acceptance check is the existing sim suite with HANNAH_ROBOT_PROFILE set to the Gazebo profile. Blocked by B1. |

## Stage 3 — Sensors and perception

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 3.1a | Sensors in the simulator: 2D lidar, odometry, IMU, battery, temperature, humidity, with fault injection | VERIFIED | sim | `test_stage2.py`, `robotics.sim.test.js` |  |
| 3.1b | Camera and depth sensor | VERIFIED | sim, server | `test_vision.py`, `robotics.sim.test.js`, `robotics.camera.test.js` | The built-in simulator's camera only: 64x48 with depth, rendered by ray casting. No physical or Gazebo camera. |
| 3.1c | Stereo, 3D lidar, GPS, force and torque, ultrasonic, pressure sensors | NOT_STARTED | — | — | No simulator or hardware for them. |
| 3.2 | Sensor registration: frame, rate, resolution, message type, calibration, health | VERIFIED | sim, server | `test_vision.py`, `robotics.camera.test.js` | Frame, rate, resolution, message type and calibration are kept when the robot gives them. Health comes from each state report. |
| 3.3 | Camera pipeline: ingestion, timestamps, frame-rate, preprocessing | VERIFIED | sim | `test_vision.py` | A frame carries its sensor, frame number, capture time and pose. One picture at a time on request: there is no stream, so no frame-rate monitoring, and no distortion correction (the simulated camera is an ideal pinhole). |
| 3.4 | Computer vision: detection with source, time, model, frame and confidence | VERIFIED | sim, server | `test_vision.py`, `robotics.sim.test.js` | A colour-region detector, not a learned model: it cannot say what an object is. No ONNX Runtime, YOLO, tracking, segmentation or classification; none could be run and tested here. |
| 3.5a | Obstacles and distances from the range sensor | VERIFIED | sim | `test_stage2.py`, `robotics.sim.test.js` |  |
| 3.5b | Depth, point clouds, 3D localization | VERIFIED | sim | `test_vision.py`, `robotics.sim.test.js` | Distance and position of a detection from the simulated camera's depth, labelled with its source. No point clouds. |
| 3.5c | Validated observations into Nav2 costmaps | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Blocked by B1. |
| 3.6a | Heading fused from wheels and gyroscope | VERIFIED | sim | `test_stage2.py` | A complementary filter, not a general fusion framework. |
| 3.6b | robot_localization: IMU, odometry, GPS, visual odometry | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Blocked by B1. |
| 3.7 | Environmental perception: obstacles, distances, changes from the map, confidence, source | VERIFIED | sim | `test_stage2.py`, `robotics.sim.test.js` | From range-sensor geometry. HANNAH can't say what an object is. |
| 3.8 | Perception questions answered from evidence, stale data marked | VERIFIED | server, unit | `robotics.stage2.test.js`, `Robotics.test.ts` | Part of the Robot agent, not a separate agent. |
| 3.9a | Range-sensor view and sensor diagnostics on the Robots screen | VERIFIED | browser | `robotics.spec.ts` |  |
| 3.9b | Camera preview, camera permission, recording consent, retention, access log | VERIFIED | server, sim, browser | `robotics.camera.test.js`, `robotics.camera.pglite.test.js`, `robotics.sim.test.js`, `robotics.spec.ts` | Off until a person switches it on; kept for a limited time; every opening logged; forged or stale images refused. No live preview and no recording. |

## Stage 4 — Physical hardware and commissioning

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 4.2 | Hardware audit and a bill of materials for a first reference robot | NOT_STARTED | — | — | There is no robot hardware here. |
| 4.3 | Edge computer and embedded controller integration | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Blocked by B2. |
| 4.4 | Physical adapters: USB, UART, SPI, I2C, CAN, micro-ROS | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Nothing written. An adapter for hardware nobody has would be untestable. Blocked by B2. |
| 4.5 | Motors, encoders, odometry on hardware | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Blocked by B2. |
| 4.6 | Physical sensors | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Blocked by B2. |
| 4.7 | Commissioning: a physical robot can't move until a person completes the checks | VERIFIED | server | `robotics.stage2.test.js` | Seven steps, tested with a stand-in robot. No robot has been commissioned. |
| 4.8a | Software safety behaviour: limits, watchdog, command expiry, link loss, fault handling, never resuming | VERIFIED | sim | `test_runtime.py`, `test_safety.py`, `robotics.sim.test.js` |  |
| 4.8b | Physical emergency stop and independent motor enable | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Hardware, not HANNAH's. HANNAH's Stop is not an emergency stop. Blocked by B2. |
| 4.9 | Stage 4 physical acceptance | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Blocked by B2. |

## Stage 5 — Missions, voice and agents

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 5.1 | Robot agent: intent, robot selection, capability and destination resolution, checks, execution, verification | VERIFIED | unit, browser | `Robotics.test.ts`, `robotics.spec.ts` | Tested with a scripted server. No live model run (B6). |
| 5.2a | Mission lifecycle: create, check, approve, execute, pause, resume, cancel, verify, history | VERIFIED | server, sim | `robotics.test.js`, `robotics.stage2.test.js`, `robotics.sim.test.js` |  |
| 5.2b | Multi-step plans with checkpoints and sequential steps | VERIFIED | server, sim, browser | `robotics.plans.test.js`, `robotics.plans.pglite.test.js`, `robotics.sim.test.js`, `robotics.arm.sim.test.js`, `robotics.spec.ts` | Simulated robots only: a physical robot is refused a plan that moves it. No conditions, branches or retries. |
| 5.3 | Voice requests for robots | IMPLEMENTED | — | — | Robot tools are offered on the existing voice path. Never tested with speech. |
| 5.4 | Specialist agents: Robot, Fleet, Manipulation, Robot care | VERIFIED | unit | `Robotics.test.ts` | Navigation, Perception and Verification are not separate agents: the server verifies, and the Safety Gateway (code, not a model) decides. |
| 5.5 | Mission templates, offered only when the robot has the hardware | VERIFIED | server, sim | `robotics.plans.test.js`, `robotics.arm.sim.test.js`, `robotics.sim.test.js` | Four templates: go and return, inspection route, pick and place, status report. |
| 5.6 | Robotics memory: destinations, configuration, mission and maintenance history | VERIFIED | server | `robotics.stage2.test.js` | Stored in the registry and always read from current records. Nothing is kept in the model's own memory. |
| 5.7 | Reliability: heartbeats, deadlines, expiry, durable state, lost missions | VERIFIED | server, sim | `robotics.test.js`, `test_runtime.py`, `robotics.sim.test.js` |  |

## Stage 6 — Arms and manipulation

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 6.2 | Arm registry: joints, limits, tool, gripper | VERIFIED | sim | `test_arm.py`, `robotics.arm.sim.test.js` |  |
| 6.3 | MoveIt 2 integration | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Nothing written. Blocked by B3. |
| 6.4a | Move the arm, grasp, release; cancel | VERIFIED | sim | `test_arm.py`, `robotics.arm.sim.test.js` |  |
| 6.4b | Named poses, safe pose, arm state as its own read | NOT_STARTED | — | — |  |
| 6.5 | Planning with collision checks, approval, gripper feedback, outcome verification | VERIFIED | sim | `test_arm.py`, `robotics.arm.sim.test.js` | Objects come from the simulator's scene, not from the camera: detections are not yet used to choose what to grasp. |
| 6.6 | Simulated arm: pick and place | VERIFIED | sim, browser | `robotics.arm.sim.test.js`, `robotics.spec.ts` | HANNAH's built-in planar arm simulator. Not MoveIt 2, not Gazebo. |
| 6.7 | Physical manipulator | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Blocked by B3. |

## Stage 7 — Fleet

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 7.2 | Fleet registry with per-account isolation | VERIFIED | server | `robotics.test.js`, `robotics.fleet.test.js` |  |
| 7.3 | Fleet monitoring from reported state | VERIFIED | server, browser | `robotics.fleet.test.js`, `robotics.spec.ts` |  |
| 7.4 | Task allocation with reasons; incompatible assignments refused | VERIFIED | server | `robotics.fleet.test.js` | By capability, readiness, destination on the map, distance, battery. No task duration estimate. |
| 7.5a | Conflict detection: two robots aren't sent to the same spot | VERIFIED | server | `robotics.fleet.test.js` |  |
| 7.5b | Mission queues | VERIFIED | server | `robotics.plans.test.js` | A queue of plans per robot with priorities. No queue shared between robots. |
| 7.5c | Traffic coordination between robots in motion | NOT_STARTED | — | — | A destination reservation exists; routes are not coordinated. |
| 7.6 | Fleet agent | VERIFIED | unit | `Robotics.test.ts` |  |
| 7.7 | Resilience: offline robots never commanded; no automatic reassignment | VERIFIED | server | `robotics.test.js`, `robotics.fleet.test.js` | Reassignment is deliberately manual: a new assignment is a new, checked, approved request. |
| 7.8 | Fleet analytics from real records | VERIFIED | unit, server, browser | `robotics.fleet.test.js`, `robotics.plans.test.js`, `robotics.spec.ts` | A figure with no records behind it is empty, not zero. |
| 7.9a | Fleet API: registration, status, capabilities, missions, cancel, allocation, telemetry, diagnostics, events | VERIFIED | server | `robotics.test.js`, `robotics.stage2.test.js`, `robotics.fleet.test.js` |  |
| 7.9b | Webhooks | NOT_STARTED | — | — |  |

## Part D — Product integration

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| D1 | One robotics interface in the existing app, simulation and physical labelled | VERIFIED | browser | `robotics.spec.ts` | No hardware-in-the-loop label yet: nothing produces such data. |
| D2a | HTTP API for robots | VERIFIED | server | `robotics.test.js`, `robotics.stage2.test.js`, `robotics.plans.test.js` |  |
| D2b | Typed SDK for the robot API | NOT_STARTED | — | — |  |
| D3a | Signed robot packages: manifest, signature, integrity, permission review | VERIFIED | unit | `robotics.packages.test.js` |  |
| D3b | Installing a package on a robot; marketplace listing; revocation list | NOT_STARTED | — | — | Installing code on a robot needs sandboxing that can't be tested without one. |
| D4 | Industrial and IoT adapters: Home Assistant, MQTT, Modbus, OPC UA, PLCs, CAN | NOT_STARTED | — | — | Needs the owner to say which systems exist. Blocked by B4. |

## Part E — Security and safety

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| E1 | Device identity, mutual authentication, replay protection, command expiry, rate limits, revocation, key replacement | VERIFIED | server, unit | `robotics.test.js`, `test_protocol.py` |  |
| E2 | Signed firmware and configuration updates | NOT_STARTED | — | — | Design only, in SECURITY_ARCHITECTURE.md. |
| E3 | DDS security (SROS2) on the robot's network | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Blocked by B1. |
| E4 | Independent security review; any safety assessment | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Blocked by B5. |

## Part F — Validation and production

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| F1 | Tests kept apart by level: unit, integration, simulation; nothing labelled hardware | IMPLEMENTED | — | — |  |
| F2 | Measured performance: command latency, mission duration, success | VERIFIED | unit, server | `robotics.fleet.test.js`, `robotics.plans.test.js` | Command latency, stop latency, mission duration and verified success, measured from stored records. No ROS, sensor-processing or perception latency: nothing produces them. |
| F3 | Onboard deployment: install, service, health check, logs | NOT_STARTED | — | — |  |

## External blockers

| Id | What is missing | What it needs | What it holds up |
|---|---|---|---|
| B1 | No ROS 2, Gazebo, Nav2 or Docker on the development machine | A Linux machine or container host, or a run of the manual GitHub job "Robotics — Gazebo acceptance check" | Everything in stage 2 that says Gazebo, Nav2 or ROS; milestone 1 |
| B2 | No physical robot | A mobile robot with Nav2 working, a hardware emergency stop, and a qualified person's risk assessment | Stage 4; milestone 2 |
| B3 | No MoveIt 2 environment and no arm | A Linux environment with MoveIt 2, and a chosen arm | MoveIt 2 integration; milestone 3 |
| B4 | Unknown which industrial or IoT systems exist | The owner naming the systems, with test access | Any connector in part D4 |
| B5 | No independent reviewer | A security review by someone who didn't write the protocol; a safety engineer for any real robot | Any claim beyond "tested by its author" |
| B6 | No live model run | A session allowed to use a model provider key | Proof that a real model drives the robot agents correctly |

## Next unblocked tasks

1. Named arm poses, a safe pose and an arm-state read (6.4b)
2. Commissioning extended to the directive's 17 checks; a reference robot's bill of materials (4.7, 4.2)
3. Onboard deployment: a doctor command, a service unit, an install guide (F3)
4. A typed SDK for the robot API (D2b)
5. An evaluation of industrial and IoT adapters (D4)
6. Webhooks, or robot events as workflow triggers (7.9b)

## Last full verification

- date: 2026-11-21
- server: 525 tests: 524 passed, 1 skipped (older), 0 failed; lint clean
- runtime: 97 passed on Python 3.14.6 and 3.9.6; 5 of 5 scenarios; generated world files current
- client: 409 passed; typecheck clean; lint 0 errors
- browser: robotics spec 11 of 11 on the built app; the whole browser suite was last run before plans and the camera were added (110 of 110)

## To resume

```sh
git status -sb && git log --oneline -5
python3 robotics/tools/progress.py --check
cd server && npm test
cd robotics/runtime && python3 -m unittest discover -s tests -t .
cd client && npx tsc --noEmit -p . && npm test
```
