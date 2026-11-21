# Robot capability contract

The contract is the complete list of operations HANNAH can ask a robot for. It is code: `server/robotics/contract.js`. The app reads it from `GET /api/robots/contract`.

A capability is a high-level operation. There is no capability for a wheel speed, a motor PWM value, a joint torque or "send this to the actuator", and a test fails if a capability or one of its inputs is ever named that way.

## What every capability defines

| Field | Meaning |
|---|---|
| `id`, `title`, `description` | What it is |
| `robotTypes` | Which types of robot may register it |
| `input`, `output` | JSON Schema. Input is validated; unknown fields are refused |
| `preconditions` | What must be true before it is sent |
| `permissions` | The Action Engine service (`robots`) and the minimum level |
| `constraints` | The operating limits that apply |
| `risk` | none, low, moderate, high |
| `timeoutS` | Default and maximum run time |
| `cancel` | Whether it can be cancelled and what cancelling does |
| `verification` | How the result is checked |
| `status` | `implemented`, or `contract-only` (defined, with no runtime behind it) |

## The capabilities

| Capability | Robot types | Risk | Timeout | Cancelling | Verified by | Status |
|---|---|---|---|---|---|---|
| `report_robot_state` | any | none | 5 s | — | The report's age; a stale report is marked stale | Implemented |
| `read_sensor` | any | none | 5 s | — | The reading's age; an unknown sensor is an error | Implemented |
| `stop_motion` | any | low | 10 s | not cancellable | Measured speed is zero | Implemented |
| `navigate_to` | mobile ground robots | moderate | 180 s (max 900) | planner cancelled, robot holds | Reported position within tolerance of the goal, standing still | Implemented |
| `return_to_dock` | mobile ground robots | moderate | 240 s | as above | As above, at the dock | Implemented |
| `inspect_area` | mobile ground robots | moderate | 600 s | robot stops; visited points stay in the report | Every point reached within tolerance | Implemented |
| `set_supported_device_state` | any | low | 10 s | — | The next state report shows the device in that state | Implemented |
| `capture_image` | any | none | 15 s | no image kept | An image with its capture time | Contract only |
| `follow_target` | mobile ground robots | high | 300 s | robot stops and holds | The tracker's record | Contract only |
| `move_robot_arm` | arms, mobile manipulators | high | 60 s | trajectory stopped, arm holds | Measured joint positions | Contract only |
| `grasp_object` | arms, mobile manipulators | high | 30 s | gripper stops; does not open | Gripper position and force | Contract only |
| `release_object` | arms, mobile manipulators | high | 15 s | — | Gripper position | Contract only |

## Preconditions

`enrolled`, `online`, `estop-released`, `motors-enabled`, `no-fault`, `localized`, `battery-ok`, `no-active-motion`, `dock-configured`. Movement needs all of the first eight. Returning to the dock is allowed on a low battery. Stopping needs only `enrolled`.

## Registration

A robot offers capability ids when it enrolls. Each is accepted only if it is in the contract, is meant for that type of robot, and is implemented. The rest are recorded with the reason and shown on the Robots screen.

```
offered:  navigate_to, stop_motion, set_motor_pwm, move_robot_arm, capture_image   (a differential-drive robot)
accepted: navigate_to, stop_motion
refused:  set_motor_pwm    — not in HANNAH's capability contract
          move_robot_arm   — in the contract, but no runtime implements it yet
          capture_image    — in the contract, but no runtime implements it yet
```

Asking a robot for a capability it didn't register is refused by the Safety Gateway before anyone is asked to approve it.

## As Action Engine actions

| Action | Capability | Kind |
|---|---|---|
| `robots.list` | — | read |
| `robots.state` | `report_robot_state` | read |
| `robots.read_sensor` | `read_sensor` | read |
| `robots.mission` | — (reads a mission's status and result) | read |
| `robots.navigate_to` | `navigate_to` | write |
| `robots.return_to_dock` | `return_to_dock` | write |
| `robots.inspect_area` | `inspect_area` | write |
| `robots.set_supported_device_state` | `set_supported_device_state` | write |
| `robots.stop_motion` | `stop_motion` | write, `deescalates` |

A read is answered from the registry's last report and never sends anything to the robot. A write starts a mission.

## Adding a capability

1. Define it in `contract.js` with every field, `status: "contract-only"`.
2. Add its checks to both gateways (`server/robotics/safety.js`, runtime `safety.py`).
3. Add an executor in `runtime.py` and the adapter method it needs.
4. Add its verification in `service.js` (`verifyMission`). A capability whose result can't be checked is not finished.
5. Add the action in `server/actions/catalog/robots.js` and the tool in `client/src/services/Robotics.ts`.
6. Change the status to `implemented` and add tests at each level.
