# Robotics tests — what was run, and at which level

Run on 2026-11-21 on macOS 27 (arm64), Node 25.9, Python 3.14.6 and 3.9.6.

**No test in this repository ran on a physical robot, in Gazebo, or with ROS 2.** Tests are in three levels, kept apart on purpose, and a simulation test is never described as a hardware test.

| Level | What is real | What stands in |
|---|---|---|
| **Unit** | The code under test | Everything else. No server, no robot, no simulator running |
| **Integration** | The server, the database, the Action Engine, HTTP | A scripted stand-in robot that speaks the protocol and reports what the test tells it to. It simulates nothing |
| **Simulation** | The server, the runtime (the same program a robot would run), the protocol over HTTP, the browser where stated | The robot: HANNAH's built-in kinematic simulator. Not Gazebo |
| **Hardware** | — | **None exist** |

## Results

| Suite | Level | Tests | Passed |
|---|---|---|---|
| `server/robotics.contract.test.js` | Unit | 10 | 10 |
| `server/robotics.packages.test.js` | Unit | 4 | 4 |
| `server/robotics.fleet.test.js` | Unit (3) and integration (1) | 4 | 4 |
| `robotics/runtime/tests/test_protocol.py`, `test_safety.py`, `test_adapters.py` | Unit | 21 | 21 |
| `client/src/__tests__/Robotics.test.ts` | Unit (scripted server) | 9 | 9 |
| `server/robotics.test.js` | Integration | 18 | 18 |
| `server/robotics.stage2.test.js` (commissioning, destinations, pause and resume) | Integration | 7 | 7 |
| `server/robotics.pglite.test.js`, `robotics.stage2.pglite.test.js` | Integration, the same suites on embedded Postgres | 25 | 25 |
| `robotics/runtime/tests/test_kinematic.py`, `test_runtime.py`, `test_stage2.py`, `test_arm.py` | Simulation (and a few unit) | 57 | 57 |
| `server/robotics.sim.test.js` | Simulation (server + runtime process) | 12 | 12 |
| `server/robotics.arm.sim.test.js` | Simulation (server + runtime process, the arm simulator) | 4 | 4 |
| `e2e/robotics.spec.ts` | Simulation (browser + server + one or two runtime processes) | 9 | 9 |
| **Robotics total** | | **180** | **180** |

Also: 5 of 5 navigation scenarios (`python3 -m hannah_robot.scenarios`), which `test_stage2.py` runs as a test.

The Python suite passes on Python 3.9.6 (the declared minimum) and 3.14.6.

Whole project after the change: see the table at the end.

## What each requirement in the directive is tested by

| Requirement | Level | Where | What it shows |
|---|---|---|---|
| Robot registration | Integration | `robotics.test.js` "registration" | Account needed; a developer key can't enroll; the code is one-use, hashed, expiring; the kind (simulated or physical) must match; the secret is sealed and never returned; another account sees nothing |
| Device authentication | Integration, unit | `robotics.test.js` "device authentication"; `test_protocol.py` | Unsigned, wrongly signed, altered, replayed and stale requests are refused; an account session is not a robot; signatures match between Node and Python |
| Capability registration | Unit, integration | `robotics.contract.test.js`; `robotics.test.js` "capability registration" | Unknown, wrong-type and unimplemented capabilities are refused with reasons; no capability is named after an actuator |
| Capability validation | Unit | `robotics.contract.test.js` | Every capability has the whole contract; inputs are checked against schemas |
| Invalid command rejection | Unit, integration, simulation | `robotics.contract.test.js`; `robotics.test.js` "invalid commands"; `test_safety.py`; `test_runtime.py` | Refused on the server before approval, with the reason; refused again on the robot against its own limits; a forged, altered or misaddressed command is never run |
| Permission denial | Integration | `robotics.test.js` "permission", "physical robot" | Movement waits for a person; a key can't approve; declining sends nothing; read-only refuses; a physical robot always asks, even with the widest standing permission |
| Robot disconnection | Integration, simulation | `robotics.test.js` "robot disconnection"; `robotics.sim.test.js` "network goes away"; `e2e` "runtime is gone" | An offline robot is shown as offline, its state as old, and is never told to move; **the robot stops itself** when the link is cut and says why when it returns |
| Command timeout | Integration, simulation | `robotics.test.js` "command timeout"; `test_runtime.py` | A command not accepted in time expires and is never delivered or run later; a mission that runs out of time is stopped; a robot that goes silent is "lost", not "succeeded" |
| Task cancellation | Integration, simulation | `robotics.test.js` "task cancellation"; `test_runtime.py`; `robotics.sim.test.js` | Cancelled before delivery it never reaches the robot; afterwards the robot is told, stops where it is and confirms |
| Safety state handling | Unit, integration, simulation | `robotics.contract.test.js`; `robotics.test.js` "safety state"; `test_runtime.py`; `test_kinematic.py`; `robotics.sim.test.js`; `e2e` | Emergency stop, fault, low battery and disabled motors refuse movement, also when they happen while an approval waits; an emergency stop halts the simulated robot at once and nothing resumes on release |
| Simulated navigation | Simulation | `test_kinematic.py`; `robotics.sim.test.js` | Reaches every named place without touching anything; obeys speed and acceleration limits; goes around an obstacle that isn't on its map; gives up honestly when the way is closed |
| Task verification | Integration, simulation | `robotics.test.js` "task verification"; `robotics.sim.test.js` | A success the reported state doesn't support (too far, still moving, ground truth disagrees, no position) is recorded as unverified |
| Agent integration | Unit, integration | `Robotics.test.ts`; `robotics.test.js` | Robot tools and the Robot Agent exist only for an account with a robot; a request about a robot brings the tools; moving is reported as started, not arrived; an agent's key can ask and stop but not approve |
| Frontend integration | Simulation (browser) | `e2e/robotics.spec.ts`; `/robotics` in `screens`, `interactions`, `accessibility` specs | Add a robot from the screen, the real runtime enrolls, approve a trip on the card, see it verified, Stop, emergency stop, offline |

