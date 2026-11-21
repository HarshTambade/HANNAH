"""HANNAH Robotics Runtime: the program that runs on the robot's own computer.

It keeps the robot safe without HANNAH's server, the internet or a language
model: it checks every command's signature, age and sequence, then its own
safety limits, hands accepted goals to the robot's planner and controller, and
stops the robot when its link to HANNAH is lost. It needs only the Python
standard library; the ROS 2 adapter additionally needs rclpy and nav2_msgs.
"""

__version__ = "0.1.0"
PROTOCOL = "hannah-robot-v1"
