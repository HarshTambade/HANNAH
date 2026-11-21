# Deploying the robot runtime

For the person putting HANNAH's runtime on a robot's own computer. The runtime, `enroll`, `run` and `doctor` are tested with the built-in simulators on macOS. **The service unit in `robotics/deploy/` has never been started**, and nothing here has run on a robot. HANNAH is not safety-certified.

## What goes where

| Where | What | Needs |
|---|---|---|
| The robot's computer | `robotics/runtime` (the `hannah_robot` package), a profile file, a state directory | Python 3.9 or newer. Nothing else for a simulated robot. A ROS 2 robot also needs its ROS 2 environment sourced |
| The HANNAH server | Already part of the server | `HANNAH_VAULT_KEY` (robots can't enroll without it), migrations 18 to 21 (applied by themselves on first use) |
| The app | Nothing to install | It is never in the control path |

The robot opens every connection. Nothing listens on the robot, and no port has to be opened towards it.

## Steps

1. **Copy the runtime** to the robot's computer, for example `/opt/hannah-robot`. It has no dependencies to install.
2. **Write the profile**: adapter, identity, limits (HARDWARE_ABSTRACTION.md). The limits in this file are the ones the robot enforces; nothing on the server can loosen them.
3. **Create the robot in HANNAH** (Robots → Add a robot), saying whether it is simulated or physical. You get a one-time code, valid for 15 minutes.
4. **Enroll**, as the user the runtime will run as:
   `python3 -m hannah_robot enroll --server https://your-hannah --code XXXXX-XXXXX --profile profile.json --state-dir /var/lib/hannah-robot/state`
   The secret is written to `credentials.json` in the state directory, readable only by that user. Compare the fingerprint it prints with the one HANNAH shows for the robot.
5. **Check the computer**: `python3 -m hannah_robot doctor --profile … --state-dir …`
6. **Run**: `python3 -m hannah_robot run --profile … --state-dir …`, or as a service (below).
7. **A physical robot** now has to be commissioned in HANNAH before it may move (ONBOARDING_AND_COMMISSIONING.md).

## The health check

`doctor` checks the computer, not the robot. It moves nothing, doesn't start the adapter, and makes no signed request, so it can be run while the runtime is running.

| Check | A problem when |
|---|---|
| Python | Older than 3.9 |
| Profile | Unreadable, not JSON, or an unknown adapter |
| ROS | The profile asks for the ROS 2 adapter and `rclpy` can't be imported |
| Kind | Never a problem: says SIMULATION or PHYSICAL |
| Limits | The link timeout, command lifetime, top speed (for a robot that drives) or workspace is missing |
| Emergency stop | A warning for a physical robot whose profile declares no hardware emergency stop |
| State directory | A warning when other users can read it |
| Credentials | Not enrolled, incomplete, or the file is readable by other users |
| Server address | Not `https://` to another computer (unless `--allow-insecure` on a closed development network) |
| Server | It doesn't answer |
| Clock | More than 60 s from the server's: signed requests are refused and commands look expired. A warning beyond 20 s |

It exits 0 when nothing is a problem, 1 otherwise; `--json` prints the checks for a monitoring tool. The secret is never printed.

## As a service

`robotics/deploy/hannah-robot.service` is a systemd unit: a dedicated user, the health check before every start, a restart five seconds after a failure, and no access beyond the network, the profile and the state directory. **It was written without a systemd machine to try it on.** Its install commands are in its header.

What a restart does and doesn't do:

| Event | What happens |
|---|---|
| The service is stopped (SIGTERM) | The runtime holds the robot, then exits |
| The runtime crashes | Built-in simulator: it stops with it. ROS 2 robot: the separate watchdog process stops the robot when the heartbeat stops (written, never run) |
| The service restarts, or the computer reboots | The runtime starts with the robot holding. **A mission is never resumed**: the server marks one that stopped reporting as "lost", and only a new, checked, approved command moves the robot again |
| The network goes away | The robot stops after its link timeout (5 s by default) and holds until a new command arrives |

## Logs

The runtime writes one JSON object per line to standard output: `running`, `report` (each mission status it sends), `link-error`, `link-lost`, `link-restored`, `revoked`, `stopped`. Under systemd: `journalctl -u hannah-robot`. The secret is never logged. What the server recorded about the robot is under Robots → the robot → events, and at `GET /api/robots/events`.

## Changing things later

| To | Do |
|---|---|
| Update the runtime | Stop the service, replace the files, run `doctor`, start. The robot holds meanwhile. A physical robot that reports different sensors, capabilities or limits afterwards has to be commissioned again |
| Replace the secret | Robots → New code, then `enroll` again. The old secret stops working at once |
| Take a robot out of service | Robots → Revoke. Its runtime can no longer exchange; it holds. Delete the state directory on the robot |
| Move to another server | Create the robot there and enroll again. Credentials are bound to one server |

## Backups

Everything the server knows about robots is in its database. Each robot's secret is stored sealed by the server's vault key: a database restored without that key can't authenticate any robot, and every robot has to be enrolled again. After restoring an older backup, re-enroll robots that connected since (SECURITY_ARCHITECTURE.md, section 11).

## Not available

An installer or package, automatic updates, signed firmware updates (design only), configuration management across a fleet, monitoring integrations beyond the JSON output above, deployment on anything other than a general-purpose computer with Python.
