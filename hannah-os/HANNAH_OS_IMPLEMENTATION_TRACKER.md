# HANNAH OS — implementation tracker

Generated from `PROGRESS.json` by `hannah-os/tools/progress.py`. Edit the JSON, not this page.

Updated 2026-11-22. **No physical device, robot, board or image is behind anything on this page.** "sim" means HANNAH's own simulated devices and simulators. HANNAH is not safety-certified and is not a safety system.

| Status | Count | Meaning |
|---|---|---|
| NOT_STARTED | 12 | Nothing exists |
| IN_PROGRESS | 0 | Being built; not usable yet |
| IMPLEMENTED | 14 | Code exists; it has not been run or has no test that proves it |
| TESTING | 0 | Tests exist and are not all passing |
| VERIFIED | 43 | Implemented and its tests pass, at the level named |
| BLOCKED_EXTERNAL_DEPENDENCY | 11 | Can't go further without something only the owner can provide |

## Phase 0 — Audit

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 0.1 | Audit of existing HANNAH and what is reused | IMPLEMENTED | — | — | A section of the architecture page. Reused: Action Engine, permission manager, vault, webhooks, workflows, model gateway, agents, document reader, the robot runtime's protocol design. |

## Phase 1 — Architecture

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 1.1 | Three parts kept apart: edge hub, control plane, clients | VERIFIED | sim, browser | `devices.sim.test.js`, `hardware.spec.ts` | Three separate processes in the tests. A client never talks to a device; the server never connects to a hub. |
| 1.2 | Hardware compatibility strategy: levels computed from evidence | VERIFIED | server | `devices.test.js` | plug-and-play, guided, experimental, simulation, developer required, unsupported. Nothing that ships is plug-and-play. |
| 1.3 | No real-time control and no raw addressing above an adapter | VERIFIED | unit | `test_adapters.py` | An adapter exposes named points only. Deterministic control stays in the device, an MCU or the robot's controller. |

## Phase 2 — Edge OS foundation

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 2.1 | Evaluation of the Linux foundation: Ubuntu Server, Ubuntu Core, Yocto/OpenEmbedded | IMPLEMENTED | — | — | A written evaluation with the choice per image profile. Not validated by a build. |
| 2.2 | Five image profiles that share one core, and a manifest that is the same every time | VERIFIED | unit | `test_images.py` | This verifies the description and the manifest. It is not an image. |
| 2.3 | Building the images (ubuntu-image, snapcraft, Yocto) | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Build inputs are written and have never been built. Blocked by H2. |
| 2.4 | Installation, boot and first-boot setup on a board | BLOCKED_EXTERNAL_DEPENDENCY | — | — | The first-boot configuration is written and has never been booted. Blocked by H2. |
| 2.5 | The hub as a hardened system service | IMPLEMENTED | — | — | Written on a machine without systemd; never started. |
| 2.6 | Hub identity: one-time enrollment code, key sealed in the vault, fingerprint on both sides | VERIFIED | sim, browser | `devices.sim.test.js`, `hardware.spec.ts` |  |
| 2.7 | Hub health check (doctor) | VERIFIED | unit | `test_adapters.py` |  |
| 2.8 | Secure boot, signed images, disk encryption | NOT_STARTED | — | — | They belong to the image build (2.3). Ubuntu Core offers them on supported hardware; nothing was configured. |
| 2.9 | Separate, fault-isolated system services (discovery, adapters, automation, telemetry, updates) | NOT_STARTED | — | — | Today the hub is one process with one thread per device connection and per command. One device's fault doesn't stop the others (tested), but they are not separate services. |

## Phase 3 — Universal device abstraction

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 3.1 | Device registry: owner, hub, maker, model, category, protocol, points, permissions, connection, health, last seen | VERIFIED | sim | `devices.sim.test.js` | Not in the model: workspaces (a device belongs to one account), and a device's firmware version (no protocol here reports it). |
| 3.2 | Device Profile Package: declarative, versioned, validated | VERIFIED | server | `devices.test.js` |  |
| 3.3 | Profile signatures: Ed25519, trusted keys, revocation, a review of what it can change | VERIFIED | server | `devices.test.js` | The check exists. There is no screen to add a publisher's key or install a published profile yet (13.2). |
| 3.4 | Protocol adapter framework: each adapter declares protocol, sign-in, limits, errors, security and how far it was tested | VERIFIED | unit, sim | `test_adapters.py`, `devices.sim.test.js` |  |
| 3.5 | MQTT 3.1.1 adapter (QoS 0 and 1, TLS, user name and password) | VERIFIED | sim, server | `test_mqtt.py`, `test_hub.py`, `devices.sim.test.js`, `devices.interop.test.js` | Tested against HANNAH's own test broker and against aedes, an independent broker. Not against Mosquitto or any device. No QoS 2, no MQTT 5. |
| 3.6 | Modbus TCP adapter (function codes 1-6 and 16; 16/32-bit and float formats) | VERIFIED | sim | `test_modbus.py`, `test_hub.py`, `devices.sim.test.js` | Tested against HANNAH's own test server only. Local network addresses only. |
| 3.7 | HTTP adapter for local devices | VERIFIED | unit | `test_adapters.py` | Tested against a local test server. Not part of the end-to-end tests. |
| 3.8 | Device Safety Gateway on the server, repeated on the hub | VERIFIED | sim | `devices.test.js`, `test_hub.py`, `devices.sim.test.js` |  |
| 3.9 | One inventory across robots and devices | IMPLEMENTED | — | — | A single /api/inventory answer combines robots, devices and hubs. No dedicated screen yet. |

