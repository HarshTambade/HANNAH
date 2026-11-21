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

Robots → the robot → Commissioning. Seven steps, in order. Only a signed-in person can confirm a step; an agent's key cannot. Each confirmation records who, when and a note.

| # | Step | What the server checks itself | What you attest |
|---|---|---|---|
| 1 | Verify the device's identity | A fingerprint exists | It is the one the runtime printed |
| 2 | Review sensors and actuators | The robot reported at least one of each | The list matches the machine |
| 3 | Confirm its limits | A speed limit, a workspace, a link timeout and a physical environment were reported | They fit where it will run |
| 4 | Validate the emergency-stop hardware | The robot reports a hardware emergency stop, and HANNAH saw it engage and then release since commissioning started | From your own test: the button cuts drive power with the robot's computer switched off |
| 5 | Run read-only diagnostics | Now: connected, no fault, every sensor reporting, localized, stop released | — |
| 6 | Supervised low-speed trial | One movement at 0.2 m/s or less, finished and verified, made after step 5 | A person was at the robot and the space was clear |
| 7 | Approve for operation | Steps 1–6 | You accept this robot being moved by HANNAH here |

- A step whose evidence is missing is refused with what is missing. A tick alone never passes steps 2 to 6.
- After step 5 the robot is in **trial mode**: movement is allowed, capped at 0.2 m/s, and each one asks with a warning that a person must be at the robot.
- After step 7 the cap is lifted. **Every movement still needs your approval**; no standing permission covers a physical robot.
- Commissioning is **withdrawn automatically** when the robot enrolls again or reports different sensors, actuators, capabilities or limits, and you can withdraw it yourself with a reason. Reading and stopping never depend on it.

## Before commissioning a real robot

These are yours and are not checked by software:

- A risk assessment for this robot in this space, by a qualified person.
- The emergency stop, protective devices and controller limits working with HANNAH's runtime stopped and the network unplugged.
- Nav2 (or the robot's own navigation) working on its own, with its map.
- The ROS 2 adapter having passed the Gazebo acceptance check (it has not been run yet).
