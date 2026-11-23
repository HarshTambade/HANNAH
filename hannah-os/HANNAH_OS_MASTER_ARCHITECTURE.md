# HANNAH OS — architecture

HANNAH OS is the part of HANNAH that reaches hardware: robots, and the lights, plugs, sensors and meters around them. A person adds a device without writing code, says what HANNAH may change, and then asks in plain words or sets up an automation.

This page says how it is built and why. What works today, item by item, is in [HANNAH_OS_IMPLEMENTATION_TRACKER.md](./HANNAH_OS_IMPLEMENTATION_TRACKER.md). **Nothing here has been tested with a physical device, and no HANNAH OS image has been built.**

| Document | What it covers |
|---|---|
| [HANNAH_OS_IMPLEMENTATION_TRACKER.md](./HANNAH_OS_IMPLEMENTATION_TRACKER.md) | Every requirement with its real state and its tests |
| [HANNAH_OS_DEVICE_COMPATIBILITY.md](./HANNAH_OS_DEVICE_COMPATIBILITY.md) | Protocols, compatibility levels, the device profile format |
| [HANNAH_OS_SECURITY_ARCHITECTURE.md](./HANNAH_OS_SECURITY_ARCHITECTURE.md) | Keys, signatures, checks, untrusted input, privacy |
| [HANNAH_OS_TEST_REPORT.md](./HANNAH_OS_TEST_REPORT.md) | What was tested, at which level, and what was not |
| [HANNAH_OS_BLOCKERS.md](./HANNAH_OS_BLOCKERS.md) | What can't go further without the owner |
| [HANNAH_OS_DEPLOYMENT_GUIDE.md](./HANNAH_OS_DEPLOYMENT_GUIDE.md) | Trying it with simulated devices; putting a hub on a computer |
| [docs/robotics/ROBOTICS_ARCHITECTURE.md](../docs/robotics/ROBOTICS_ARCHITECTURE.md) | The robot side, which this builds on |

## 1. Three parts

```
┌──────────── HANNAH clients (web, desktop, Android, iOS) ───────────┐
│ Devices screen · chat · voice · Devices agent · Robots screen      │   never talk to a device
└───────────────────────────┬────────────────────────────────────────┘
                            │ HTTPS, the account's session or key
┌───────────────────────────▼────────────────────────────────────────┐
│ HANNAH control plane (server, Node; cloud-hosted or self-hosted)   │
│  Action Engine + permission manager        server/actions          │
│  Device registry, profiles, automations    server/devices          │
│  Device Safety Gateway · manual reader                             │
│  Robot registry and its Safety Gateway     server/robotics         │
└───────────────────────────▲────────────────────────────────────────┘
                            │ HTTPS opened BY THE HUB; every request signed
┌───────────────────────────┴────────────────────────────────────────┐
│ HANNAH Edge (Python, on a computer on the person's own network)    │
│  hub: command guard → its own write checks → rules → reports       │
│  adapters: MQTT · Modbus TCP · HTTP                                │
│  robot runtime (robotics/runtime), on a robot's computer           │
└───────────────┬───────────────────────┬────────────────────────────┘
                │ device protocols      │ ROS 2 (written, not run)
          devices on the LAN        the robot's planner and controller
```

The edge is where hardware is reached, because that is the only place it can be: device protocols such as Modbus have no sign-in and must not leave their network, and a hub has to keep working when the internet is away.

## 2. The rules everything follows

1. **A model never addresses a device.** It can choose a device by name and one of the points its profile lists ("temperature", "power"). It never sees a topic, a register or a URL, and there is no tool that takes one.
2. **Reading and changing are separate.** Every device can be read once it is switched on. A point can be changed only if a person allowed it for that device.
3. **Checked twice.** The server's Device Safety Gateway refuses a change that can't be valid and says why. The hub repeats the checks it can make itself, because it must not rely on the server.
4. **Done means the device said so.** A write is "done" when the device reports the new value. Otherwise it is "not confirmed", in the record, on the screen and in what the model is told.
5. **A value carries its age.** A reading is "live" only while its hub is reporting it. Otherwise it is the last value known, with how old it is.
6. **Automations have no model in them.** A rule is a comparison and a few writes, run by the hub. A person approves it once, through the Action Engine.
7. **No real-time control.** HANNAH sends "switch on" and "set to 40". Timing-critical control stays where it belongs: in the device, a microcontroller, a PLC, or a robot's controller under `ros2_control`.
8. **Not a safety system.** Interlocks, guards, thermostats' own limits and emergency stops stay in the equipment. Nothing in HANNAH is safety-certified.

## 3. How a request travels

```
"Turn on the fan"
  → the model picks hardware_switch { device: "Fan", on: true }        (client: services/Devices.ts)
  → Action Engine: permission level, standing grants                  (server/actions)
  → Device Safety Gateway: active? hub online? point allowed? in range?  (server/devices/safety.js)
  → approval by a signed-in person, when required
  → the gateway again, at the moment of sending
  → a signed command that expires in 20 seconds                       (server/devices/service.js)
  ───────────── network; the hub opens the connection ─────────────
  → signature, hub id, expiry, sequence                               (hub: protocol.py)
  → the hub's own check: allow-list, type, range, one write a second  (hub: hub.py, adapters/base.py)
  → the adapter writes in the device's protocol                       (adapters/)
  → the hub waits for the device to report the new value
  → result → the server records it → the person is told what the device reported
```