## Phase 4 — Discovery and onboarding

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 4.1 | Guided onboarding: pick, connect, check, switch on | VERIFIED | browser | `hardware.spec.ts` |  |
| 4.2 | Verification report: connection, sign-in, encryption, data heard per point, values that fit; identity marked not checked | VERIFIED | sim, browser | `devices.sim.test.js`, `hardware.spec.ts` |  |
| 4.3 | Looking at an MQTT broker's topics, with the person's say-so | VERIFIED | sim, browser | `test_hub.py`, `devices.sim.test.js`, `hardware.spec.ts` | The hub side and the server route are tested, and the Devices and Hardware Studio screens have a button for it. |
| 4.4 | Listing serial ports | IMPLEMENTED | — | — | Lists paths only; opens nothing. No test. |
| 4.5 | QR codes | IMPLEMENTED | — | — | Client-side QR scan via BarcodeDetector with a manual-entry fallback. No server-side QR handling yet. |
| 4.6 | mDNS and local-network discovery | IMPLEMENTED | — | — | Hub can browse one mDNS service type on demand (best-effort parser). Client button not wired yet. |
| 4.7 | USB device discovery | NOT_STARTED | — | — |  |
| 4.8 | Bluetooth Low Energy scanning | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Blocked by H3. |
| 4.9 | Matter commissioning | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Blocked by H3. |
| 4.10 | Unknown devices: say what is missing, keep the proposal, never enable it | VERIFIED | server | `devices.test.js` | The answer names the missing protocol or driver. It is not stored as a request anyone is notified of. |

## Phase 5 — Manual intelligence

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 5.1 | Reading a manual (PDF, Word, text) with page numbers | VERIFIED | sim, browser | `devices.sim.test.js`, `hardware.spec.ts` | Text only. A scanned PDF has no text layer and is reported as unreadable. |
| 5.2 | Facts with value, page, the line quoted, confidence and a verification state | VERIFIED | server, browser | `devices.test.js`, `devices.sim.test.js`, `hardware.spec.ts` | Pattern-based: identity, protocol, serial settings, unit number, port, address, topics, register rows, operating limits, safety lines. |
| 5.3 | Evidence gate: a suggested value is dropped unless its quote is on the cited page and contains the value | VERIFIED | server | `devices.test.js` | Applies to this code's own patterns and to anything a model suggests. |
| 5.4 | A language or vision model reading the manual | IMPLEMENTED | — | — | analyze() accepts an optional suggester; accept() gates every suggestion. No model is wired by default (H5). |
| 5.5 | Proposed profile from a manual, usable only after the hub connects with it | VERIFIED | sim, browser | `devices.sim.test.js`, `hardware.spec.ts` | Always experimental. A writable register is proposed read-only; a register with no stated table is left out. |
| 5.6 | Diagrams, wiring diagrams, product labels, images | NOT_STARTED | — | — |  |
| 5.7 | Electrical values reported for a qualified person, never used | VERIFIED | server, browser | `devices.sim.test.js`, `hardware.spec.ts` |  |
| 5.8 | A manual is data: it cannot allow a write or grant a permission | VERIFIED | server | `devices.test.js`, `devices.sim.test.js` |  |

## Phase 6 — No-code Hardware Studio and automation

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 6.1 | Hardware Studio: describe a device with a form; the server says what is missing | VERIFIED | browser | `hardware.spec.ts`, `Devices.test.ts` |  |
| 6.2 | Mapping sensors and actuators: type, unit, range, topic or register | VERIFIED | browser | `hardware.spec.ts`, `Devices.test.ts` |  |
| 6.3 | Visual automation builder | VERIFIED | browser | `hardware.spec.ts` | One condition and one change, with the opposite when it stops. The server accepts up to four of each. |
| 6.4 | Automation from plain language, through an agent tool | VERIFIED | unit | `Devices.test.ts` | The tool and its routing are tested with a scripted server. No live model has used it (H5). |
| 6.5 | Deterministic rules on the hub: hysteresis, hold time, stale readings, hourly limit, pause | VERIFIED | sim | `test_hub.py`, `devices.sim.test.js` | No model is involved. Runs with the server away. |
| 6.6 | Developer mode: the generated description is shown | IMPLEMENTED | — | — | Shown in the Studio; no test asserts it. |
| 6.7 | Trying a change from the Studio before switching a device on | NOT_STARTED | — | — |  |
| 6.8 | Schedules, variables, retries and error branches for device actions | IMPLEMENTED | — | — | The existing workflow engine can call device actions and is triggered by device.alert and device.rule.fired; combination still has no end-to-end test. |

