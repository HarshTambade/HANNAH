# HANNAH OS — test report

What was tested, at which level, and what was not. Tests were run on 2026-11-22 and 2026-11-23 on macOS (arm64), each suite by itself.

**Every test here uses HANNAH's own simulated devices or test servers.** No physical device, robot, board or image was involved. A level is named for every test file, and no test is counted at a higher level than it ran at.

| Level | Meaning |
|---|---|
| Unit | One module, no network beyond the same computer |
| Loopback | A protocol client against a test server over real sockets on the same computer |
| Interoperability | HANNAH's client against software HANNAH didn't write |
| Simulation | The real server, the real hub and simulated devices, as separate processes |
| Browser | The same three, driven through the app in a real browser |
| Hardware | A physical device. **Nothing has been tested at this level** |

## Latest full verification

Full application suites and targeted HANNAH OS checks run on 2026-11-22 and 2026-11-23 on macOS (arm64):

| Check | Result |
|---|---|
| Full hub runtime suite | 87 passed on Python 3.14.6, including MQTT, Modbus, per-device adapter worker isolation and crash containment, isolated temporary probes, hub simulation, image descriptions, updates, discovery worker isolation and benchmark statistics. Python 3.9.6 was not rerun. |
| Full server suite (`npm test`) | 570 passed, 1 skipped, 0 failed. The skip is the live Supabase TLS test, which requires `HANNAH_LIVE_TESTS=1` and network credentials. |
| Device server unit, SDK and simulator suites | 34 passed; the complete 19-test simulator file passed after discovery, per-device adapters and temporary probes moved to worker processes. Coverage includes staged rollouts, cross-account hardware inventory, signed device-alert webhook delivery, scheduled hardware action retries with one Action Engine record, approval/readback, a permanent-error branch, image source evidence, SDK workflow/profile helpers and profile preflight. |
| Full client suite (`npm test`) | 433 Vitest tests and 43 desktop-tool tests passed. |
| Client production build | Passed. Existing dependency, chunk-size and mixed-import warnings remain. |
| Full Playwright suite (`npm run test:e2e`) | 120 passed on the last full run. After the Hardware Studio dry-run preview change, its hub-enrollment and Studio regression pair passed (2 tests); the Studio asserts that preview sends no device/action request. |
| Device performance baseline | 100 simulated write/readback cycles per protocol; measured on the development host only. Values and host metadata are in `hannah-os/PERFORMANCE_BASELINE.json`. |
| Static checks | Server ESLint, changed client ESLint, TypeScript production build, diff, catalogue, image description and tracker checks passed. The client ESLint config excludes E2E files; Playwright compiled and ran them. |

These tests use HANNAH's own simulated devices and test servers. They do not establish compatibility with a physical mDNS service, USB device or hardware product, or a production hub image or installed service.

## The device layer

| Suite | Level | Tests | What it shows |
|---|---|---|---|
| `hannah-os/runtime/tests/test_mqtt.py` | Unit, loopback | 13 | MQTT 3.1.1 packets byte for byte; splitting across reads; the client against HANNAH's test broker: retained messages, QoS 1, a wrong password named, an unreachable broker, a port that isn't MQTT, a public address refused without TLS, a dropped connection, keep-alive |
| `hannah-os/runtime/tests/test_modbus.py` | Unit, loopback | 8 | Modbus TCP frames; number formats in both word orders; every table read; writes read back; exception answers named; a device that goes away; a public address refused; a wrong unit number |
| `hannah-os/runtime/tests/test_adapters.py` | Unit, loopback | 9 | Every adapter's declaration is complete; no adapter can address anything but a listed point; value checks; values that don't fit are rejected, not coerced; the HTTP adapter (read, write, sign-in, redirects not followed, oversize and non-JSON answers); `doctor` |
| `hannah-os/runtime/tests/test_hub.py` | Simulation | 37 | Each device gets a separate adapter child process; a crashed worker is reported while another device stays online; the hub with simulated devices on MQTT and Modbus TCP; signed command and configuration checks including update commands; device probes; named MQTT and mDNS discovery; a DNS-SD response fixture joining service instance, port and host address; serial and read-only USB listing; USB IDs separate from product labels; local-only service-type validation; offline behavior; deterministic automations and write confirmation |
| `hannah-os/runtime/tests/test_images.py` | Unit | 5 | The image description is consistent; all five profiles carry the same hub byte for byte; a manifest is the same every time; a board can't be listed without a boot record; no image file carries a secret or opens a port |
| `hannah-os/runtime/tests/test_update.py` | Unit | 10 | The hub's self-update with real archives: installed-package bootstrap and link repair; a good update; a bundle that isn't the one announced; an archive that reaches outside its folder; an older version; a failed package import; link-switch recovery; rollback on the fourth start without confirmation; pruning |
| `hannah-os/runtime/tests/test_benchmark.py` | Unit | 2 | Nearest-rank percentile and summary calculations; benchmark statistics are descriptive and define no performance pass/fail threshold |
| `hannah-os/runtime/tests/test_discovery.py` | Unit | 3 | USB discovery runs in a separate process; invalid requests fail closed; a timed-out worker is reported while the hub tick continues |
| `server/devices.test.js` | Unit | 13 | Profile validation and what a profile can't do; compatibility levels from evidence; nothing leaks a binding to the app; settings checks; profile signatures and revocation; the Device Safety Gateway; who is asked by risk; what an automation may contain; the evidence gate for manual facts; image source intake without invented OCR facts; a manual's text can't change permissions; what is said when a manual's protocol isn't built |
| `server/devices.interop.test.js` | Interoperability | 3 | HANNAH's MQTT client and its MQTT device adapter against aedes, an independent broker: sign-in and its refusal, subscribe, retained, QoS 1 both ways, keep-alive, write and read-back |
| `server/devices.sim.test.js` | Simulation | 19 | Three processes. Enrollment; side-effect-free profile SDK preflight; MQTT topic discovery; read-only USB discovery; rejection of arbitrary network scans and non-local mDNS service types; device connection, approval, write confirmation and automations; signed alert delivery to a webhook and enabled event workflow whose hardware action waits for approval and confirms hub readback; a scheduled hardware action carries trigger fields, retries the same Action Engine record after a lost response, confirms hub readback after approval, and routes a permanent refusal through an error branch; manual evidence; account isolation and hub authentication |
| `server/devices-sdk.test.js` | Unit / server | 2 | Device SDK workflow builders pass the real workflow validator; adapter manifests are declarative and reject executable fields or unbounded writable numbers; client preflight and device writes use their server API routes |
| `client/src/__tests__/Devices.test.ts` | Unit | 20 | Device tools and agent routing; Action Engine approvals and outcomes; Hardware Studio range and adapter preview; inventory calls; device lifecycle changes saved to user-owned memory without making a device operation fail |
| `client/src/__tests__/LandingContent.test.ts` (devices) | Unit | 1 | The site names only protocols the hub has, and keeps saying no physical device was tested |
| `e2e/hardware.spec.ts` | Browser | 8 | Without an account; ten sections fit the header and the phone tab bar; a hub added and enrolled; account-wide inventory; QR handling that never opens a URL; a device from the list; a switch with approval; an ignored write; an automation built without code; an image source preview and PDF manual evidence; the Hardware Studio and the server's objections; the hub going away |