## Not tested

| Not tested | Why |
|---|---|
| The ROS 2 adapter's connection, subscriptions, navigation and hold | ROS 2 is not installed here. Only its profile, descriptor and local safety checks are tested |
| The watchdog node | Same |
| The Gazebo robot, world, bridge and launch file | Gazebo is not installed here. Checked for syntax only |
| `Dockerfile.gazebo`, `gazebo_check.sh`, the manual CI job | No container runtime here; never built or run |
| Any physical robot, sensor, motor or emergency stop | None was available, and none should be used before the prerequisites for Block 2 |
| The serverless deployment with a robot connected | Not deployed |
| A real model driving the Robot Agent | The agent's tools and instructions are tested with a scripted server; no live model run with robot tools was made |
| Many robots at once, or long runs | One robot, missions of seconds to a minute |
| Safe shutdown of the runtime on exit | Implemented; not asserted by a test |

## Findings from testing

Things the tests caught in this work, all fixed:

- "Stopped" was reported while the robot was still moving at 0.02 m/s. A stop is now confirmed only after the measured speed stays at zero.
- A used enrollment code stayed on screen after the robot enrolled.
- The first report from a starting runtime carried no state.
- The simulated battery charged faster in the dock than a trip drained it, so a trip appeared to add charge.
- An adapter that failed to take a goal would have crashed the runtime; it now fails the mission.
- The first simulation run of the network-outage test showed the robot legitimately finishing a short trip inside the five-second link timeout: the behaviour is correct, and the test now uses a trip longer than the outage.

## Whole project

| Check | Result |
|---|---|
| Server tests (`npm test` in `server`) | 502 tests: 501 passed, 1 skipped (an older skip), 0 failed |
| Browser suite (`npx playwright test`), whole, on the final build, run alone | 110 passed |
| Client tests (`npx vitest run`) | 407 passed |
| Runtime tests | 78 passed, on Python 3.14.6 and 3.9.6 |
| Client typecheck, client lint, server lint | Clean (3 older lint warnings in the workflow builder) |
| Secret scan | No findings (677 files) |
| Licence check | 424 production dependencies, all permissive; none added |
| Version check | All fields 1.7.0 (no version change in this work) |

## Added after Block 1: what tests what

| Requirement | Level | Where |
|---|---|---|
| Commissioning: order, who may confirm, evidence the server checks, trial speed cap, approval, withdrawal on changed hardware | Integration (stand-in declared physical) | `robotics.stage2.test.js` |
| Destinations: validation, physical robots by approved name only, a destination made for another map set aside | Integration | `robotics.stage2.test.js` |
| Invalid destination | Integration, browser | `robotics.stage2.test.js`, `e2e` (keep-out corner refused on the map) |
| Pause, resume (approval, expiry, single use, refusal by the robot), cancel as an action | Unit, simulation, integration, browser | `test_stage2.py`, `robotics.stage2.test.js`, `robotics.sim.test.js`, `e2e` |
| Blocked route, obstacle handling, recovery when it clears | Simulation | scenarios; `test_stage2.py` |
| Sensor registration, missing data, connection loss, health; not moved without a range sensor | Simulation, integration | `test_stage2.py`, `robotics.sim.test.js`, `robotics.stage2.test.js` |
| Detection result shape, confidence, sensor provenance | Simulation | `test_stage2.py`, `robotics.sim.test.js`, `e2e` |
| Multiple robots, capability matching, assignment, conflicts, unavailability | Unit, integration, browser | `robotics.fleet.test.js`, `e2e` (two runtime processes) |
| Diagnostics from evidence only | Unit, integration, browser | `robotics.fleet.test.js`, `e2e` |
| Package signature, integrity, permissions, contract rules | Unit | `robotics.packages.test.js` |
| Flood of requests in a robot's name | Integration | `robotics.stage2.test.js` |
| Simulation and physical shown separately | Browser | `e2e` (the kind badge, the operating mode) |
| Manipulation: kinematics inside joint limits, joint speed limit, collision-checked motion, refusals, gripper state, cancellation by stop, a simulated pick and place | Unit, simulation, browser | `test_arm.py`, `robotics.arm.sim.test.js`, `e2e` |

Still not tested, in addition to the list above: a phone or the desktop app; voice requests for robots; a live model with the robot agents; hardware-in-the-loop; any physical robot; manipulation with MoveIt 2 or a physical arm (the built-in arm simulator is tested); pause and resume of an arm motion; localization failure on a real stack; ROS 2 node, topic, service and action behaviour.

One run of the whole server suite failed two older, unrelated tests (a server that didn't start in time) while the browser suite was running at the same time on the same machine. Run alone, the suite passes; the numbers above are from runs made alone.
