# ROS 2 and Gazebo integration — design

**Status: written, never run.** ROS 2 and Gazebo are not installed on the machine Block 1 was built on, and installing them there was not permitted in that session. Every file named in this document was checked only for syntax (XML, JSON, Python, shell). None has been executed. The first run will find mistakes; section 7 says how to do it.

## 1. Versions

| Component | Version | Why |
|---|---|---|
| ROS 2 | Jazzy Jalisco (long-term, supported to May 2029) | Every framework below has a release for it |
| Operating system | Ubuntu 24.04 | Jazzy's primary platform |
| Gazebo | Harmonic (long-term) | The pairing Gazebo's own table recommends for Jazzy |
| Navigation | Nav2, Jazzy release | |
| Hardware abstraction | ros2_control, Jazzy release | Not configured in Block 1: the Gazebo robot uses Gazebo's DiffDrive system |
| Microcontrollers | micro-ROS, Jazzy | Not used in Block 1 |
| Manipulation | MoveIt 2, Jazzy | Not used in Block 1 |
| GPU perception | NVIDIA Isaac ROS | Optional. Its current release (5.1) targets ROS 2 Lyrical, so using it means either an older Isaac ROS or moving to Lyrical with Gazebo Jetty |

Checked on 2026-11-21 against gazebosim.org's ROS pairing table, Nav2's build table and NVIDIA's Isaac ROS page. docs.ros.org, micro.ros.org's distribution page and MoveIt's page could not be read that day; micro-ROS and MoveIt 2 on Jazzy are stated from earlier knowledge and should be confirmed.

**Next long-term pair:** ROS 2 Lyrical (May 2026) with Gazebo Jetty. HANNAH's adapter uses only standard message and action types, so the move is a packaging change. Decide it in Block 2, mainly on whether Isaac ROS is wanted.

## 2. What HANNAH adds to a ROS 2 robot

Two processes and a profile file. Nothing in the robot's existing ROS graph is replaced.

```
                HANNAH server  ◄── HTTPS, signed, opened by the robot ──┐
                                                                        │
┌───────────────────────── the robot's computer ───────────────────────┴─────┐
│  hannah_robot (runtime) ── hal/ros2.py ── node "hannah_robot_bridge"        │
│      │ action client   navigate_to_pose          (nav2_msgs/NavigateToPose) │
│      │ publishes       /speed_limit              (nav2_msgs/SpeedLimit)     │
│      │ publishes       /hannah/heartbeat         (std_msgs/Empty)           │
│      │ publishes       /initialpose              (once, if the profile asks)│
│      │ publishes       /cmd_vel                  ZERO only, for a hold      │
│      │ subscribes      /odom  /scan  tf  [/battery_state]  [/estop]         │
│                                                                             │
│  hannah_watchdog (separate process) ── subscribes /hannah/heartbeat         │
│      on silence: cancels all navigate_to_pose goals, publishes zero /cmd_vel│
│                                                                             │
│  Nav2: planner, controller, costmaps, velocity smoother, collision monitor  │
│  ros2_control or the vendor's base driver  (speed limits, cmd_vel_timeout)  │
└─────────────────────────────────────────────────────────────────────────────┘
```

| ROS 2 concept (directive, module D) | How HANNAH uses it | State |
|---|---|---|
| Node integration | One node in the runtime, one in the watchdog | Written |
| Topic subscriptions and publishing | The table above | Written |
| Service clients | The watchdog calls the action's `cancel_goal` service | Written |
| Action clients | `NavigateToPose`: send, feedback, result, cancel | Written |
| Robot state monitoring | Odometry age, scan age, tf availability → faults, "localized", sensor health | Written |
| Lifecycle management | Only a check that Nav2's action server is ready. HANNAH does not activate or deactivate lifecycle nodes | Minimal, written |
| Connection health | `state.ros.navigatorReady`; a stale odometry fault; the heartbeat | Written |

**What the adapter never does:** publish a non-zero velocity, set a controller or planner parameter, enable motors, or clear an emergency stop.

## 3. The Gazebo robot

Package `robotics/ros2_ws/src/hannah_sim`.

| File | What it is |
|---|---|
| `models/hannah_bot/model.sdf` | A differential-drive base (radius 0.18 m, wheels 0.30 m apart) with a 360° lidar. Gazebo's `DiffDrive` system enforces 0.5 m/s, 1.6 rad/s and the acceleration limits itself |
| `worlds/workcell.sdf` | The room. **Generated** from `robotics/worlds/workcell.json` |
| `maps/workcell.pgm`, `.yaml` | Nav2's map. **Generated** from the same file |
| `urdf/hannah_bot.urdf` | Fixed frames for `robot_state_publisher` |
| `config/bridge.yaml` | `ros_gz_bridge`: `/clock`, `/cmd_vel`, `/odom`, `/tf`, `/scan`, `/joint_states` |
| `config/hannah_profile.json` | The runtime's profile for this robot: ROS 2 adapter, simulation "gazebo-harmonic", the same limits as the built-in simulator |
| `launch/sim.launch.py` | Gazebo server (headless by default), the robot, the bridge, `robot_state_publisher`, Nav2 with the map, the watchdog |

