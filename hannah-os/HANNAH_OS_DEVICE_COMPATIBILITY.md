# HANNAH OS — device compatibility

What HANNAH can reach today, how sure anyone can be about a given device, and how a device is described.

**Today: no physical device has been tested, and no profile for a real product ships.** HANNAH does not promise that a device works because it has a manual, a QR code or a familiar protocol.

## Compatibility levels

Every profile is shown with one of these. The level is computed from evidence in the profile (`server/devices/profiles.js`, `compatibility()`); a profile cannot declare its own.

| Level | What it means | How a profile gets it |
|---|---|---|
| **Plug and play** | Tested on the device itself and published by someone you trust | Tests at "physical" or "hardware-in-the-loop" level, all passing, with evidence, **and** a valid signature from a key you trust. **Nothing has this level today** |
| **Guided setup** | You described the device yourself | Built in the Hardware Studio. HANNAH checks the connection and what it hears, not whether your description is right |
| **Experimental** | Written from documentation; not tested on the device | A profile proposed from a manual, or a published one without hardware tests or without a trusted signature. Passing the hub's check does not raise it |
| **Simulation** | A simulated device | The four profiles that ship. They prove nothing about any product |
| **Developer required** | The hub can't speak this protocol yet | The profile names a protocol in the "not built" list, or one the chosen hub's software lacks |
| **Unsupported** | HANNAH doesn't know the protocol, or the profile says it can't be integrated safely | |

## Protocols

| Protocol | State | Tested against | Notes |
|---|---|---|---|
| **MQTT 3.1.1** | Available | HANNAH's own test broker, and aedes (a broker HANNAH didn't write) | QoS 0 and 1, TLS, user name and password. No QoS 2, no MQTT 5, no client certificates. Unencrypted only to a broker on the local network |
| **Modbus TCP** | Available | HANNAH's own test server | Function codes 1 to 6 and 16; 16- and 32-bit integers and 32-bit floats in either word order. Local network addresses only: the protocol has no sign-in and no encryption |
| **HTTP on the local network** | Available | A local test server | JSON answers, optional Basic sign-in. Redirects are not followed |
| Matter | Not built | | Needs a controller stack and a radio on the hub |
| Zigbee, Z-Wave | Not built | | Need a coordinator radio and its driver. A device behind a bridge that publishes to MQTT can be added as an MQTT device |
| Bluetooth Low Energy | Not built | | Needs a radio and a library |
| OPC UA | Not built | | Needs a client library with certificate handling, and a server to test against |
| Modbus RTU, raw serial, USB device control, GPIO/I2C/SPI, CoAP | Not built | | USB discovery only lists metadata from sysfs; it does not open a USB device or provide a USB protocol adapter. Each protocol needs a driver or library on the hub |
| CAN | Out of scope | | Belongs under a machine's own controller |
| ROS 2 | Robots only | | See `docs/robotics` |

Each adapter declares what it is (`hannah-os/runtime/hannah_edge/adapters/*.py`, `ABOUT`): protocol and version, sign-in, encryption, what it reads and writes, limits, errors, security notes, diagnostics, how far it was tested and what it doesn't support. The hub sends this when it enrolls.

## Profiles that ship

| Profile | Protocol | Points | Level |
|---|---|---|---|
| Simulated room sensor | MQTT | temperature, humidity, light level (read) | Simulation |
| Simulated fan | MQTT | power (read and change) | Simulation |
| Simulated dimmable lamp | MQTT | power, brightness 0 to 100 % (read and change) | Simulation |
| Simulated power meter with relay | Modbus TCP | voltage, power (read); power limit, load relay (read and change, elevated risk) | Simulation |

Source: `hannah-os/profiles/*.json`. The server ships a generated copy (`server/devices/catalog.json`); a test fails when the copy is out of date.

## What the hub's check means

Before a device can be switched on, its hub connects and listens. The report (`verificationFrom()` in `server/devices/service.js`) says, per check: passed, failed, a note, or **not checked**.

| Check | What is tested | What is not |
|---|---|---|
| Connection, sign-in | The hub reached the broker or device and was let in | |
| Encryption | Whether the link is encrypted | An unencrypted local link is a note, not a failure |
| Maker and model | **Not checked.** These protocols give no way to confirm what a device is | Two devices that answer the same way can't be told apart |
| Each reading | A value of the right type arrived within eight seconds | That the value is correct |
| Values fit | Messages that didn't fit the type or range were dropped and counted | |
| Changing things | **Not checked.** Nothing is written during the check | The first change a person approves is read back |

"Verified" means every expected reading was heard. "Partial" means the connection worked and some readings were not heard; a person can still switch it on, and that choice is recorded.

## The device profile format

A profile is one JSON object (format 1). Validation: `validateProfile()`.

| Field | Meaning |
|---|---|
| `id`, `version` | A reverse-domain id and an exact version. Your own profiles start with `user.` |
| `name`, `author`, `manufacturer`, `model`, `revisions` | Who and what |
| `category`, `domain` | What kind of device; `iot`, `industrial` or `embedded` |
| `protocol.adapter` | `mqtt`, `modbus-tcp`, `http`, or a protocol from the not-built list |
| `connection.instructions` | Plain sentences: how to connect the device |
| `connection.fields` | The settings a person enters (text, number, secret, toggle, choice) |
| `points` | What can be read or changed. Each: `id`, `name`, `kind` (sensor or actuator), `type` (boolean, number, enum, text), `unit`, `range`, `step`, `access` (read or read-write), `risk`, and a `binding` |
| `binding` | Used only by the hub. MQTT: a state topic (with an optional JSON field) and a command topic. Modbus: table, address, number format, scale. HTTP: a path and a JSON field; a command request |
| `availability` | MQTT: the topic on which the device says it is online or offline |
| `constraints` | Safety restrictions, in sentences. Required for locks, actuators, controllers and industrial equipment |
| `permissions`, `dependencies` | What the hub needs to reach it |
| `tests` | Level (unit, simulation, hardware-in-the-loop, physical), passed, total, evidence |
| `signature` | Ed25519 over the rest, by the publisher |

What a profile cannot do: make a number writable without a range; expose firmware, a reset, a password or pairing as a point; use a wildcard topic; claim hardware tests for a simulated device.

## Risk

| Risk | Which points | Effect |
|---|---|---|
| Low | A lamp, a plug, a fan | Follows the account's permission level |
| Elevated | Anything industrial; points a profile marks | Asks every time. An automation that changes one says so when you approve it |
| High | Locks, actuators, controllers | Asks every time. No automation may change it |

A profile can raise a point's risk; the device's category can raise it further; nothing lowers it.