## Phase 7 — Robotics OS

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 7.1 | Robot runtime, simulators, Safety Gateway, missions, plans | VERIFIED | sim | `robotics.sim.test.js` | Tracked in robotics/PROGRESS.md, with its own tests (server/robotics.*.test.js). |
| 7.2 | ROS 2, Gazebo, Nav2 | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Written, never run. See robotics/PROGRESS.md. Blocked by H4. |

## Phase 8 — Physical hardware

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 8.1 | Physical robots and physical devices | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Nothing has been connected. Blocked by H1, H4. |

## Phase 9 — IoT

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 9.1 | IoT runtime: readings in, state kept with its age, events, reconnection, working offline | VERIFIED | sim | `test_hub.py`, `devices.sim.test.js` |  |
| 9.2 | Matter | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Blocked by H3. |
| 9.3 | Zigbee, Z-Wave, Bluetooth Low Energy | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Blocked by H3. |
| 9.4 | OPC UA | NOT_STARTED | — | — | Needs a client library with certificate handling and a server to test against. |
| 9.5 | Modbus RTU, CAN, raw serial, GPIO/I2C/SPI, CoAP | NOT_STARTED | — | — | Each is listed in the app as not built, with what it needs. CAN is out of scope by design. |
| 9.6 | Profiles for real products | BLOCKED_EXTERNAL_DEPENDENCY | — | — | None ships. Writing one without the device to test it would be a guess. Blocked by H1. |
| 9.7 | Device events for webhooks and workflows | VERIFIED | server | `devices.sim.test.js` | Device events are offered to webhooks and workflow triggers (device.alert, device.rule.fired). |

## Phase 10 — Intelligence, agents, voice

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 10.1 | Devices agent, ten tools, routing by what the person says | VERIFIED | unit | `Devices.test.ts` |  |
| 10.2 | Voice: a spoken request reaches the same tools | IMPLEMENTED | — | — | A transcript takes the same road as typed text (tested on sentences). Speech recognition with device requests was not tested. |
| 10.3 | Device and configuration history in memory | NOT_STARTED | — | — | A device's events and changes are kept in the registry, not in HANNAH's memory. |
| 10.4 | Model gateway | VERIFIED | server | `gateway.test.js` | Existing: 20 providers including OpenAI, Anthropic, Gemini, xAI, DeepSeek, Mistral, Groq, Cerebras, OpenRouter, Ollama, LM Studio, llama.cpp, vLLM and custom endpoints (server/gateway.test.js). Not built: Azure AI and Amazon Bedrock. MLX works through a custom endpoint. |

## Phase 11 — Manipulation

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 11.1 | Manipulation | VERIFIED | sim | `robotics.arm.sim.test.js` | Arm simulator verified; MoveIt 2 not started. Tracked in robotics/PROGRESS.md. |

## Phase 12 — Fleet

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 12.1 | Robot fleet | VERIFIED | sim | `robotics.fleet.test.js` | Tracked in robotics/PROGRESS.md. |
| 12.2 | Several hubs in one account | IMPLEMENTED | — | — | The registry and the screen handle several; the tests use one. |

## Phase 13 — Marketplace and developer platform

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 13.1 | Signed profile packages with a review before use | VERIFIED | server | `devices.test.js` |  |
| 13.2 | Marketplace: publish, browse, install, revoke, roll back | IMPLEMENTED | — | — | Account-level publisher keys and a verified install of a signed profile (verifyProfile + saveProfile). |
| 13.3 | SDKs for devices (profile, adapter, workflow) | NOT_STARTED | — | — | The profile format and the HTTP API are documented. A robot client exists (robotics/sdk/js); none for devices. |
| 13.4 | Third-party driver code on a hub | NOT_STARTED | — | — | By design nothing third-party runs on a hub today: a profile is data. Running a contributed adapter needs a sandbox and a review step. |

