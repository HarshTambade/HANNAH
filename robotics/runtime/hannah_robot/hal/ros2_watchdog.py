"""An independent watchdog for a ROS 2 robot: stops it when HANNAH's runtime goes silent.

STATUS: written against ROS 2 Jazzy's interfaces and NOT YET RUN.

HANNAH's runtime publishes a heartbeat every tick. If this process hears none
for `--timeout` seconds it cancels every Nav2 navigation goal and publishes
zero velocity for two seconds. It runs as its own process (the launch file
restarts it if it dies), so it still works when the runtime has crashed or
hung, which is exactly when it is needed.

It is one more software layer, not a safety function. A robot's controller
should also have its own command timeout (ros2_control's diff_drive_controller
has cmd_vel_timeout), and its emergency stop is hardware.

    python3 -m hannah_robot.hal.ros2_watchdog --timeout 3.0 [--sim-time]
"""
from __future__ import annotations

import argparse
import sys
import time


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Stop the robot when HANNAH's runtime stops sending its heartbeat.")
    parser.add_argument("--timeout", type=float, default=3.0)
    parser.add_argument("--heartbeat", default="/hannah/heartbeat")
    parser.add_argument("--cmd-vel", default="/cmd_vel")
    parser.add_argument("--action", default="navigate_to_pose")
    parser.add_argument("--sim-time", action="store_true")
    args, _ = parser.parse_known_args(argv)

    import rclpy
    from action_msgs.srv import CancelGoal
    from geometry_msgs.msg import Twist
    from rclpy.parameter import Parameter
    from std_msgs.msg import Empty

    rclpy.init()
    node = rclpy.create_node("hannah_watchdog", parameter_overrides=[Parameter("use_sim_time", Parameter.Type.BOOL, args.sim_time)])
    state = {"last": None, "tripped": False, "zero_until": 0.0}

    def beat(_message) -> None:
        if state["tripped"]:
            node.get_logger().info("HANNAH's runtime is back. The robot stays still until it gets a new command.")
        state["last"], state["tripped"] = time.monotonic(), False

    node.create_subscription(Empty, args.heartbeat, beat, 10)
    velocity = node.create_publisher(Twist, args.cmd_vel, 10)
    cancel = node.create_client(CancelGoal, f"{args.action}/_action/cancel_goal")

    def check() -> None:
        now = time.monotonic()
        # Armed only once a heartbeat has been heard: before that, HANNAH isn't in charge of anything.
        if state["last"] is not None and not state["tripped"] and now - state["last"] > args.timeout:
            state["tripped"], state["zero_until"] = True, now + 2.0
            node.get_logger().error(f"No heartbeat from HANNAH's runtime for {args.timeout:.1f} s. Cancelling navigation and stopping.")
            if cancel.service_is_ready():
                cancel.call_async(CancelGoal.Request())  # an empty goal id and time: cancel every goal
        if now < state["zero_until"]:
            velocity.publish(Twist())

    node.create_timer(0.1, check)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    node.destroy_node()
    rclpy.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