## Simulation performance baseline

Measured 2026-11-22 on macOS 27.0.1 arm64, Python 3.14.6, 8 logical CPUs. Each protocol ran five unrecorded warmups followed by 100 cycles toggling one simulated boolean output and waiting for the adapter's matching readback over loopback TCP:

| Adapter | Simulator | Median | p95 | Range | Mean throughput |
|---|---|---:|---:|---:|---:|
| MQTT | HANNAH Broker + simulated fan | 1.594 ms | 1.643 ms | 0.199–1.717 ms | 802.42 cycles/s |
| Modbus TCP | HANNAH ModbusMeter | 0.227 ms | 0.299 ms | 0.196–0.321 ms | 4,169.74 cycles/s |

The child process startup times were 58.976 ms for MQTT and 84.832 ms for Modbus TCP. Per-operation timings include the private adapter-worker IPC round trip; controller CPU excludes child-worker CPU. These numbers measure the adapters and HANNAH's own simulator on one development host. They are not comparisons between protocols and do not measure physical devices, production hubs, the server, network transport, Action Engine assessment or approval time. The benchmark has no pass/fail target and makes no performance guarantee.

The latest full runtime run passed 87 tests. The latest full server run covers 10 hub update unit tests, 13 server device unit tests, 19 device simulator tests, 2 SDK tests and the three independent broker interoperability tests. The 19 device simulator tests passed after discovery, configured adapters and temporary probes moved to worker processes. Client coverage is 20 Devices unit tests; the full browser suite last passed 120 tests, with the two tests covering the latest Studio change rerun separately.

## Earlier whole-project baseline

The following full-project results were recorded before the latest mDNS and USB changes. They are useful as a baseline, but do not verify the entire repository after those edits.

| Check | Result |
|---|---|
| Hub runtime (`hannah-os/runtime`) | 60 passed, on Python 3.14.6 and 3.9.6 |
| Robot runtime (`robotics/runtime`) | 105 passed |
| Server tests (`npm test` in `server`) | 559 tests: 558 passed, 1 skipped (an older skip), 0 failed |
| Client tests (`vitest` in `client`) | 427 passed |
| Browser suite (`npm run test:e2e` in `client`) | Not recorded in that run; one targeted browser test passed in the latest focused verification above |
| Client typecheck, client lint, server lint | Clean (3 older lint warnings) |
| Secret scan | No findings |
| Licence check | 424 production dependencies, all permissive. One test-only dependency was added to the server: aedes 1.2.0 (MIT) |
| Catalogue, image description, both trackers | Consistent (`--check`) |

## What these tests do not show

- That any real device works. The simulated room sensor, fan, lamp and power meter are a few dozen lines each.
- That the Modbus TCP client works with a device or simulator HANNAH didn't write.
- That the MQTT client works with Mosquitto, a cloud broker, TLS, or MQTT 5.
- That a model can use the device tools. The tools were driven by tests, not by a model.
- That a manual in the wild is read well. Text extraction was tried on manuals written for the tests. Uploaded PNG, JPEG, GIF and WebP images are shown as source evidence only: no OCR or vision interpretation is configured or tested.
- That an image builds or boots, that the service unit starts, or that the snap builds.
- That a production systemd service or edge image updates correctly on installed hardware.
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