## 4. What already existed, and what was reused

HANNAH was already an AI companion with a server, web, desktop and phone clients, and a robot layer. The device layer reuses, unchanged:

| Existing | Reused for |
|---|---|
| Action Engine and permission manager (`server/actions`) | Every device change and every automation: one permission system, one approval flow, one history |
| Key vault (`server/vault.js`) | A hub's key and a device's passwords, sealed |
| Webhooks and the workflow engine | `device.alert` and `device.rule.fired` as events; schedules calling device actions |
| Model gateway (23 providers), agents, orchestrator, voice | A Devices agent and ten tools; nothing new in the model path |
| Document reader (`server/documents/read.js`) | Reading a manual, page by page |
| The robot runtime's protocol design (`robotics/runtime`) | The hub's enrollment, signed requests and command guard |
| Package signing (`server/robotics/packages.js`) | Signing and verifying device profiles |

New: `hannah-os/runtime` (the hub), `server/devices` (registry, profiles, gateway, manual reader), `server/actions/catalog/hardware.js`, the Devices screen, and `hannah-os/images` (image descriptions, not built).

Two older pieces are left as they are: `client/src/services/HardwareAdapter.ts` drives small devices from a browser tab and has no safety story for anything that matters; the device layer does not use it.

## 5. The operating-system foundation

HANNAH does not write a kernel. A HANNAH OS image would be an established Linux system with HANNAH Edge installed, enabled and locked down. Three foundations were evaluated on paper; **none has been built**.

| | Ubuntu Server LTS | Ubuntu Core | Yocto / OpenEmbedded |
|---|---|---|---|
| What it is | A general Linux distribution with standard packages | A minimal, immutable system made of confined snaps | A toolkit for building a tailored Linux image for one hardware target |
| Hardware and drivers | Widest support on PCs and common ARM boards | The boards Canonical or a vendor provides images for | Whatever the board's vendor supplies a layer for; widest for embedded silicon |
| ROS 2 | The platform ROS 2 Jazzy is built for (24.04) | Through snaps; more work to package | Through a community layer; the most work |
| Updates | Package updates; no rollback by itself | Transactional, with automatic rollback when a new revision fails | Whatever update system is added to the image |
| Security posture | A normal system to harden | Read-only base, confined applications; secure boot and disk encryption on supported hardware | As built |
| Effort to maintain | Low | Medium: everything is a snap | High: HANNAH would own a distribution |
| Good for | Development, robots, a household hub | An unattended gateway that must update itself safely | A product on one board family, later |

The choice per image profile (`hannah-os/images/profiles.json`):

| Profile | Base | Why |
|---|---|---|
| Desktop/Edge | Ubuntu Server 24.04 LTS | Works on the most hardware; easiest to debug |
| Robotics | Ubuntu Server 24.04 LTS | ROS 2 Jazzy's supported platform |
| IoT Gateway | Ubuntu Core 24 | Unattended; transactional updates and rollback come with the base |
| Industrial Edge | Ubuntu Core 24 | As the gateway. A Yocto image is the case for one specific board, when there is one |
| Developer Edition | Ubuntu Server 24.04 LTS | As Desktop/Edge, with build tools and the simulators |

All five carry the same core, byte for byte (a test checks this). Development happens on an ordinary computer: a custom embedded distribution now would make everything slower and prove nothing yet.

Version choices were made on 2026-11-22 from general knowledge of these projects, not from a build. They must be re-checked against the projects' own pages when the first image is built.

## 6. Decisions

**The hub has a control process, one child process per built-in device adapter, and a short-lived discovery worker.** Each adapter owns its device connection; a crash or timeout is reported for that device while the other adapter processes continue. Each discovery request also runs in a child process with a wall-clock limit, so a stuck network browse cannot hold the hub's main tick loop. Both worker types run as the hub's same user with the same permissions; neither is a sandbox. Automation, telemetry and updates still share the control process, and the workers are not separate systemd units. Per-device processes use more memory than the earlier thread model; no resource target has been measured on a production hub.

**The hub opens the connection.** Works behind NAT, leaves no port open, and works with a serverless control plane. Cost: a command waits for the hub's next exchange (two seconds by default). That is fine for a lamp and wrong for anything that needs a fast reaction, which is why reactions are rules on the hub.

**Profiles are data.** A device is described, not programmed. That is what lets a profile be validated, signed, reviewed and proposed from a manual. A device that needs code (a proprietary serial protocol) needs an adapter, and an adapter is HANNAH's code today.

**The standard library only, on the edge.** The hub runs on Python 3.9 or newer with nothing to install. The MQTT and Modbus TCP clients are HANNAH's own implementations of the published standards, kept to the parts a hub needs. The cost is that they are only as proven as their tests: the MQTT client against HANNAH's own test broker and against aedes, an independent broker; the Modbus TCP client against HANNAH's own test server only.

**HMAC between hub and server.** The hub needs no cryptography library. The server holds each hub's key, sealed in the vault. Profiles, which are published by third parties, use Ed25519 signatures instead.

**No unrestricted network scan.** A person can ask the hub to listen to one MQTT broker, browse one local mDNS service type, list serial ports, or read USB device metadata from sysfs. The hub sends no device writes during these looks. Scanning an arbitrary address range is not supported. A device joins an account because someone decided it should.
