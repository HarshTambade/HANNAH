# HANNAH OS — test report

What was tested, at which level, and what was not. Run on 2026-11-22 on macOS (arm64), each suite by itself.

**Every test here uses HANNAH's own simulated devices or test servers.** No physical device, robot, board or image was involved. A level is named for every test file, and no test is counted at a higher level than it ran at.

| Level | Meaning |
|---|---|
| Unit | One module, no network beyond the same computer |
| Loopback | A protocol client against a test server over real sockets on the same computer |
| Interoperability | HANNAH's client against software HANNAH didn't write |
| Simulation | The real server, the real hub and simulated devices, as separate processes |
| Browser | The same three, driven through the app in a real browser |
| Hardware | A physical device. **Nothing has been tested at this level** |

## The device layer

| Suite | Level | Tests | What it shows |
|---|---|---|---|
| `hannah-os/runtime/tests/test_mqtt.py` | Unit, loopback | 13 | MQTT 3.1.1 packets byte for byte; splitting across reads; the client against HANNAH's test broker: retained messages, QoS 1, a wrong password named, an unreachable broker, a port that isn't MQTT, a public address refused without TLS, a dropped connection, keep-alive |
| `hannah-os/runtime/tests/test_modbus.py` | Unit, loopback | 8 | Modbus TCP frames; number formats in both word orders; every table read; writes read back; exception answers named; a device that goes away; a public address refused; a wrong unit number |
| `hannah-os/runtime/tests/test_adapters.py` | Unit, loopback | 9 | Every adapter's declaration is complete; no adapter can address anything but a listed point; value checks; values that don't fit are rejected, not coerced; the HTTP adapter (read, write, sign-in, redirects not followed, oversize and non-JSON answers); `doctor` |
| `hannah-os/runtime/tests/test_hub.py` | Simulation | 18 | The hub with simulated devices on MQTT and Modbus TCP: typed readings with their time; bad values dropped and counted; a device that says it is offline; a broker that is away; an unknown adapter refused; a write done only when the device reports it; an ignored write is "unverified"; what the hub refuses; commands checked for signature, hub, expiry, order, and run once; the guard after a restart; a forged, older or hand-edited configuration ignored; a probe; looking at a broker without publishing; rules acting both ways with no server; stale readings; unallowed writes from a rule; paused automations; an hourly limit; an unconfirmed rule write |
| `hannah-os/runtime/tests/test_images.py` | Unit | 5 | The image description is consistent; all five profiles carry the same hub byte for byte; a manifest is the same every time; a board can't be listed without a boot record; no image file carries a secret or opens a port |
| `hannah-os/runtime/tests/test_update.py` | Unit | 7 | The hub's self-update with real archives: a good update; a bundle that isn't the one announced; an archive that reaches outside its folder; an older version; a failed health check; rollback after three unconfirmed restarts; pruning |
| `server/devices.test.js` | Unit | 12 | Profile validation and what a profile can't do; compatibility levels from evidence; nothing leaks a binding to the app; settings checks; profile signatures and revocation; the Device Safety Gateway; who is asked by risk; what an automation may contain; the evidence gate for manual facts; a manual's text can't change permissions; what is said when a manual's protocol isn't built |
| `server/devices.interop.test.js` | Interoperability | 3 | HANNAH's MQTT client and its MQTT device adapter against aedes, an independent broker: sign-in and its refusal, subscribe, retained, QoS 1 both ways, keep-alive, write and read-back |
| `server/devices.sim.test.js` | Simulation | 11 | Three processes. Enrollment and the fingerprint; the catalogue and the not-built list; add, check and switch on a device; a device that can't be reached; a switch that asks first and is done on read-back; what the gateway refuses; an ignored write is not called done; an automation approved once and run by the hub, paused and resumed, and paused by the emergency stop; a PDF manual read into facts and a proposal that the hub then proves against the simulated meter; another account sees nothing; forged and replayed hub requests; the hub away, back, and revoked |
| `client/src/__tests__/Devices.test.ts` | Unit | 14 | Tools offered only with a device switched on; the Devices agent; schemas carry no address; a change goes through the Action Engine and waits for the person; declined, unconfirmed and refused outcomes reach the model as they are; what a person says brings the right tools; the Hardware Studio's output |
| `client/src/__tests__/LandingContent.test.ts` (devices) | Unit | 1 | The site names only protocols the hub has, and keeps saying no physical device was tested |
| `e2e/hardware.spec.ts` | Browser | 8 | Without an account; ten sections fit the header and the phone tab bar; a hub added and enrolled; a device from the list; a switch with approval; an ignored write; an automation built without code; a manual read and its proposal connected; the Hardware Studio and the server's objections; the hub going away |