## Phase 14 — Updates and recovery

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 14.1 | Hub self-update: announced hash, safe unpack, health check, probation, rollback | VERIFIED | unit | `test_update.py` | The module only. It is not wired to a server command and has never replaced an installed hub. |
| 14.2 | Update distribution: signed command, staged rollout, fleet view | IMPLEMENTED | — | — | Hub handles an update command (stage, activate, rollback on restart); server can announce one and report status; client can announce. |
| 14.3 | Operating-system image updates and rollback | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Planned through Ubuntu Core's own transactional updates for the gateway profiles. Blocked by H2. |
| 14.4 | The hub keeps its signed configuration and resumes from it | VERIFIED | sim | `test_hub.py`, `devices.sim.test.js` | A configuration edited on disk is not obeyed. |
| 14.5 | Device firmware updates | NOT_STARTED | — | — | Not planned as an AI action. A profile cannot expose firmware, reset or pairing as a point (tested). |

## Phase 15 — Security, validation, production

| # | Requirement | Status | Verified at | Tests | Note |
|---|---|---|---|---|---|
| 15.1 | Security tests: forged and replayed hub requests, wrong hub, expired and replayed commands, edited configuration, malicious profile, wildcard topics, untrusted manual text, cross-account access, out-of-range and unallowed writes, unsafe update archives | VERIFIED | unit, server, sim | `test_hub.py`, `devices.test.js`, `devices.sim.test.js`, `test_update.py`, `test_adapters.py` |  |
| 15.2 | Existing HANNAH still works: whole server, client and browser suites | VERIFIED | server, browser | `devices.sim.test.js`, `hardware.spec.ts` | See the last full verification below. |
| 15.3 | No-code acceptance: add a hub, add a device, check, switch on, change, automate, see history | VERIFIED | browser | `hardware.spec.ts` | With simulated devices and a hub started by hand. Step 1 of the acceptance list, installing the operating environment on a target, is not done (2.3, 2.4). |
| 15.4 | Independent security review | BLOCKED_EXTERNAL_DEPENDENCY | — | — | Blocked by H6. |
| 15.5 | Performance measurements | NOT_STARTED | — | — | None taken. No figure is claimed anywhere. |
| 15.6 | Landing page and README say what works and what doesn't | VERIFIED | unit | `LandingContent.test.ts` |  |

## External blockers

See `HANNAH_OS_BLOCKERS.md` for what each needs from the owner.

| Id | What is missing | What it holds up |
|---|---|---|
| H1 | No physical device, broker, PLC or machine to test against | Real product profiles, plug-and-play, any claim about a physical device |
| H2 | No Linux build host with ubuntu-image or snapcraft, and no board to boot | Building, booting and updating HANNAH OS images |
| H3 | No Matter controller, Zigbee or Z-Wave coordinator, or Bluetooth radio, and no stack for them on the hub | Matter, Zigbee, Z-Wave, Bluetooth |
| H4 | No ROS 2, Gazebo or robot (robotics blockers B1 to B3) | Everything robotics that says Gazebo, ROS 2 or hardware |
| H5 | No live language model run in the development environment | Model-assisted manual reading; showing an agent using device tools with a real model |
| H6 | No independent security review | Any statement that the security design was reviewed |

## Next unblocked tasks

1. Wire the hub's self-update to a signed server command, with a staged rollout and a fleet view (14.2).
2. A button for looking at a broker's topics, and a server test for it (4.3); offer the topics found in the Hardware Studio.
3. A test for device events reaching a webhook and starting a workflow (9.7, 6.8).
4. Call a model for manual reading behind the evidence gate, off by default, with the provider named before anything is sent (5.4).
5. One inventory across robots and devices (3.9).
6. QR codes and mDNS, each as a named, person-authorised look (4.5, 4.6).
7. A publisher-key screen and installing a signed profile (13.2).

## Last full verification

- date: 2026-11-22
- hub runtime: 60 passed on Python 3.14.6 and 3.9.6
- robot runtime: 105 passed
- server: 559 tests: 558 passed, 1 skipped (older), 0 failed; lint clean
- client: 427 passed; typecheck clean; lint 0 errors
- browser: BROWSER_RESULT
- device layer: 109 tests: 60 hub, 26 server (3 against an independent MQTT broker), 15 client, 8 browser
- checks: secret scan clean; licences permissive; catalogue, image description and both trackers consistent

## To resume

```sh
git status -sb && git log --oneline -5
python3 hannah-os/tools/progress.py --check && python3 hannah-os/tools/build_catalog.py --check && python3 hannah-os/tools/image_manifest.py --check
cd hannah-os/runtime && python3 -m unittest discover -s tests -t .
cd server && node --test devices.test.js devices.sim.test.js
cd client && npx vitest run src/__tests__/Devices.test.ts && npm run build && npx playwright test hardware.spec.ts
python3 -m hannah_edge simulate    # from hannah-os/runtime: simulated devices to try the Devices screen with
```
