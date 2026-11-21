# HANNAH Robotics

Everything that runs on or beside a robot. The server side is in `server/robotics`, the app's screen is `client/src/components/RoboticsPage.tsx`, and the design documents are in `docs/robotics`.

| Folder | What it is | State |
|---|---|---|
| `runtime/` | The HANNAH Robotics Runtime: the program on the robot's own computer. Python 3.9+, standard library only | Tested (69 tests) |
| `runtime/hannah_robot/hal/kinematic.py` | A built-in simulated differential-drive robot. **Not Gazebo.** | Tested |
| `runtime/hannah_robot/hal/ros2.py`, `ros2_watchdog.py` | The ROS 2 adapter (Nav2) and its watchdog | **Written, never run** |
| `ros2_ws/src/hannah_sim/` | A robot, a world and Nav2 for Gazebo Harmonic on ROS 2 Jazzy | **Written, never run** |
| `worlds/workcell.json` | One room, used by the built-in simulator and to generate the Gazebo world and the Nav2 map | |
| `profiles/` | Robot profiles: what a robot is and the limits it enforces | |
| `worlds/home.json`, `scenarios/` | A home with rooms and doorways; five navigation scenarios (`python3 -m hannah_robot.scenarios`) | Tested |
| `sdk/examples/` | An example signed robot package | Tested |
| `ros2_ws/VERSIONS.yaml` | The ROS 2 and Gazebo versions the files were written for | |
| `tools/build_world.py` | Regenerates the Gazebo world and map from the world file | Tested |
| `tools/gazebo_check.sh`, `Dockerfile.gazebo` | The Gazebo acceptance check | **Never run** |

HANNAH is not safety-certified. Its Stop is a software request, not an emergency stop.

## Try a whole mission on one computer (no ROS, no Gazebo)

You need HANNAH's server running with a vault key (`HANNAH_VAULT_KEY`) and an account.

1. In the app, open **Robots → Add a robot**, name it, choose **A simulated robot**. You get a one-time code.
2. On the same computer:

   ```bash
   cd robotics/runtime
   python3 -m hannah_robot enroll --server http://127.0.0.1:3001 --code XXXXX-XXXXX
   python3 -m hannah_robot run
   ```

   The first command stores the robot's secret in `~/.hannah-robot/sim-diffdrive/` (readable only by you). The second starts the built-in simulator and keeps it connected.
3. The robot shows as **Connected** and **SIMULATION**. Choose a place and **Ask to drive there**, approve it, and watch the mission; or ask in chat: "Move the robot to the workbench."
4. Things to try: **Stop** during a trip; cancel a mission; stop the server and watch the robot stop itself after five seconds; press the simulated emergency stop:

   ```bash
   echo '{"estop": true}'  > ~/.hannah-robot/sim-diffdrive/sim-inputs.json    # and {"estop": false} to release
   echo '{"obstacles": [{"x": -3.2, "y": -1.4, "w": 1.2, "h": 0.6}]}' > ~/.hannah-robot/sim-diffdrive/sim-inputs.json   # an obstacle that isn't on its map
   ```

`--sim-speed 8` runs the simulation eight times faster. A server on another computer must be `https://`.

## The runtime's commands

```
python3 -m hannah_robot describe [--profile FILE]                       what this robot would tell HANNAH about itself
python3 -m hannah_robot enroll --server URL --code CODE [--profile FILE] [--state-dir DIR]
python3 -m hannah_robot run [--profile FILE] [--state-dir DIR] [--sim-speed N] [--sync-interval S]
```

It logs one JSON line per event. It never logs the robot's secret.

## Tests

```bash
cd robotics/runtime && python3 -m unittest discover -s tests -t .      # unit and simulation, no server
cd server && node --test robotics.contract.test.js robotics.test.js robotics.sim.test.js
cd client && npx vitest run src/__tests__/Robotics.test.ts && npx playwright test robotics.spec.ts
```

`robotics.sim.test.js` and `robotics.spec.ts` start the real server and the real runtime. See `docs/robotics/TESTS.md` for what each level covers.

## Gazebo and ROS 2

Not yet run anywhere. `docs/robotics/ROS2_GAZEBO_INTEGRATION.md` section 7 has the three ways to run it for the first time; the shortest is:

```bash
docker build -f robotics/Dockerfile.gazebo -t hannah-gazebo .
docker run --rm hannah-gazebo
```

After changing `worlds/workcell.json`, run `python3 tools/build_world.py`.

What works and what doesn't, stage by stage: `docs/robotics/STAGE_STATUS.md`.
