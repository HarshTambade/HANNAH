# Robotic arms and manipulation

**State: a pick and place is verified end to end with HANNAH's built-in arm simulator.** That simulator is not MoveIt 2 and not Gazebo, and no physical arm has been connected. MoveIt 2 integration is design only.

## What works (built-in simulator)

| Capability | Action, tool | What it does | Verified by |
|---|---|---|---|
| `move_robot_arm` | `robots.move_robot_arm`, `robot_arm_move` | Moves the tool to a named pose or a point in the arm's workspace | The tool position computed from the measured joint angles is within 2 cm of the target and the joints are still |
| `grasp_object` | `robots.grasp_object`, `robot_grasp` | Closes the gripper on a named object at the tool | The gripper reports it is holding that object. A gripper that closed on nothing is a failure |
| `release_object` | `robots.release_object`, `robot_release` | Opens the gripper | The gripper reports open and holding nothing |

Stop, cancel, state and sensor reads work as for any robot. All three arm capabilities are **high risk: they ask every time**, at every permission level, with or without a standing permission, in simulation too.

Try it:

```bash
cd robotics/runtime
python3 -m hannah_robot enroll --server http://127.0.0.1:3001 --code XXXXX-XXXXX --profile ../profiles/sim-arm.json
python3 -m hannah_robot run --profile ../profiles/sim-arm.json
```

Then on the Robots screen: move the tool over the red block, grasp it, move to the bin, release. Or ask: "Pick up the red block with the arm and put it in the bin."

## The rule that carries over from navigation

HANNAH sends a **target for the tool**. It never sends joint angles, speeds or torques; the adapter interface has no method that takes one, and a test keeps it that way. The arm's own planner decides the joints.

## What is checked, and where

| Check | Server gateway | The arm's runtime | The planner (simulator) |
|---|---|---|---|
| Target inside the workspace, outside keep-out zones | Yes | Yes | Yes |
| Target not on a fixture | No (it doesn't have the arm's map) | Yes | Yes |
| Joint limits; a collision-free motion exists | — | — | Yes: the whole motion is checked before it starts; a motion that would touch something is never begun |
| Joint speed limit | — | — | Yes, by how every motion is timed |
| Object exists | Only objects the robot itself reports | — | The gripper's feedback |
| Gripper empty before a grasp; holding before a release | Yes | Yes | Yes |
| One motion at a time | Yes | Yes | — |
| Emergency stop, fault, connection | Yes | Yes | Freezes the joints at once |

## The simulator

`robotics/runtime/hannah_robot/hal/arm.py`, world `robotics/worlds/bench.json`: a three-joint planar arm seen from above on a table, a fixture it must not touch, two blocks, a bin, a keep-out strip on the operator's side.

- Forward and inverse kinematics; several wrist directions and both elbow solutions.
- Planning: a straight joint motion if it is clear; otherwise by way of the home position; otherwise fold in, swing the shoulder, reach out. If none is clear: "No motion to that position is free of collisions."
- A held object moves with the tool. The scene is the simulator's own, and says so: it is not a camera.

Limits of the simulator: two dimensions, no gravity, no dynamics, no payload, no grasp physics (an object within 3.5 cm of the tool point counts as between the fingers), a small fixed set of planning strategies.

## Not built

- **MoveIt 2**, a planning scene from real sensors, a `ros2_control` trajectory controller, a real gripper driver.
- Object localization from a camera, grasp planning, grasp validation by force.
- Pick and place as one capability (it is four approved steps today), approved waypoints defined by a person for a physical arm, a manipulation panel beyond the arm view.
- Pause and resume for an arm motion are handled by the runtime but not tested with an arm.
- Any physical arm. A physical arm needs commissioning like any physical robot, a cell designed and assessed under ISO 10218, and force and speed limits in its safety-rated controller.

## Design for a real arm

The adapter's `move_arm`, `grasp` and `release` map to MoveIt 2's `MoveGroup` action and the gripper's action on ROS 2. MoveIt plans against its collision scene and the robot's joint limits; the robot's trajectory controller executes. The gateway gains workspace volume, payload, gripper force and a human-presence input from a safety-rated device where the cell needs one. Simulation first in Gazebo with MoveIt 2; none of that can be run on the current development machine.