`robotics/tools/build_world.py` writes the world and the map from the one world file, so HANNAH's built-in simulator, Gazebo and Nav2 describe the same room. A test fails if the generated files are out of date.

Nav2 uses `nav2_bringup`'s default parameters. The robot's frames and topics are named to match them (`base_footprint`, `base_link`, `odom`, `/scan`). The default robot radius there is 0.22 m, larger than this robot's 0.18 m, which only makes Nav2 more cautious. A parameter file of HANNAH's own is a Block 2 item, after the defaults have been seen working.

## 4. Digital twin and state comparison

One world file drives three things, so a mission can be tried in the built-in simulator, then in Gazebo, then on a robot in a real room surveyed into the same format.

| Comparison | Built-in simulator | Gazebo | Physical |
|---|---|---|---|
| Robot's estimate vs. truth | Reported every state (`sim.truth`, `sim.odometryError`); the server refuses to confirm an arrival the truth contradicts | Possible from Gazebo's model pose; not wired | No truth exists; the estimate is all there is |
| Commanded goal vs. final position | Checked by the server for every mission | Same code | Same code |

Comparing a live robot against its simulated twin running the same mission is not built.

## 5. Beyond Block 1

- **ros2_control.** On hardware, HANNAH relies on the robot's controller for speed and acceleration limits and a command timeout (`diff_drive_controller`: `linear.x.max_velocity`, `cmd_vel_timeout`). The profile's limits must not exceed the controller's. Checking that automatically at start-up is a Block 2 item.
- **micro-ROS.** Microcontroller boards (motor drivers, bumpers, battery monitors) appear as ordinary ROS 2 topics through the micro-ROS agent. HANNAH needs no special support: it reads the topics. The emergency-stop state should come from such a board on a dedicated topic, read-only.
- **MoveIt 2.** `move_robot_arm`, `grasp_object` and `release_object` are in the capability contract with no runtime. The design is the same as navigation: the adapter sends a `MoveGroup` goal and reads the result; MoveIt plans against its collision scene; HANNAH never sends joint commands.
- **Isaac ROS.** Optional, for GPU perception on Jetson-class hardware. It would feed Nav2 and MoveIt, not HANNAH directly. See the version note in section 1.

## 6. Known risks in the unrun files

Where the first run is most likely to fail:

1. Gazebo topic names. The model uses absolute names (`/cmd_vel`, `/odom`, `/tf`, `/scan`); if Gazebo scopes any of them under the model, `bridge.yaml` needs the scoped name.
2. The lidar needs a rendering engine. Headless, that means software rendering (`LIBGL_ALWAYS_SOFTWARE=1`, `--headless-rendering`); it can be slow or fail in a container.
3. `gz_frame_id` on the lidar: accepted by Harmonic with a deprecation warning; a later Gazebo wants a different tag.
4. AMCL needs an initial pose. The adapter publishes `/initialpose` at start when the profile asks; if Nav2 isn't up yet, it is missed. A retry is needed.
5. Nav2's `NavigateToPose` succeeding within its own goal tolerance (0.25 m by default) and HANNAH's check (0.25 m plus 3 cm) can disagree at the edge; one of them should be made tighter than the other on purpose.
6. `nav2_msgs/SpeedLimit` is honoured by the controller server only when its speed-limit topic is configured.
7. The watchdog's cancel-all request (an empty goal id) follows the action protocol; it has not been seen working.
8. The colcon install path the check script sources.

## 7. Running it for the first time

Any one of these; none has been done.

```bash
# A. In a container, anywhere Docker runs. Builds the image and runs the acceptance check.
docker build -f robotics/Dockerfile.gazebo -t hannah-gazebo .
docker run --rm hannah-gazebo

# B. On GitHub: Actions → "Robotics — Gazebo acceptance check" → Run workflow.  (Manual only; it does the same as A.)

# C. On Ubuntu 24.04 with ROS 2 Jazzy installed
sudo apt install ros-jazzy-ros-gz ros-jazzy-navigation2 ros-jazzy-nav2-bringup ros-jazzy-robot-state-publisher
cd robotics/ros2_ws && colcon build && source install/setup.bash
export PYTHONPATH="$PWD/../runtime" HANNAH_WORLD_JSON="$PWD/../worlds/workcell.json"
ros2 launch hannah_sim sim.launch.py gui:=true
# in another terminal, with the same environment and a robot record created as "simulated" in HANNAH:
python3 -m hannah_robot enroll --server https://<your HANNAH> --code <CODE> --profile "$(ros2 pkg prefix hannah_sim)/share/hannah_sim/config/hannah_profile.json"
python3 -m hannah_robot run --profile "$(ros2 pkg prefix hannah_sim)/share/hannah_sim/config/hannah_profile.json"
```

The acceptance check is the existing simulation suite, `server/robotics.sim.test.js`, with `HANNAH_ROBOT_PROFILE` pointing at the Gazebo profile: enroll, drive to a place and verify the arrival, a goal the robot refuses, cancel, stop, a cut network link, revocation. It passes today with the built-in simulator. Passing it with Gazebo is the definition of "the Gazebo integration works".

On macOS, RoboStack (conda packages of ROS 2, through pixi) publishes `ros-jazzy-ros-gz-sim` and `ros-jazzy-nav2-bringup` for Apple silicon. That route was not tried.
