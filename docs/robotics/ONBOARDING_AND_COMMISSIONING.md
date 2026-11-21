# Onboarding a robot, and commissioning a physical one

**State: the procedure is implemented and tested on the server with a scripted stand-in robot. No physical robot has been onboarded or commissioned.** HANNAH is not safety-certified; commissioning here records that a person looked at the obvious things. It is not a safety assessment and does not replace one (see SAFETY_GATEWAY.md, section 7).

## Onboarding (any robot)

1. **Register.** Robots → Add a robot. Name it and say whether it is simulated or physical. You get a one-time code, valid 15 minutes.
2. **Prepare the robot's profile** (a JSON file on the robot): what it is, its limits, and for ROS 2 its topics and frames. See HARDWARE_ABSTRACTION.md. The limits in this file are the ones the robot enforces.
3. **Enroll**, on the robot's computer:
   ```bash
   cd robotics/runtime
   python3 -m hannah_robot enroll --server https://<your HANNAH> --code XXXXX-XXXXX --profile <profile.json>
   ```
   The runtime prints a **fingerprint**. A runtime of the wrong kind (a simulator for a "physical" record, or the reverse) is refused.
4. **Run:** `python3 -m hannah_robot run --profile <profile.json>`. The robot shows as Connected, labelled SIMULATION or PHYSICAL.
5. **Destinations.** A simulated robot may use the places its runtime reported. A physical robot goes by name only to destinations you define (pick a point on its map) or approve from its list. Each is checked against its workspace and tied to its current map.

A simulated robot can now be given missions. A physical robot cannot: every movement is refused until it is commissioned.

## Commissioning (physical robots)

Robots → the robot → Commissioning. Eleven steps, in order. Only a signed-in person can confirm a step; an agent's key cannot. Each confirmation records who, when, a note, and what the server read for itself at that moment.

Tested with a stand-in that reports what a robot would. **No physical robot has been commissioned.**

| # | Step | What the server checks itself | What you attest |
|---|---|---|---|
| 1 | Verify the device's identity | A fingerprint exists | It is the one the runtime printed |
| 2 | Review sensors and actuators | The robot reported at least one of each | The list matches the machine |
| 3 | Check software and firmware versions | The robot reported its runtime, software and firmware versions and lists the protocol this server speaks | The controller's firmware is the one this software was tested with |
| 4 | Confirm its limits | A speed limit, a workspace, a link timeout and a physical environment were reported | They fit where it will run |
| 5 | Check the robot model and coordinate frames | The robot is connected and reports a position in a named frame. Each sensor's registered frame is listed, and so is any sensor without one | In the robot's own tools: the model matches the machine, each sensor's frame is where the sensor is, forward is forward |
| 6 | Validate the emergency-stop hardware | The robot reports a hardware emergency stop, and HANNAH saw it engage and then release since commissioning started | From your own test: the button cuts drive power and leaves the motors disabled with the robot's computer switched off |
| 7 | Run read-only diagnostics | Now: connected, no fault, every sensor reporting, localized, stop released | — |
| 8 | Test the link watchdog | Since step 7, the robot itself reported that it lost its link and held, and then that the link returned | From your own test: the base controller stops the wheels when it hears nothing from the computer |
| 9 | Supervised low-speed trial | One movement at 0.2 m/s or less, finished and verified, made after step 8 | A person was at the robot and the space was clear |
| 10 | Compare the trip with a measurement | A verified trial trip exists; its goal and the position the robot reported are shown | You measured where it stopped, both wheels turned the right way, it drove towards the goal. **What you measured must be written down** |
| 11 | Approve for operation | Steps 1–10 | You accept this robot being moved by HANNAH here |

- A step whose evidence is missing is refused with what is missing. A tick alone never passes steps 2 to 10.
- After step 8 the robot is in **trial mode**: movement is allowed, capped at 0.2 m/s, and each one asks with a warning that a person must be at the robot. It stays in trial mode through steps 9 and 10.
- After step 11 the cap is lifted. **Every movement still needs your approval**; no standing permission covers a physical robot, and a plan of several steps is refused.
- Commissioning is **withdrawn automatically** when the robot enrolls again or reports different sensors, actuators, capabilities or limits, and you can withdraw it yourself with a reason. Reading and stopping never depend on it.

### The seventeen checks of the directive, and which step holds each

| Check | Step | How it is established |
|---|---|---|
| Robot identity | 1 | Server: fingerprint. Person: it matches |
| Hardware profile | 2 | Server: the reported inventory. Person: it matches the machine |
| Firmware compatibility | 3 | Server: versions were reported. **Person**: they are compatible. HANNAH has no compatibility table for any firmware |
| Controller connection | 7 | Server: the robot is connected and reports no fault. HANNAH doesn't see the controller itself, only what the robot's computer reports |
| Sensor connection | 7 | Server: every registered sensor is reporting |
| Robot model | 5 | **Person** |
| Coordinate frames | 5 | Server: a position frame is reported and sensor frames are listed. **Person**: they are right |
| Motor direction | 10 | **Person**, during the trial. Server: the robot's reported position reached the goal |
| Encoder polarity | 10 | **Person**. A reversed encoder would also fail the server's check of the trial, but only a measurement shows it |
| Wheel calibration | 10 | **Person**: the measured distance against the reported one, written down |
| Watchdog behaviour | 8 | Server: the runtime's link watchdog was seen to act. **Person**: the controller's own command timeout |
| Emergency-stop circuit | 6 | Server: engage and release were seen. **Person**: it cuts power with the computer off |
| Motor-disable behaviour | 6 | **Person**. HANNAH refuses movement while a robot reports its motors disabled, but does not record that they were disabled during this test |
| Low-speed operation | 9 | Server: a verified trip at 0.2 m/s or less |
| Odometry | 10 | Server: the reported final position. **Person**: the measurement |
| Navigation readiness | 7, 9 | Server: localized, and one navigation goal completed and verified |
| Safe operating restrictions | 4, 11 | Server: limits reported. Person: they fit the space, and the approval |

Where the table says **Person**, the software cannot know: it records that a named person said so, when, and what they wrote. That is a record, not a verification.

## Before commissioning a real robot

These are yours and are not checked by software:

- A risk assessment for this robot in this space, by a qualified person.
- The emergency stop, protective devices and controller limits working with HANNAH's runtime stopped and the network unplugged.
- Nav2 (or the robot's own navigation) working on its own, with its map.
- The ROS 2 adapter having passed the Gazebo acceptance check (it has not been run yet).
