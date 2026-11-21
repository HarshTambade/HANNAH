# HANNAH Robotics — where each stage stands

Updated 2026-11-21. One rule for reading this page: **"verified" always says where.** Nothing has run in Gazebo, with ROS 2, or on a physical robot. HANNAH is not safety-certified.

| State | Meaning |
|---|---|
| **Verified (sim)** | Implemented and tested end to end with HANNAH's built-in kinematic simulator, the real server and the real runtime |
| **Verified (server)** | Implemented and tested on the real server with a scripted stand-in robot or as a unit |
| **Written, not run** | Code exists and was checked for syntax only; no environment to run it |
| **Design only** | Described in a document; no code |
| **Not started** | Nothing exists |

## The three milestones

| Milestone | State |
|---|---|
| 1. A sentence → a registered simulated robot → validated destination → permission → goal → **ROS 2 and Nav2 execute it in Gazebo** → real feedback → cancel → independent verification | Steps 1–6, 8, 9, 10: **verified (sim)** with the built-in simulator. Step 7, Gazebo and Nav2: **written, not run**. The milestone as written is **not met** until the Gazebo acceptance check passes |
| 2. The same on a physical robot, after commissioning | **Not started.** The commissioning procedure exists and is verified (server); no robot has been commissioned |
| 3. A second class of hardware (an arm), with a dedicated manipulation integration | **Partly.** A pick and place is verified with HANNAH's built-in arm simulator, through the same registry, gateway, approval and verification. The dedicated integration the milestone means, MoveIt 2 with a real or Gazebo arm, is **not started** |

## Stage by stage

| Stage | What | State |
|---|---|---|
| **1. Audit and foundation** | Audit, registry, device model, capability registry, mission and state models, adapter interface, Safety Gateway, telemetry, audit history, migrations 18 and 19 | **Verified (server)** and **(sim)** |
| **2. ROS 2, Gazebo, navigation** | Built-in differential-drive simulation: planning, obstacle avoidance, re-planning, recovery when a blocked route clears, cancel, pose verification; a home world with rooms and doorways; five scenarios | **Verified (sim)** |
| | Destination management: names bound to a map and frame, validated, approved | **Verified (server)** |
| | ROS 2 adapter (topics, tf, Nav2 action, feedback, cancel), watchdog node, Gazebo robot model with lidar, world, bridge, launch, container | **Written, not run** |
| | ros2_control configuration, IMU and camera on the Gazebo robot, SLAM workflow, lifecycle management, parameters, reconnection, RViz | **Not started** |
| **3. Sensors and perception** | Sensor readings with time and source; health; fault injection; movement refused without range or odometry sensor | **Verified (sim)** |
| | Perception from the range sensor: obstacles grouped with distance, bearing, size, confidence and sensor; blocked route; changes from the map, cleared when gone | **Verified (sim)** |
| | Heading fused from wheels and gyroscope | **Verified (sim)** — a simple complementary filter, not a general fusion framework |
| | Cameras, depth, object classification, person detection, visual inspection, GPS, 3-D lidar, visual odometry, calibration metadata | **Not started** |
| **4. Physical hardware** | Commissioning: seven steps with server-checked evidence, trial mode, withdrawal on hardware change | **Verified (server)** with a stand-in. No hardware |
| | Adapter contract for a ROS 2 robot | **Written, not run** |
| | micro-ROS, embedded controllers, CAN, serial buses, motor controllers, battery systems, hardware-in-the-loop tests | **Not started** |
| **5. Agents, voice, missions** | Four robot agents (Robot, Fleet, Manipulation, Robot care) with 21 tools; requests routed to robot tools | **Verified** by client tests with a scripted server. No live model run |
| | Mission lifecycle: create, check, approve, execute, feedback, pause, resume, cancel, verify, history; durable records | **Verified (sim)** |
| | Multi-step mission planning, checkpoints, automatic failure recovery, robot memories (maps, preferences) | **Not started**. Multi-step plans come only from the existing Team orchestrator |
| | Voice | Uses the existing voice path into the same tools. **Not tested** for robot requests |
| | Navigation, Perception, Maintenance and Verification as separate agents | Folded into the agents below and the server's own verification. There are four robot agents: Robot, Fleet, Manipulation, Robot care |
| **6. Arms and manipulation** | A three-joint planar arm in a built-in simulator: kinematics, joint limits, collision-checked motion, a gripper with feedback; move, grasp and release as approved, verified steps; a pick and place | **Verified (sim)** — the built-in arm simulator, not MoveIt 2 |
| | MoveIt 2, a planning scene from sensors, trajectory controllers, real grippers, object localization, grasp validation, Gazebo manipulation | **Not started** |
| **7. Fleet** | Overview, choosing a robot with reasons, one-spot reservation, approval of the chosen robot | **Verified (server)**; browser test with two simulated robots |
| | Mission queues, priorities, traffic management, shared-resource scheduling | **Not started** |
| **8. Industrial and IoT** | Home Assistant, MQTT, Modbus, OPC UA, PLCs, CAN | **Not started.** Any future connector must be an Action Engine action; PLC writes will not be model tools |
| **9. Digital twin** | One world file for the simulator, the Gazebo world and the Nav2 map; scenario files; reset per run; regression runner; ground truth against the robot's estimate | **Verified (sim)**; the Gazebo side written, not run |
| | Recorded real runs replayed in simulation; configuration versioning beyond a counter | **Not started** |
| **10. Mobile, desktop, edge** | The Robots screen in the one app that runs on web, desktop and phones (checked at phone width); the runtime as a separate program | **Verified** in a browser. Not tested on a phone or in the desktop app. No push notifications for robot approvals |
| **11. SDK and marketplace** | Signed package manifest, verification (signature, integrity, permissions, contract rules), command-line tool, an example package, adapter and capability guides | **Verified** (unit) |
| | Installing a package on a robot, sandboxing, marketplace listing, revocation lists, rollback | **Not started** |
| **12. Security, validation, production** | Signed requests and commands, replay protection, flood limits, roles, audit | **Verified (server)** |
| | Independent security review, SROS2/DDS security, hardware validation, load testing, production deployment with a robot | **Not started** |

