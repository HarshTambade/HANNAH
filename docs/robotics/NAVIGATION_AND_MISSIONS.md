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
