# Fleet

State: **choosing a robot is verified on the server and in a browser with two simulated robots.** Queues and traffic management are not built.

## Overview

`GET /api/robots/fleet`, action `robots.fleet`, tool `robot_fleet`, and the Fleet table on the Robots screen (shown with two or more robots): each robot's kind, connection, mode, battery, position, current mission, whether it can take a task now, and the reasons when it can't. An offline robot shows no battery or position: its last report is not the present.

## Choosing a robot

Action `robots.assign`, tool `robot_assign`: "send a robot to the shelves", "assign the available robot to inspect Zone B".

A robot is **eligible** only if all of this holds: enrolled and connected; offers the capability and it isn't switched off; commissioned (or in its trial) if physical; emergency stop released; no fault; motors enabled; localized; range and odometry sensors reporting; battery above its minimum (not needed to return to dock); not on a mission, running or paused; and, when the goal is a name, **that robot has that destination on its own map**.

Among the eligible: the nearest to the goal (straight line, from its reported position), then the fuller battery, then the name.

The answer lists every robot considered: the one chosen and why, and for each other its distance or its reason ("busy: Drive to a place", "battery 9%, below its 15% minimum", "has no destination called “Zone B”").

**The choice is part of what you approve.** The approval card names the robot. If that robot can no longer take the task when the approval comes, the task is refused; it is never quietly given to another.

## Not sending two robots to one spot

A goal within 0.8 m of where another robot **on the same map** is already heading is refused as a conflict. The same coordinates on different maps are different places.

That is the whole of the coordination. **Not built:** route reservation, right-of-way in corridors and doorways, queues and priorities, re-assignment when a robot fails, charging schedules. Two robots can be sent through the same corridor at the same time, and each will treat the other as an obstacle its range sensor sees. Do not rely on HANNAH to keep robots apart.

## Condition and maintenance

`robots.diagnostics` (tool `robot_diagnostics`), `GET /api/robots/:id/diagnostics`, and "Condition" on the screen: findings from what the robot reported and what was recorded — a sensor not reporting, an active fault, battery, link losses in the last day, refused commands, missions that didn't finish, drift of the position estimate (simulator), commissioning, software versions, the last maintenance entry. Each finding states its evidence. A recommendation is a fixed rule attached to a finding. No model is asked to judge a robot's condition, and nothing predicts a failure.

A maintenance log per robot (inspection, repair, replacement, calibration, note) is written by a signed-in person.