## Stage 1, item by item

Each item of the stage 1 list, where it lives, and what proves it. Checked against the source on 2026-11-21.

| Item | Where | Proof |
|---|---|---|
| Robotics module | `server/robotics/` (registry and missions, contract, Safety Gateway, commissioning, fleet, packages, routes) | `server/robotics*.test.js` |
| Robot device registry | `service.js`; table `hannah_robots` | `robotics.test.js`: create, enroll, revoke, remove, one account can't see another's robot |
| Robot capability registry | `contract.js`: 19 capabilities, each with schemas, preconditions, risk, timeout, cancel behaviour, verification and failure responses | `robotics.contract.test.js` |
| Robot device profiles | `robotics/profiles/*.json`, read by `runtime/hannah_robot/profile.py`; stored as `hannah_robots.profile` | `test_adapters.py`, `robotics.sim.test.js` |
| Robotics task model | Missions: table `hannah_robot_missions`, statuses in NAVIGATION_AND_MISSIONS.md | `robotics.test.js`, `robotics.stage2.test.js` |
| Robot state model | The adapter's `state()` report; `hannah_robots.state` and `mode`; connection derived, never stored | `test_runtime.py`, `robotics.test.js` |
| Hardware adapter interface | `runtime/hannah_robot/hal/base.py`: 16 methods, none taking a velocity, PWM, torque or joint value | `test_adapters.py` fails if the method list changes |
| ROS 2 adapter interface | `hal/ros2.py`, `hal/ros2_watchdog.py` | **Written, not run.** Checked for syntax only |
| Robotics Safety Gateway interface | `server/robotics/safety.js` `check()`; runtime `safety.py` `LocalSafety.check()` | `robotics.test.js`, `test_safety.py` |
| Telemetry data model | Table `hannah_robot_telemetry`: one sample every three seconds, two hours kept | `robotics.sim.test.js`, from a real runtime's reports |
| Robotics audit events | Table `hannah_robot_events`; every robot action is also an Action Engine record with who asked and who approved | `robotics.test.js` |
| Database migrations | 18 and 19 in `server/db/migrations.js`, additive | The robotics integration suites run on SQLite and on embedded Postgres (`*.pglite.test.js`) |
| API contracts | `server/robotics/router.js`: 2 device routes, 26 account routes; `GET /api/robots/contract` returns the capability contract; listed in DEVELOPER_SDK.md | `robotics.test.js`, `e2e/robotics.spec.ts` |
| Dashboard integration | The Robots screen, `/robotics`, in the existing shell | `Robotics.test.ts`, `e2e/robotics.spec.ts`, and the screens, interactions and accessibility specs |

Stage 1 asks for no physical hardware control, no arm execution and no fleet deployment. None exists: the arm and fleet work listed under stages 6 and 7 runs only against the built-in simulators, and a physical robot is refused movement until a person has commissioned it.

## Known limitations

1. Everything runs against one simulator written for this project. It is kinematic: no physics, friction, wheel slip, sensor noise models, or timing of a real machine.
2. The planner in the simulator is not Nav2. Behaviour in Gazebo will differ.
3. Position is odometry (drifting) corrected only in the dock. There is no map-based localization in the simulator.
4. Perception is range-sensor geometry. HANNAH cannot say what an object is. The arm simulator's objects come from its own scene, not from a camera.
4a. The arm simulator is planar, with no dynamics, payload or grasp physics, and a small fixed set of planning strategies.
5. One robot per runtime; one account per robot; missions of minutes, not hours.
6. Commands reach a robot at its next exchange (about a second). HANNAH is not for anything needing a faster reaction; that belongs to the robot's controller.
7. A physical robot's every movement needs approval. There is no scoped autonomy for hardware.
8. The Stop button is a software request. It is not, and cannot be made into, an emergency stop.
9. No live language model has driven the robot agents; their tools and instructions are tested with a scripted server.

## What only the owner can unblock

| Need | Unblocks |
|---|---|
| A Linux machine or container host, or a run of the manual "Robotics — Gazebo acceptance check" job | Milestone 1, all of stage 2's ROS side |
| A decision between ROS 2 Jazzy and Lyrical | The ROS files' versions |
| A physical robot with Nav2 working, a hardware emergency stop, and a qualified person's risk assessment | Milestone 2 |
| A Linux environment with MoveIt 2, and which arm | The rest of milestone 3 |
