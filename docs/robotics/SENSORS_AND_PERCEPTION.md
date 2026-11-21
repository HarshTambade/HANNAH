# Sensors and perception

State: **verified with the built-in simulator** for a 2-D range sensor, wheel odometry, an IMU (gyroscope), a bumper, a battery and a temperature and humidity sensor. Cameras and everything that needs one: not started.

## The rule

A sensor reading is a measurement and is reported as one: with the sensor it came from, when it was measured, and whether it is simulated. **HANNAH never presents a model's guess as a measurement**, and the perception described here involves no model at all.

## Readings

Every reading in a robot's state carries `ok`, `source` and `measuredAt`. A sensor that stops reporting is `{ ok: false, problem: "not reporting" }` with no value: never a stale number, never zero.

| Sensor | Reading | Notes |
|---|---|---|
| lidar | 72 ranges, nearest return and its bearing | Ray-cast in the simulator |
| odometry | distance travelled; the pose's source | Drifts; reset in the dock |
| imu | yaw rate | Fused with the wheels for heading; the pose says "wheels fused with the IMU" or "wheels only (IMU not reporting)" |
| environment | temperature, humidity | The world's ambient values |
| bumper | pressed | A collision latches a fault only a local action clears |
| battery | percent, charging | |

Action `robots.read_sensor`, tool `robot_read_sensor`; `robots.battery`, `robot_battery`.

## Perception from the range sensor

`robots.surroundings` (tool `robot_surroundings`, capability `report_surroundings`):

- **Obstacles:** returns that lie together are grouped into one object, with distance, bearing (0° ahead), approximate width, number of returns, the sensor, and a confidence that grows with the number of returns and never reaches 1. Each is classed against the robot's own map as "mapped obstacle" or "object not on the map". HANNAH does not say what the object is.
- **Route:** blocked, not blocked, or **unknown** when the range sensor isn't reporting.
- **Changes:** places where the sensor found something the map doesn't have; removed when the sensor later sees past them.
- **Sensor health:** which sensors are not reporting.

The Robots screen shows the same under "What it senses" and draws unmapped objects on the map.

## What a missing sensor does

| Not reporting | Effect |
|---|---|
| Range sensor or odometry | Movement is refused by the server and by the robot; a running trip fails and the robot stops |
| IMU | Heading comes from the wheels alone and drifts faster; it says so |
| Battery | The battery reads as "not reported", not as a number |

Fault injection for tests and demonstrations: `{"sensorFaults": ["lidar"]}` in the simulator's input file.

## Not built

RGB and depth cameras, object detection and classification, person detection, visual inspection, visual odometry, GPS, 3-D lidar, force and torque sensors, calibration metadata, a general sensor-fusion framework (the heading filter is a fixed blend), map-based localization, and any connection from perception to a vision model. When cameras are added, an image interpreted by a model will be labelled as an interpretation with the model's name, separate from measurements.
