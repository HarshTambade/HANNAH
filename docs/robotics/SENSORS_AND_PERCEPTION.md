# Sensors and perception

State: **verified with the built-in simulator** for a 2-D range sensor, wheel odometry, an IMU (gyroscope), a bumper, a battery, a temperature and humidity sensor, and a simulated camera with depth that takes one picture at a time on request. No physical camera, no Gazebo camera and no learned vision model has been used.

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

A physical or Gazebo camera, a camera stream or live preview, a learned detector (ONNX Runtime, YOLO, RT-DETR, TensorRT, Isaac ROS), object classification, tracking, segmentation, person detection, visual inspection, distortion correction, visual odometry, point clouds, GPS, 3-D lidar, force and torque sensors, a general sensor-fusion framework (the heading filter is a single complementary filter), detections fed into Nav2 costmaps.

## Sensor registration

Each sensor a robot registers carries, when the robot gives them: its coordinate frame, rate, resolution, the ROS 2 message type its data corresponds to, its calibration, manufacturer and model. The server keeps those fields and drops anything else. Health is separate and comes from each state report (`ok`, `measuredAt`, `problem`).

A sensor being registered says the robot claims to have it. It is the readings, with their time, that show it works: a sensor that stops reporting is shown as not reporting and carries no value.

## Camera

`capture_image` (action `robots.capture_image`, tool `robot_capture_image`), "Camera" on the Robots screen. Verified with the built-in simulator's camera only.

**What the simulated camera is.** A forward camera, 64 by 48 pixels, 70 degrees, with depth, rendered by casting a ray per image column through the simulator's world from where the robot really is. Obstacles in a world file may have a colour; the rest are grey. It is labelled "simulated camera" in the frame, the stored picture, the approval card and the screen. It is not a physics-based renderer.

**The pipeline.**

```
camera (read once, on request) → frame with sensor, frame number, capture time, pose
  → detector → detections, each with the frame, time, detector name and version, confidence
  → distance and position only when the frame has depth, labelled with the depth's source
  → report to the server: a small result, and the image beside it
  → the server checks the image is what it says it is → stored → verified
```

**The detector** (`robotics/runtime/hannah_robot/vision.py`) finds connected regions of saturated colour and names the colour: "a red region", with its box, size, bearing and a confidence that reflects how solid and large the region is. It is colour segmentation, not a learned model. It cannot say what an object is, recognise a person or a face, or read text, and its own description, the tool description and the screen all say so. Other detectors can be registered in `PROVIDERS`; none is, because none could be run and tested here. An unknown provider name is an error, never a silent fallback.

**Privacy rules, enforced by code and tested**

| Rule | How |
|---|---|
| Off by default | Camera use is off for every robot until a signed-in person switches it on for that robot. Until then a picture is refused with that reason, by the server's gateway, and never shown for approval. A developer key can't switch it on |
| Read only on request | The simulator renders nothing until a capture is asked for; the robot's state carries the camera's health and a frame count, never pixels |
| Approval | A picture is a write: it follows the account's permission level. A physical robot's camera asks every time, with a warning that whoever is in front of the robot will be in the picture |
| Recorded twice | The robot's own log records each capture; the server records the stored picture |
| Kept for a limited time | 24 hours by default, 1 hour to 30 days; then deleted. At most 40 per robot |
| Access log | The list of pictures carries no image data. Opening one is written to the robot's events with who opened it (a signed-in person, or a developer key) |
| What is stored is checked | A picture is kept only if it is a real PNG of the size it claims, at most 200 kB, from a camera that robot registered, taken after it was asked for, while camera use is still on. Anything else is recorded as "unverified" and nothing is stored |
| No identification | Nothing identifies a person. There is no face detection or recognition anywhere |
| The model doesn't get the picture | An agent receives the detections and their provenance, not the image |

`robots.camera` (tool `robot_camera`) reads what the camera last saw: the detections of the most recent picture, with its age. A picture older than 30 seconds is marked stale and described as what the camera saw then.

**Not built:** recording, a live preview, privacy zones that mask part of an image, export, sharing a picture with another account.
