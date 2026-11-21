#!/usr/bin/env bash
# The Gazebo acceptance check: start Gazebo Harmonic and Nav2 headless, then run
# HANNAH's simulation suite with the runtime's ROS 2 adapter. NOT YET RUN.
#
# Needs: a sourced ROS 2 Jazzy environment with ros_gz, Nav2 and this workspace
# built; Node.js 20+; server/node_modules installed. robotics/Dockerfile.gazebo
# provides all of that.
set -euo pipefail

: "${HANNAH_ROBOT_PROFILE:?set HANNAH_ROBOT_PROFILE to the installed hannah_profile.json}"
# ROS setup scripts read variables that may be unset.
set +u
source /opt/ros/jazzy/setup.bash
# <install>/hannah_sim/share/hannah_sim/config/hannah_profile.json → <install>/setup.bash
source "$(dirname "$HANNAH_ROBOT_PROFILE")/../../../../setup.bash"
set -u

log="$(mktemp)"
ros2 launch hannah_sim sim.launch.py >"$log" 2>&1 &
launch=$!
trap 'kill "$launch" 2>/dev/null || true; echo "--- launch log (last 80 lines) ---"; tail -n 80 "$log"' EXIT

echo "Waiting for Nav2's navigator…"
for attempt in $(seq 1 120); do
  if ros2 action list 2>/dev/null | grep -q "/navigate_to_pose"; then break; fi
  if ! kill -0 "$launch" 2>/dev/null; then echo "The launch exited early."; exit 1; fi
  sleep 2
done
ros2 action list | grep -q "/navigate_to_pose" || { echo "Nav2 never offered navigate_to_pose."; exit 1; }

cd "$(dirname "$0")/../../server" 2>/dev/null || cd /hannah/server
node --test robotics.sim.test.js