**109 tests** for the device layer: 60 on the hub (run on Python 3.9.6 and 3.14.6), 26 on the server, 15 in the client and 8 in a browser.

## The whole project, on the final code

| Check | Result |
|---|---|
| Hub runtime (`hannah-os/runtime`) | 60 passed, on Python 3.14.6 and 3.9.6 |
| Robot runtime (`robotics/runtime`) | 105 passed |
| Server tests (`npm test` in `server`) | 559 tests: 558 passed, 1 skipped (an older skip), 0 failed |
| Client tests (`vitest` in `client`) | 427 passed |
| Browser suite (`npm run test:e2e` in `client`), whole, on the final build | BROWSER_RESULT |
| Client typecheck, client lint, server lint | Clean (3 older lint warnings) |
| Secret scan | No findings |
| Licence check | 424 production dependencies, all permissive. One test-only dependency was added to the server: aedes 1.2.0 (MIT) |
| Catalogue, image description, both trackers | Consistent (`--check`) |

## What these tests do not show

- That any real device works. The simulated room sensor, fan, lamp and power meter are a few dozen lines each.
- That the Modbus TCP client works with a device or simulator HANNAH didn't write.
- That the MQTT client works with Mosquitto, a cloud broker, TLS, or MQTT 5.
- That a model can use the device tools. The tools were driven by tests, not by a model.
- That a manual in the wild is read well. The reader was tried on manuals written for the tests, in clean text.
- That an image builds or boots, that the service unit starts, or that the snap builds.
- That the hub's self-update works on an installed hub.
- How fast anything is. No measurement was taken, and no figure is claimed.
- That the phone and desktop apps show the Devices screen correctly. It was tested in a desktop browser at several widths and at a phone's width.

## Security tests, by what they try

| Attempt | Where it is tested | Outcome |
|---|---|---|
| A hub request with a wrong signature; a replayed one | `devices.sim.test.js` | 401; `replayed` |
| A command for another hub, expired, out of order, delivered twice | `test_hub.py` | Refused or run once |
| A configuration with a wrong signature, for another hub, older, or edited on disk | `test_hub.py` | Ignored |
| A write to a read-only, unlisted or unallowed point; out of range; off its step; wrong type; a topic instead of a point | `test_hub.py`, `devices.test.js`, `devices.sim.test.js` | Refused with the reason, on both sides |
| A device sending text where a number belongs, or a value far out of range | `test_hub.py`, `test_adapters.py` | Dropped and counted |
| A device redirecting the hub, or answering with a huge body | `test_adapters.py` | Not followed; dropped |
| A profile exposing firmware or a reset, using a wildcard topic, putting a secret in a topic, a writable number without a range | `devices.test.js` | Invalid |
| A profile changed after signing; signed with an unknown or revoked key | `devices.test.js` | Not trusted |
| A manual telling HANNAH to make everything writable and grant itself access | `devices.test.js`, `devices.sim.test.js` | No writable point, one fixed permission |
| A model's suggested value with an invented quote, or a value not in its quote | `devices.test.js` | Dropped |
| Another account reading or changing a device | `devices.sim.test.js` | 404 |
| Plain MQTT, HTTP or Modbus to a public address | `test_mqtt.py`, `test_modbus.py`, `test_adapters.py` | Refused before any packet |
| An update archive with `..`, an absolute path, a link or a device node; a wrong hash; a version that lies | `test_update.py` | Refused; nothing written |
| An automation writing to a high-risk or unallowed point | `devices.test.js`, `test_hub.py` | Refused when created. An unallowed write is refused again by the hub |
