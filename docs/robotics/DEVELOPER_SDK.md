# Developer guide and SDK

How to extend HANNAH Robotics, and the interfaces it exposes. Everything named here exists in the repository; what is only planned is in the last section.

## 1. Add a robot

| Robot | What to write |
|---|---|
| ROS 2 with Nav2 | A profile file (see `robotics/ros2_ws/src/hannah_sim/config/hannah_profile.json`). The adapter exists; it has not been run |
| Anything else | An adapter: a Python class implementing `RobotAdapter` (`robotics/runtime/hannah_robot/hal/base.py`) |

An adapter implements `describe()`, `state()`, `navigate()`, `navigation_status()`, `cancel_navigation()` and `hold()`, and optionally `start()`, `step()`, `close()`, `heartbeat()`, `set_device()`. `hal/kinematic.py` is the complete, tested example. Rules a test enforces: no method that sets a velocity, PWM, torque or joint value.

`describe()` must return the robot's own `limits` (`maxLinearSpeed`, `workspace`, `linkTimeoutS`, `environment`, `estop`), its `capabilities`, and `simulation` (`{kind}`, or nothing for hardware). Without a speed limit and a workspace HANNAH will not move the robot.

## 2. Add a capability

In order; a capability is not finished until its result can be verified.

1. `server/robotics/contract.js`: id, schemas, preconditions, risk, timeout, cancel behaviour, verification, `status: "contract-only"`.
2. Both gateways: `server/robotics/safety.js` and `robotics/runtime/hannah_robot/safety.py`.
3. An executor in `runtime.py`, and the adapter method it needs.
4. `verifyMission` in `server/robotics/service.js`.
5. An action in `server/actions/catalog/robots.js`; a tool in `client/src/services/Robotics.ts`.
6. Tests at unit, integration and simulation level; then `status: "implemented"`.

A capability name or input that looks like a raw actuator command (`pwm`, `torque`, `cmd_vel`, `motor`…) fails a test.

## 3. Add a world or a scenario

- A world is JSON: bounds, obstacles (rectangles), places, dock, start, keep-out zones. Put it in `robotics/worlds/` and point a profile at it. `python3 tools/build_world.py --world worlds/<name>.json` writes the Gazebo world and Nav2 map.
- A scenario is JSON in `robotics/scenarios/`: steps and expectations. `python3 -m hannah_robot.scenarios`.

## 4. Robot packages

A package is a folder with `hannah-robot-package.json`: id, name, author, exact version, kind (driver, sensor-adapter, actuator-adapter, ros2-package, capability, navigation-skill, manipulation-skill, perception-skill, mission-template, simulation-environment, hardware-profile), supported hardware, operating systems, ROS distributions, dependencies **pinned to exact versions**, capabilities (from the contract only), permissions, safety constraints, documentation, test results with their **level** (unit, simulation, hardware-in-the-loop, physical), every file with its SHA-256, and an Ed25519 signature.

```bash
node server/scripts/robot-package.js keygen my-key                     # keep my-key.private.pem off any server
node server/scripts/robot-package.js sign <folder> my-key.private.pem  # fills in file hashes, signs
node server/scripts/robot-package.js verify <folder> my-key.public.pem "who the key belongs to"
```

`verifyPackage` (`server/robotics/packages.js`) refuses: an incomplete manifest, a version range, an unknown permission, a capability outside the contract or named after an actuator, a signature from an untrusted or revoked key, a manifest changed after signing, a file changed, missing or unlisted. For a valid package it returns a review: what it may do, its risk, how it was tested, and warnings (for example "tested in simulation only", "runs code on the robot's computer").

Example: `robotics/sdk/examples/home-world`.

**Verifying installs nothing.** There is no installer, sandbox, marketplace listing, key registry in the app, revocation list or rollback yet. Do not put a third-party driver on a physical robot on the strength of this check alone.

## 5. HTTP API

All under `/api`. An account session or a developer key unless marked; **(person)** needs a signed-in person.

| Route | Purpose |
|---|---|
| `GET /robots`, `GET /robots/:id` | Registry; one robot with recent missions and events |
| `POST /robots` **(person)** | Create a record, get a one-time code |
| `PATCH /robots/:id` **(person)** | Name, tighter limits, capabilities off or always-ask |
| `POST /robots/:id/enrollment`, `/revoke`, `DELETE /robots/:id` **(person)** | New code (replaces the secret), revoke, remove |
| `GET /robots/contract` | The capability contract |
| `GET /robots/fleet` | Every robot's availability and health |
| `GET /robots/:id/commissioning`; `POST …/commissioning/:step`, `…/reset` **(person)** | Commissioning |
| `GET /robots/:id/destinations`; `POST`, `DELETE …/:destination` **(person)** | Destinations |
| `GET /robots/:id/diagnostics`, `/telemetry`, `/maintenance`; `POST …/maintenance` **(person)** | Condition, samples, log |
| `GET /robots/missions`, `/robots/missions/:id`, `GET /robots/events` | Missions and events |
| `POST /robots/missions/:id/cancel`, `/pause` | Never need approval |
| `POST /robots/missions/:id/resume` | An action; may answer 202 waiting for approval |
| `POST /robots/:id/stop` | Never needs approval |
| `GET /robots/plans`, `/robots/plans/:id`; `GET /robots/:id/templates` | Plans with every step's outcome; the templates a robot can run |
| `POST /robots/:id/plans` | Start a plan (`{ template, inputs }` or `{ steps }`). An action; may answer 202 waiting for approval |
| `POST /robots/plans/:id/cancel` | Never needs approval |
| `GET /robots/analytics?days=7` | Fleet figures from stored records |
| `POST /actions` with `robots.*` | Start anything that moves a robot: goes through permission, the Safety Gateway and approval |
| `POST /robots/enroll`, `POST /robots/device/sync` | The robot itself: a one-time code, then signed requests |

Actions: `robots.list`, `state`, `read_sensor`, `battery`, `surroundings`, `destinations`, `mission`, `fleet`, `diagnostics` (reads); `navigate_to`, `return_to_dock`, `inspect_area`, `set_supported_device_state`, `assign`, `resume_mission` (ask); `stop_motion`, `cancel_mission`, `pause_mission` (never ask). Any MCP host or workflow reaches them through the existing `hannah_action` tool and "Do an action" step.

## 6. Running the tests

See TESTS.md. In short: `python3 -m unittest discover -s tests -t .` in `robotics/runtime`; `npm test` in `server`; `npx vitest run` and `npx playwright test robotics.spec.ts` in `client`.

## 7. Not available yet

A published Python or JavaScript SDK package; a marketplace section for robot packages; installing or sandboxing packages; a plug-in mechanism for adapters outside the repository (an adapter is added to `hal/` and `profile.py`); webhooks for robot events.
