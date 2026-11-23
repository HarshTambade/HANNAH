# ROS2 Integration Templates

These files are templates for HANNAH Robot OS ROS2 integration. They have **not** been executed in this environment (no ROS2 Jazzy/colcon installed).

## Contents

- `ros2_control.diffdrive.yaml` - ros2_control controller manager template for differential drive.
- Future: launch files, Nav2 params, TF/static transforms, sensor driver configs, hardware interface plugin package.

## Safety boundary

ROS2/Nav2 receives validated high-level goals/commands. It does not bypass the HANNAH safety gateway or motor controller limits. Hardware emergency stop and controller watchdogs remain independent.
