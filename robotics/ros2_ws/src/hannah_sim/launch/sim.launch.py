"""Gazebo Harmonic + Nav2 for hannah_bot. Written for ROS 2 Jazzy; NOT YET RUN.

    ros2 launch hannah_sim sim.launch.py            # headless
    ros2 launch hannah_sim sim.launch.py gui:=true  # with the Gazebo window

Starts: the Gazebo server with the generated workcell world, the robot, the
Gazebo/ROS bridge, robot_state_publisher, Nav2 with the generated map, and
HANNAH's watchdog (which stops the robot if HANNAH's runtime goes silent).
HANNAH's runtime itself is started separately, after enrolling:

    python3 -m hannah_robot run --profile <share>/hannah_sim/config/hannah_profile.json
"""
import json
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess, IncludeLaunchDescription
from launch.conditions import IfCondition
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    share = get_package_share_directory("hannah_sim")
    world = os.path.join(share, "worlds", "workcell.sdf")
    model = os.path.join(share, "models", "hannah_bot", "model.sdf")
    with open(os.path.join(share, "urdf", "hannah_bot.urdf"), "r", encoding="utf-8") as handle:
        urdf = handle.read()
    # Where the robot starts: the same place as in HANNAH's built-in simulator.
    start = {"x": -4.3, "y": -3.3, "yaw": 0.0}
    world_json = os.environ.get("HANNAH_WORLD_JSON")
    if world_json and os.path.exists(world_json):
        with open(world_json, "r", encoding="utf-8") as handle:
            start = json.load(handle).get("start", start)

    gazebo = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(os.path.join(get_package_share_directory("ros_gz_sim"), "launch", "gz_sim.launch.py")),
        launch_arguments={"gz_args": f"-r -s --headless-rendering {world}", "on_exit_shutdown": "true"}.items(),
    )
    gui = ExecuteProcess(cmd=["gz", "sim", "-g"], condition=IfCondition(LaunchConfiguration("gui")), output="screen")
    spawn = Node(package="ros_gz_sim", executable="create", output="screen", arguments=[
        "-world", "workcell", "-file", model, "-name", "hannah_bot",
        "-x", str(start["x"]), "-y", str(start["y"]), "-z", "0.02", "-Y", str(start.get("yaw", 0.0)),
    ])
    bridge = Node(package="ros_gz_bridge", executable="parameter_bridge", output="screen", parameters=[{"config_file": os.path.join(share, "config", "bridge.yaml"), "use_sim_time": True}])
    state_publisher = Node(package="robot_state_publisher", executable="robot_state_publisher", output="screen", parameters=[{"robot_description": urdf, "use_sim_time": True}])
    nav2 = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(os.path.join(get_package_share_directory("nav2_bringup"), "launch", "bringup_launch.py")),
        launch_arguments={"map": os.path.join(share, "maps", "workcell.yaml"), "use_sim_time": "True", "autostart": "True", "use_composition": "False"}.items(),
    )
    # Independent of HANNAH's runtime: cancels navigation and zeroes the velocity if the runtime's heartbeat stops.
    watchdog = ExecuteProcess(cmd=["python3", "-m", "hannah_robot.hal.ros2_watchdog", "--timeout", "3.0", "--sim-time"], output="screen", respawn=True)

    return LaunchDescription([
        DeclareLaunchArgument("gui", default_value="false", description="Also open the Gazebo window."),
        gazebo, gui, spawn, bridge, state_publisher, nav2, watchdog,
    ])
