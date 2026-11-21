# Robotics Safety Gateway — design

**HANNAH is not safety-certified, and nothing in this document is a safety claim.** The Safety Gateway is ordinary software that refuses bad commands early and explains why. It reduces mistakes. It does not make a robot safe: that is the job of the robot's own safety-rated controller, sensors and emergency stop, designed and assessed by qualified people against the standards in section 7.

## 1. The layers

A request passes each layer in order. Each is independent of the ones above it.

| # | Layer | Where | Depends on |
|---|---|---|---|
| 1 | Capability choice | The model picks a named capability | — |
| 2 | Permission | Action Engine, `permissions.js` | Server |
| 3 | Server gateway | `server/robotics/safety.js` | Server, the robot's last report |
| 4 | Approval | A signed-in person | Server, the app |
| 5 | Server gateway again | At the moment of sending | Server |
| 6 | Command guard | Runtime `protocol.py` | The robot's computer only |
| 7 | Robot gateway | Runtime `safety.py` | The robot's computer only |
| 8 | Mission supervision | Runtime `runtime.py`: timeout, link watchdog, emergency stop, faults | The robot's computer only |
| 9 | Planner | Nav2 costmaps and collision monitor, or the simulator's navigator | The robot's computer only |
| 10 | Controller limits | `ros2_control` / the base controller: speed, acceleration, command timeout | The robot's controller |
| 11 | **Safety-rated functions** | Emergency stop, protective stop, safety scanner fields, speed and force limiting | **Hardware. Not HANNAH's. Must work with layers 1–10 stopped** |

Layers 6 to 11 work with the server, the internet, the model provider and the app unavailable.

## 2. Server gateway: what it checks

`check({robot, capabilityId, params, now, active})` answers three questions.

**Is it a valid command for this robot?**

| Check | Refusal |
|---|---|
| Robot enrolled, not revoked | "credentials were revoked" |
| Capability registered by this robot, not switched off | "doesn't offer…", "is switched off for…" |
| Input matches the capability's schema; no unknown fields | the field and the problem |
| Goal resolves: a named place the robot registered, or x and y, not both | lists the places the robot has |
| Goal inside every workspace polygon (the robot's and the owner's) | "outside the robot's allowed workspace" |
| Goal outside every keep-out zone | names the zone |
| Requested speed not above the limit in force | both numbers |
| The robot reported a speed limit and a workspace at all | "HANNAH won't move it" |

**Is the robot in a state to take it?**

| Precondition | Refusal |
|---|---|
| Reported in the last 12 seconds | how long ago; "it is offline" |
| Emergency stop released | "has to be released at the robot" |
| Motors enabled, no active fault, localized | the fault's own message |
| Battery above the minimum (not for returning to dock) | both percentages |
| Range and odometry sensors reporting | which sensor; "it won't be moved" |
| No other motion mission running | which one |

**How risky is it, and must a person approve?**

| Situation | Result |
|---|---|
| Reading state or a sensor | Allowed |
| Stopping | Allowed at every level, during the account's emergency stop, by an agent's key |
| Movement, simulated robot | Follows the account's level: asks at level 3; a standing permission naming that robot can cover it at level 4 |
| Movement, **physical robot, not commissioned** | **Refused.** Enrolling proves which device it is, not that it is safe to move. See ONBOARDING_AND_COMMISSIONING.md |
| Movement, physical robot in its commissioning trial | Asks, capped at 0.2 m/s, with a warning that a person must be at the robot |
| Movement, **physical robot, commissioned** | **Always asks**, whatever the level or standing permission. Risk is "high" in a space shared with people or with no environment declared |
| Owner set "ask before every movement" or "always ask" for a capability | Always asks |

A refusal is recorded in the account's history with its reason and is never shown for approval. The second run at sending time catches what changed while an approval waited; a test covers an emergency stop pressed in that window.

## 3. Robot gateway: what it checks again

`LocalSafety.check` in the runtime, against the profile file on the robot:

