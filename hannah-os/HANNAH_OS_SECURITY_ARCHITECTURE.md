# HANNAH OS — security architecture

How HANNAH keeps a model, a stranger, a faulty device or a bad document from changing something in the physical world. It has **not been reviewed by anyone independent** (blocker H6). HANNAH is not safety-certified and is not a safety system.

## Who trusts whom

| Boundary | What crosses it | How it is protected |
|---|---|---|
| Person → server | Sign-in, approvals, device settings | The account's session. Adding, changing or removing a hub or a device, switching a device on and choosing what may be changed need a signed-in person; a developer key can't do them |
| Model → Action Engine | A tool call: a device name, a point id, a value | The permission level, the Device Safety Gateway, and approval. A model has no other road to a device |
| Server → hub | Configuration and commands | Each is signed with a key derived from the hub's secret. A command names the hub, has a sequence number that only goes up, and expires in 20 seconds |
| Hub → server | Reports and results | Each request is signed over hub id, time, a counter that must increase, method, path and the body's hash |
| Hub → device | The device's own protocol | Whatever the protocol has: TLS and a password for MQTT when the broker offers them; nothing for Modbus |
| Device → hub | Readings | Data only. A value that isn't the point's type, or is far outside its range, is dropped and counted |
| Document → server | A manual | Data only. See "Untrusted input" |

## A hub's identity

1. A signed-in person creates the hub and gets a one-time code (8 characters, 15 minutes, stored as a hash).
2. The hub sends the code. The server answers once with a 256-bit secret and stores it sealed in the key vault (`server/vault.js`). The code can't be used again.
3. Both sides show a fingerprint of the key, so a person can check which computer enrolled.
4. Three keys are derived from the secret: one signs the hub's requests, one verifies commands, one verifies the configuration.
5. On the hub the key file is readable only by its user (mode 600); `doctor` fails if it isn't.
6. Revoking a hub deletes its key on the server: its next request is refused. Rules already on it keep running until it is switched off, and the screen says so.

The trade-off: with HMAC the server holds each hub's key, so a server compromise can command hubs within what each device's allow-list permits. Public-key signatures would remove that; they need a cryptography library on the hub, which the hub avoids today.

## What the hub holds by itself

Whatever the server sends, the hub (`hannah-os/runtime/hannah_edge/hub.py`):

- ignores a configuration or command whose signature is wrong, that names another hub, or (for configuration) is older than the one it has;
- runs a command once, in order, before it expires; the last sequence number is kept on disk, so a restart doesn't reopen the window;
- writes only to a point on that device's allow-list, with a value of the point's type inside its range, at most once a second per point;
- does not obey a configuration file that was edited on disk: the saved copy is verified like a fresh one;
- has no method that takes a topic, a register or a URL from a command.

## The Device Safety Gateway

`server/devices/safety.js`. A change is refused, with the reason and before anyone is asked to approve it, when the device isn't switched on, its hub is away, the device isn't reporting, the point doesn't exist or is read-only, a person hasn't allowed it, or the value doesn't fit. It then decides who is asked: an elevated or high-risk point asks every time, whatever the permission level. When a hub is away **nothing is queued**: a change never happens later.

## Untrusted input

| Input | Rule |
|---|---|
| A model's output | A tool call with a device name, a point id and a value. Checked like any other request |
| A manual | Read as text. A value is shown only with the page and the line it came from, and only if that line is in the document and contains the value. Whatever a manual says, the proposal has no writable point and one fixed permission; it is "experimental"; a person still has to check it, and the hub still has to reach the device |
| Voltage, current, wiring | Reported for a qualified person to check against the device's rating plate. Never used |
| A device's messages | Typed and range-checked on the hub, typed again on the server |
| A profile | Validated field by field. It can't expose firmware, resets, passwords or pairing; can't write to a number without a range; can't use a wildcard topic; can't put a secret into a topic |
| Settings a person enters | Checked against the profile. A value that goes into a topic or a path may contain only letters, digits and `. _ - : /` |
| A published profile | Ed25519 signature against keys the person trusts; a revoked key is refused; the review lists what it can change and at what risk |
| An update bundle | Must match the announced size and SHA-256, unpack to ordinary files inside its own folder, be the version it says, and pass a health check; then it is on probation with a way back |

## Network

- A hub listens on no port. The first-boot configuration denies all incoming connections.
- The hub talks to HANNAH over HTTPS. Plain HTTP is accepted only to the same computer, or with an explicit flag on a closed development network.
- MQTT and HTTP without encryption are accepted only to an address on the local network. Modbus TCP is accepted only to an address on the local network, with no flag to allow another.
- A hub does not scan a network. It looks at one broker's topics, or lists serial ports, when a signed-in person asks.

## Privacy

- Readings are kept for 24 hours (a value is stored when it changes, and at least once a minute); events for 30 days.
- A device's passwords are sealed in the vault and are sent only to that device's hub, inside the signed configuration, over TLS.
- A manual is read on the server and not stored. Only the values found, with their quotes, are kept beside a profile the person chose to keep.
- No reading, manual or device detail is sent to a model provider by the device layer. A model sees device data only when a person asks it something and a tool returns the answer. No model is called to read a manual.
- There is no camera support for devices. Robot cameras have their own rules (`docs/robotics/SENSORS_AND_PERCEPTION.md`).

## Not done

- An independent review.
- Secure boot, signed images and disk encryption: they belong to an image that hasn't been built.
- Per-device built-in adapters and read-only discovery have process boundaries, but run as the same user with the same permissions and are not sandboxes. Automation, telemetry and updates remain in the main process, and no worker has its own systemd unit. Nothing third-party runs on a hub today.
- Per-publisher key management in the app.
- Key rotation for a hub other than enrolling it again with a new code.
- Rate limits per account on device changes beyond the Action Engine's and the hub's one write a second per point.
