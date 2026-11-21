# A first physical robot: what it needs

**There is no robot hardware in this project.** Nothing below has been bought, wired or tested. This page says what a first differential-drive robot must provide for HANNAH's existing software to be tried on it, so that whoever chooses the parts knows what to check. Part names are deliberately left out: which lidar, board or motor driver has a working driver for the chosen ROS 2 release has to be confirmed from the maker's own documentation at the time, not from this page.

## Where HANNAH ends

HANNAH's runtime talks to ROS 2 and stops there. Everything below that line has to work **without HANNAH** before HANNAH is connected: the robot must drive with Nav2 alone, and its emergency stop must work with the computer unplugged.

```
HANNAH runtime (Python)  ──►  ROS 2: Nav2, tf, topics  ──►  ros2_control or the vendor's driver  ──►  motor controller  ──►  motors
        not safety                                                                          ▲
                                                                emergency stop: cuts drive power in hardware, independent of all of it
```

## Bill of materials, by function

| Function | What is required | What to verify before buying | Why |
|---|---|---|---|
| Chassis | Two driven wheels and a caster or two; payload and speed suited to the space | Top speed and stopping distance at that speed | HANNAH's speed limit is only as good as the brakes |
| Motors with encoders | Wheel encoders on both driven wheels | Encoder resolution; that the controller reports them | Odometry, and the commissioning step that compares a trip with a measurement |
| Motor controller | Closed-loop speed control; **its own command timeout** that stops the wheels when commands stop; its own current and speed limits | The timeout exists and is configurable; a ROS 2 driver or `ros2_control` hardware interface for the chosen ROS release | Layer 10 of the safety design. HANNAH's link watchdog is not a substitute |
| Emergency stop | A latching button that removes drive power through hardware, with no software in the path; its state readable by the computer | The stop category it implements; that its state can be read without the read being part of the stop | Layer 11. HANNAH only reads it |
| Onboard computer | A 64-bit Linux computer that the chosen ROS 2 release supports, with Python 3.9 or newer | The ROS release's supported platforms; enough CPU for Nav2 at the robot's speed | Runs ROS 2, Nav2 and HANNAH's runtime |
| 2-D lidar | 360 degrees or close to it; range suited to the space | A maintained ROS 2 driver publishing `sensor_msgs/msg/LaserScan`; laser class | Nav2's costmaps and localization; HANNAH refuses to move a robot whose range sensor isn't reporting |
| IMU | Gyroscope at least | A ROS 2 driver publishing `sensor_msgs/msg/Imu` | Better heading than wheels alone (robot_localization) |
| Battery and power | A battery management system; a fused main supply; the state of charge readable | A way to publish `sensor_msgs/msg/BatteryState` | HANNAH refuses a new mission below the minimum charge |
| Network | Wi-Fi or Ethernet with outbound HTTPS | Nothing has to reach the robot from outside | The robot opens every connection |
| Camera (optional) | Any camera with a ROS 2 driver | Decide who may be in its view and how long pictures are kept **first** | HANNAH's camera rules exist; a physical camera has not been connected |
| A safety-rated scanner (if people share the space) | Chosen and placed by a safety engineer | — | Not HANNAH's to specify |

## Software the robot needs before HANNAH

| Piece | State in this repository |
|---|---|
| A URDF of the robot, `robot_state_publisher`, correct frames | Not written for any real robot |
| `ros2_control` configuration with `diff_drive_controller`, speed and acceleration limits, `cmd_vel_timeout` | Not written |
| A map and a tuned Nav2 configuration (footprint, speeds, costmaps) | Not written; the Gazebo launch uses Nav2's defaults |
| The emergency stop's state on a read-only topic | The profile has a field for the topic; nothing has fed it |
| HANNAH's ROS 2 adapter and watchdog | Written, never run |
| A profile file for the robot | A simulated example exists |

## The order to do it in

1. Run the Gazebo acceptance check, so the ROS 2 adapter has run at all (BLOCK2_PREREQUISITES.md).
2. Build the robot; make it drive by hand with its controller; test the emergency stop with the computer off.
3. Make it navigate with Nav2 alone.
4. Have a qualified person assess the risks of that robot in that space (SAFETY_GATEWAY.md, section 7).
5. Only then: write its profile, enroll it as physical, and commission it (ONBOARDING_AND_COMMISSIONING.md), with a person at the robot.