- the capability is one this robot offers;
- emergency stop, motors, faults, localization, battery, one mission at a time;
- the goal is inside the robot's workspace, outside its keep-out zones, **and not inside or touching an obstacle on the robot's own map** (the server can't know this one; a test shows the robot refusing a goal the server passed);
- the speed for the mission is the lowest of the robot's own limit, the command's request and the owner's limit. A command can never raise it;
- for returning to dock, the dock is where the robot's profile says it is, whatever the command contains.

The robot's refusal is the last word. It is reported back and shown as "refused by the robot", with the robot's reason.

## 4. The architecture points the directive lists

| Requirement | Design | State |
|---|---|---|
| Emergency-stop hardware integration | The runtime **reads** the emergency-stop state (a topic on a ROS robot, a simulated input in the simulator) and reports it. It aborts the mission when it engages and never resumes. It has no way to release it or to enable motors. The stop itself must be wired to cut drive power without software | Reading and reacting: tested in simulation. Hardware wiring: not HANNAH's, and not yet met on any real robot |
| Speed and acceleration limits | Profile → runtime → planner ceiling → controller limit. The simulator's base controller enforces them whatever it is asked (tested with a request for 50 m/s) | Tested in simulation |
| Workspace restrictions | Polygons from the robot, tightened by the owner; checked on both sides | Tested |
| Collision constraints | The planner's inflated map; on ROS, Nav2's costmaps and collision monitor. A collision in the simulator stops the drive and latches a fault that only a local action clears | Simulator: tested. Nav2: not run |
| Obstacle constraints | The range sensor stops the robot for anything in its path and the planner goes around obstacles that aren't on the map; if there is no way, the mission fails with the reason | Tested in simulation |
| Command expiration | Every command expires (20 s by default; the robot can set 2–300 s). An expired command is refused by the server and by the robot and is never run later | Tested on both sides |
| Communication-loss handling | The runtime aborts the mission and holds when it has heard nothing from HANNAH for the link timeout (5 s by default). It reports why when the link returns and does not resume | Tested with a cut network link |
| Watchdogs | (a) the link watchdog above; (b) the base controller's command timeout (0.5 s in the simulator; `cmd_vel_timeout` in `ros2_control`); (c) `ros2_watchdog.py`, a separate process that stops the robot if the runtime's heartbeat stops | (a), (b) tested in simulation. (c) written, not run |
| Motor-enable state | Reported by the adapter; movement is refused when motors are disabled. HANNAH has no capability to enable motors | Tested |
| Safe shutdown | On exit the runtime holds the robot before closing the adapter | Implemented; not separately tested |
| Operator approval for risky operations | Section 2, third table | Tested |

## 5. What a stop is, and is not

| | HANNAH's Stop | An emergency stop |
|---|---|---|
| What it is | A signed command over the network asking the robot's software to cancel and hold | A physical control that removes drive power through a safety-rated circuit |
| Works with the network down | No (the robot stops itself on link loss instead) | Yes |
| Works with the robot's computer frozen | No | Yes |
| Reaction time | Up to the exchange interval plus braking | Defined by the safety design |
| Standard | None | ISO 13850, IEC 60204-1 stop categories |

The app says this in three places: a notice on the Robots screen, the caption under the Stop button, and the tool description the model reads. For a physical robot the caption tells the person to use the button on the robot. Stopping an offline robot is recorded as "could not be delivered", never as stopped.

## 6. Failing safe

| Failure | What happens |
|---|---|
| Internet, server or model provider down | The robot finishes nothing new; a running mission is aborted after the link timeout; the robot holds |
| App closed or phone off | Nothing changes: the app is not in the control path |
| The robot's clock is wrong | Commands look expired or issued in the future and are refused |
| A command is replayed, altered or meant for another robot | Refused before it is read; logged on the robot |
| The runtime crashes | Simulator: it stops with it. ROS: the watchdog process stops the robot (not yet run) |
| The robot reports success it didn't achieve | The server checks the reported position against the goal; a mismatch is recorded as "unverified", not as success |
| The robot stops reporting during a mission | The mission becomes "lost: outcome unknown" after its deadline. Never "succeeded" |
| A sensor it needs to drive stops reporting | The trip fails and the robot stops; new movement is refused on both sides |
| The link is lost while a mission is paused | The robot is already holding; the mission is kept; only a signed resume, with the link up, restarts it |
| A resume command is replayed | Recognised and ignored: a resume expires in 20 seconds and its nonce works once |
| The robot's credentials are revoked | It can no longer exchange; it holds; unfinished missions become "lost" |

## 7. Standards and engineering reviews, by robot category

A starting list for a qualified safety engineer. It is not complete, not legal advice, and editions and regional requirements must be checked at the time. HANNAH has been assessed against none of them.

| Category | Standards to review | Reviews before the first real run |
|---|---|---|
| **All machinery** | ISO 12100 (risk assessment), ISO 13849-1/-2 or IEC 62061 (safety-related control systems), IEC 61508 (functional safety), IEC 60204-1 (electrical equipment, stop categories), ISO 13850 (emergency stop) | A documented risk assessment; the safety functions and their required performance level; proof that they are independent of HANNAH |
| **Mobile robots in workplaces** (AMRs, AGVs) | ISO 3691-4 (driverless industrial trucks), ANSI/RIA R15.08 (industrial mobile robots), IEC 61496 (protective devices such as safety laser scanners) | Braking distance against scanner fields at each speed; behaviour at field edges, ramps and blind corners; site assessment of every route |
| **Industrial robot arms** | ISO 10218-1/-2 (the 2025 edition includes collaborative operation, formerly ISO/TS 15066) | Cell design; force and pressure limits for contact; tool and payload hazards; safeguarding validation |
| **Mobile manipulators** | The two rows above together, plus R15.08 for the combination | Stability while the arm moves; reach beyond the base's protective fields |
| **Personal care and service robots near the public** | ISO 13482 (personal care robots), UL 3300 (service and similar robots) | Hazards to untrained people, children and animals; tip-over; pinch points; what the robot does when ignored or blocked |
| **Aerial robots** | The aviation authority's rules where it flies (for example EASA's UAS regulations, FAA Part 107), ISO 21384-3 | Operating category and authorisation; geofencing; lost-link behaviour; fail-safe landing |
| **Electrical and battery** | IEC 62368-1 or IEC 61010-1; IEC 62133, UN 38.3 for lithium batteries; IEC 60825-1 for lidar lasers | Charging hazards; battery protection; laser class |
| **Software and connectivity, all categories** | IEC 62443 (security for industrial automation), ETSI EN 303 645 (consumer devices), the EU Cyber Resilience Act; in the EU, the Machinery Regulation (EU) 2023/1230 (applies from January 2027) and the AI Act where an AI system is a safety component | A security review of this protocol by someone who didn't write it; a threat model for the robot's network; a decision on whether HANNAH is a safety component (it is designed not to be) |

The design intent that keeps HANNAH out of the safety function: every safety-rated function is hardware below layer 10, and must be shown to hold with HANNAH's runtime, the server and the network all failed. That has to be demonstrated per robot. It has not been demonstrated on any.
