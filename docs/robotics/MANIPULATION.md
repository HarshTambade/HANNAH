# Robotic arms and manipulation

**State: not started.** No arm has been simulated, connected or moved. This page records the design so the work can begin from the same rules as navigation.

What exists: three contract entries (`move_robot_arm`, `grasp_object`, `release_object`), all `contract-only`, risk **high**. A robot cannot register them and HANNAH cannot ask for them.

## Design

- **Planning stack:** MoveIt 2 on ROS 2. HANNAH sends a goal (a named pose, or a pose in an approved workspace) to MoveIt's action; MoveIt plans against its collision scene and the robot's joint limits; the robot's `ros2_control` trajectory controller executes. HANNAH never sends joint positions, velocities or torques.
- **Adapter:** new methods on the adapter interface (`move_arm`, `arm_status`, `set_gripper`), implemented for ROS 2 with MoveIt's `MoveGroup` action and the gripper's action. A test will keep joint-level commands out of the interface, as it does for wheels.
- **Capabilities before any motion:** named poses and waypoints approved by a person, the way destinations are for navigation. "Pick object" needs object localization and grasp validation first; a camera seeing an object is not permission to grasp it.
- **Safety Gateway additions:** workspace volume, payload, maximum joint speed, gripper force, a collision scene that must be present, human-presence state from a safety-rated device where the cell needs it.
- **Risk:** high. Always a person's approval, always a commissioned robot, no standing permission.
- **Verification:** measured joint positions against the goal; gripper position and force for grasp and release.
- **Simulation first:** a pick-and-place in Gazebo with MoveIt 2 before any hardware. Physical arms are commissioned separately; ISO 10218 applies.

## What it needs that isn't here

A Linux environment with ROS 2 and MoveIt 2; an arm description (URDF) and MoveIt configuration; runtime executors and verification for the three capabilities; tests at every level; a manipulation panel in the app.
