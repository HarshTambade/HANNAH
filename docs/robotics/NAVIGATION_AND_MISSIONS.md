# Navigation, destinations and missions

State: **verified with the built-in simulator.** With Gazebo and Nav2: written, not run.

## Destinations

A name is not a coordinate until someone has said so for a particular map.

| | Simulated robot | Physical robot |
|---|---|---|
| Places its runtime reported | Usable by name | Listed, not usable until you approve each |
| Destinations you define | Usable | Usable |

Each destination stores its **map** (the name the robot reports for its map), its **coordinate frame**, x, y and optional heading, and where it came from. Adding one checks it against the robot's workspace, keep-out zones and mapped obstacles. If the robot later reports a different map, destinations made for the old one are set aside and not used. `GET /api/robots/:id/destinations`, action `robots.destinations`, tool `robot_destinations`.

Asking for a name the robot doesn't have is refused and lists the names it does have. Coordinates can always be given directly; they get the same checks.

## A mission's life

```
asked → Safety Gateway → [approval] → Safety Gateway again → queued → sent → accepted ⇄ paused
                                                                              ↓
                                   succeeded | unverified | failed | cancelled | timed-out | lost
        refused before sending: denied (recorded with its reason)      rejected (by the robot)      expired (never accepted)
```

| Control | Approval | What it does |
|---|---|---|
| Stop (`robots.stop_motion`) | Never | Cancels everything on the robot and holds; confirmed by measured speed |
| Cancel (`robots.cancel_mission`) | Never | Ends the mission; the robot stops where it is |
| Pause (`robots.pause_mission`) | Never | The robot holds and keeps the mission; paused time doesn't count against its time limit; a lost link doesn't cancel a paused mission |
| Resume (`robots.resume_mission`) | Like starting a mission | Checked again against the robot as it is now; the command expires in 20 seconds and works once; the robot can refuse it |

Missions are rows in the database (`hannah_robot_missions`), so they survive a server restart. On the robot, a mission does not survive a restart of the runtime: the robot stops, and the mission ends as lost.

Not built: mission queues, multi-step missions with checkpoints, automatic retry or recovery behaviours beyond re-planning.

## Plans: several steps under one approval

A plan is a list of steps on one robot that a person reads and approves once. `robots.run_plan` (tool `robot_run_plan`), `POST /api/robots/:id/plans`, and "Plans" on the Robots screen. Verified with the built-in simulators (an inspection route, a pick and place); not with ROS 2 or hardware.

| A step is | Examples | What happens when it is reached |
|---|---|---|
| A capability that starts a mission | `navigate_to`, `return_to_dock`, `inspect_area`, `set_supported_device_state`, `move_robot_arm`, `grasp_object`, `release_object` | The Safety Gateway checks it against the robot as it is then; a signed command is sent; the mission is verified as any other |
| An observation | `report_surroundings`, `read_sensor`, `report_battery_state`, `report_robot_state` | Nothing is sent. What the robot reported in that same exchange is recorded, with its time and whether it is a simulation |

Nothing else can be a step. There are no conditions, loops or expressions: a plan is not a program.

**Rules**

- Every step is checked when the plan is asked for, and a plan with a step that can't be valid is refused with the step named. A refusal that an earlier step exists to change (the gripper is empty before the grasp step has run) is left for the moment the step is reached.
- Every step is checked again when it is sent. A test shows a plan stopping at step 2 because the emergency stop engaged after step 1.
- The plan stops at the first step that doesn't finish and verify. The steps after it are marked "not run". Nothing is retried.
- One step at a time. The next step is sent in the same exchange in which the robot reports the one before as finished, so the robot is never idle between two steps of a plan, and it is refused any other movement while the plan runs.
- **A physical robot is refused any plan that moves it.** Each of its movements is approved by itself. A plan of observations only, which sends it nothing, is allowed. This stays until there is evidence from supervised hardware runs.
- A plan containing an arm or gripper step always asks, at every permission level.
- Stopping the robot ends its plan and drops every plan waiting behind it. Cancelling a plan (`robots.cancel_plan`) never needs approval.

**The queue.** A robot runs one plan at a time. A plan asked for while the robot is busy waits, by priority (1–5) and then by age; at most five wait per robot. A waiting plan that hasn't started within its time (15 minutes by default, 120 at most) is dropped, not started late. When a plan fails, the plans waiting behind it are dropped too: whatever stopped it hasn't been looked at.

**Statuses:** queued → running → succeeded | failed | cancelled; expired (never started). A plan whose robot stops reporting ends as failed with "outcome unknown", never as done.

**Templates** expand into explicit steps before anything is checked, so the approval card shows steps, not a template name. `GET /api/robots/:id/templates` says which a robot can run and why not otherwise.

| Template | Steps | Needs |
|---|---|---|
| `go_and_return` | Drive to a destination; return to the dock | A mobile robot with a dock |
| `inspection_route` | At each destination: drive there, record what the range sensor detects, optionally read a sensor; then return to the dock | A mobile robot that reports surroundings |
| `pick_and_place` | Move the arm to where **the robot reports** the object, grasp, move to a named pose, release, go home | An arm with a gripper |
| `status_report` | Record state and battery. Sends nothing | Any robot |

**Not built:** conditions and branches, retries, a plan across several robots, plans for physical robots, editing a running plan.

## What the simulator's navigator does

- Plans with A* on a grid inflated by the robot's radius; follows the path; slows near the goal; turns to a requested heading.
- Stops for anything its range sensor sees in its path. Adds what it sees that isn't on the map, re-plans around it, and removes it again when the sensor sees past where it was.
- Fails honestly: "No path to the goal" or "Blocked", never touching the obstacle.
- Will not drive with its range sensor not reporting.

## Worlds and scenarios

| File | What |
|---|---|
| `robotics/worlds/workcell.json` | One room with shelving and a workbench |
| `robotics/worlds/home.json` | Kitchen, living room, bedroom and study around a corridor, each through a one-metre doorway; a charging station |
| `robotics/scenarios/*.json` | valid-navigation, blocked-route, blocked-then-cleared (recovery), unexpected-object, sensor-loss |

```bash
cd robotics/runtime && python3 -m hannah_robot.scenarios      # 5 of 5 pass; each starts from a fresh simulator
python3 -m hannah_robot run --profile ../profiles/sim-home.json   # use the home world
```

A scenario is steps (drive, place an obstacle, take a sensor away) and expectations (the result, the reason, no faults). Every scenario also asserts that the robot never came closer to anything than its own radius. They are regression tests for the built-in navigator only.
