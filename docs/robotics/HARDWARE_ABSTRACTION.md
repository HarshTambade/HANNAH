# Hardware abstraction layer

The runtime never talks to motors, sensors or ROS directly. It talks to one interface, `RobotAdapter` (`robotics/runtime/hannah_robot/hal/base.py`). An adapter presents one robot as three things: a description, a current state, and a few high-level operations that the robot's own planner and controller carry out.

## The interface

| Method | Purpose |
|---|---|
| `describe()` | Static facts, sent at enrollment: robot type, sensors, actuators, switchable devices, the capabilities it offers, named places, dock, a map outline, its limits, and `simulation` (`{kind, note}`, or nothing for hardware) |
| `state()` | Now: pose and its source, velocity, battery, emergency-stop state, motors enabled, localized, faults, sensor readings, device states, the planner's goal and path |
| `start()`, `close()` | Connect and disconnect |
| `step(dt)` | Called every tick. A simulator advances here; hardware needs nothing |
| `navigate(goal, max_speed, tolerance)` | Hand a goal to the navigation stack with a speed ceiling |
| `navigation_status()` | `idle`, `active`, `succeeded`, `failed` or `cancelled`, with a reason and the distance remaining |
| `cancel_navigation()` | Cancel the goal. Safe to repeat |
| `hold()` | Stand still now: cancel goals and command zero motion. Safe to repeat |
| `heartbeat()` | Called every tick while the runtime is healthy, for an adapter-side watchdog |
| `move_arm(target)`, `arm_status()` | Hand the arm's planner a tool position; never joint values |
| `grasp(object)`, `release()` | Close the gripper on a named object at the tool; open it |
| `set_device(id, on)` | Switch a listed on/off device |
| `acknowledge_fault()` | A local operator action. No HANNAH command can reach it |

**What is deliberately missing:** `set_velocity`, `set_pwm`, `set_torque`, joint commands. A test (`tests/test_adapters.py`) fails if a method with such a name is ever added. The runtime hands a goal to a navigation stack; it does not close a control loop.

## Layers

```
runtime.py            missions, watchdog, reports
   │  RobotAdapter
   ├── hal/kinematic.py       built-in simulator: navigator + base controller + world
   └── hal/ros2.py            ROS 2: Nav2 action client, tf, topics
            │
            ├── Nav2                    planner, controller, costmaps, collision monitor
            ├── ros2_control            hardware interfaces and controllers (diff_drive_controller: speed limits, cmd_vel_timeout)
            ├── micro-ROS               microcontroller boards publishing as ROS 2 nodes
            └── vendor driver           for robots that ship their own ROS 2 driver
```

HANNAH's layer ends at the ROS 2 boundary. Below it, the established frameworks do what they already do: `ros2_control` abstracts actuators and enforces controller limits; micro-ROS brings microcontrollers into the ROS 2 graph; a vendor's driver exposes its robot. HANNAH does not replace or wrap any of them. A robot that runs Nav2 needs only a profile file to be usable through the ROS 2 adapter.

## Adding a robot

| Robot | What it takes |
|---|---|
| A ROS 2 mobile robot with Nav2 | A profile file: identity, limits, topic names, places, dock. No code |
| A ROS 2 robot with a different navigation action | A subclass of `Ros2Adapter` overriding `navigate` and `navigation_status` |
| A robot with a vendor SDK and no ROS | A new adapter implementing the interface against that SDK |
| A robot arm | New capabilities need runtime executors first (Block 2); then an adapter method per operation, backed by MoveIt 2 |

## The profile file

A JSON file on the robot. It decides the adapter, and its limits are the ones the runtime enforces.

```json
{
  "adapter": "kinematic",
  "identity": { "manufacturer": "…", "model": "…", "robotType": "differential-drive", "softwareVersion": "…", "firmwareVersion": "…" },
  "world": "../worlds/workcell.json",
  "robot": { "radius": 0.18 },
  "limits": { "maxLinearSpeed": 0.5, "maxAngularSpeed": 1.6, "maxLinearAccel": 0.8, "minBatteryPercent": 15, "linkTimeoutS": 5, "commandTtlS": 20, "environment": "simulation" }
}
```

For the ROS 2 adapter a `ros` section names topics, frames, the navigation action, and whether this is a simulation (`robotics/ros2_ws/src/hannah_sim/config/hannah_profile.json`). A profile that says "simulation" while not running on simulated time, or the reverse, refuses to start.

## Discovery

Block 1 has no network discovery. A robot becomes known when a person creates its record and its runtime enrolls with the one-time code; the adapter's `describe()` is the hardware inventory. Scanning a network for robots and adding them automatically is not planned: a robot should join an account because someone decided it should.

## The two adapters

| | Kinematic (`hal/kinematic.py`) | ROS 2 (`hal/ros2.py`) |
|---|---|---|
| State | **Tested** | **Written, never run** |
| Needs | Python 3.9+ | A sourced ROS 2 Jazzy environment, `rclpy`, `nav2_msgs`, `tf2_ros` |
| Pose | Wheel odometry with simulated drift; corrected in the dock | tf `map → base`; falls back to odometry and reports "not localized" |
| Planner | A* on an inflated grid, re-planning around obstacles the range sensor finds | Nav2 `NavigateToPose` |
| Speed limit for one mission | The navigator's ceiling | `nav2_msgs/SpeedLimit` |
| Controller limits | Modelled: speed, acceleration, 0.5 s command timeout | The robot's own controller (Gazebo `DiffDrive`, or `ros2_control`) |
| Emergency stop | A simulated input, pressed through a local file | Read from a topic if the profile names one; otherwise "not monitored" |
| If the runtime dies | The simulator dies with it | `ros2_watchdog.py`, a separate process, cancels Nav2 goals and zeroes velocity when the heartbeat stops |

## A third adapter

`hal/arm.py` (`arm-kinematic`): HANNAH's built-in planar arm simulator, tested. See MANIPULATION.md. The method list a test enforces now includes `move_arm`, `arm_status`, `grasp` and `release`, and still nothing that takes a joint value.
