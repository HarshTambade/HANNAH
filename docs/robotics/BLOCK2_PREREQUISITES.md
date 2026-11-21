# Prerequisites for Block 2

Block 1 built the foundation and proved it end to end with a simulator that needs only Python. Block 2 can't responsibly start on hardware until the items in section 1 are done, because everything about ROS 2, Gazebo and real robots is still unproven.

## 1. Must be done first

| # | Prerequisite | Why | How to know it is done |
|---|---|---|---|
| 1 | **A Linux environment with ROS 2 Jazzy, Gazebo Harmonic and Nav2** — a machine, a container host, or the manual GitHub job | Nothing in `robotics/ros2_ws` or `hal/ros2.py` has ever run | `docker run --rm hannah-gazebo` (or the "Robotics — Gazebo acceptance check" workflow) exits 0 |
| 2 | **The Gazebo acceptance check passing** | It is the same suite that passes with the built-in simulator; passing it defines "the ROS 2 adapter works" | `server/robotics.sim.test.js` green with `HANNAH_ROBOT_PROFILE` set to the Gazebo profile. Expect to fix the items in ROS2_GAZEBO_INTEGRATION.md section 6 |
| 3 | **The watchdog seen working** | It is the only thing that stops a ROS robot if HANNAH's runtime crashes | Kill the runtime during a Gazebo mission; the robot stops within the timeout |
| 4 | **A decision on the ROS 2 distribution** | Jazzy with Harmonic now; Lyrical with Jetty is the next long-term pair and the one the current Isaac ROS targets | Written down, with micro-ROS and MoveIt 2 support for the choice confirmed from their own pages |
| 5 | **The server deployed with migration 18 and a vault key** | Robots can't enroll without the vault; the tables don't exist until the migration runs | `GET /api/robots` answers `canEnroll: true` on the server the robot will use |
| 6 | **The first physical robot chosen**, with: its ROS 2 driver, a working Nav2 configuration, a hardware emergency stop, a controller that enforces speed limits and a command timeout | HANNAH adds nothing below the ROS 2 boundary; all of that must already work without HANNAH | The robot navigates with Nav2 alone, and its emergency stop is demonstrated with the computer unplugged |
| 7 | **A risk assessment for that robot in its space**, by someone qualified | See SAFETY_GATEWAY.md section 7. HANNAH is not a safety function and must be shown not to be relied on as one | A document, and a named person who signed it |

## 2. Should be done early in Block 2

| Item | Notes |
|---|---|
| An independent security review of the robot protocol | It has had none. Open items are listed in SECURITY_ARCHITECTURE.md section 11 |
| Rate limiting on the signed sync endpoint | Enrollment is limited; sync is not |
| A Nav2 parameter file for the robot instead of the defaults | And a start-up check that the profile's limits don't exceed the controller's |
| Emergency-stop state from the real robot, on a dedicated read-only topic | The profile has the field; nothing has fed it yet |
| A retry for the initial pose, and a deliberate margin between Nav2's goal tolerance and HANNAH's check | Both are known weak points |
| Scoped standing permissions for a physical robot | Today a physical robot's movement always asks. Relaxing that needs evidence from supervised runs, and probably a geofence and time window in the grant |
| The request counter surviving a database restore | SECURITY_ARCHITECTURE.md section 11 |

## 3. What Block 2 could then build

In the order the foundation supports them:

1. The first physical mobile robot, supervised, through the existing ROS 2 adapter and a profile file.
2. Maps and places managed from the app (today they come from the robot's profile).
3. Camera capture (`capture_image`), with privacy zones and retention decided first.
4. Arms through MoveIt 2 (`move_robot_arm`, `grasp_object`, `release_object`): runtime executors, adapter methods, verification from joint and gripper feedback.
5. Fleet: several robots, choosing one for a task, queueing missions.
6. Signed firmware and configuration updates, on the design in SECURITY_ARCHITECTURE.md section 9.
7. Several people with different roles on one robot.

## 4. What the owner has to provide

- A Linux machine or a container host for item 1, or approval to run the manual GitHub job (it uses GitHub-hosted runner minutes).
- The decision in item 4.
- For hardware: the robot, a clear space, a person present for every run, and the risk assessment.
