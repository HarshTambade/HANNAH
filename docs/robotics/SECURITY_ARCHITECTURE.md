# Robotics security architecture

How a robot is identified, how it joins an account, how commands are protected, and what is designed but not built. Code: `server/robotics/service.js`, `server/robotics/router.js`, runtime `protocol.py` and `link.py`.

## 1. What is protected against

| Threat | Answer |
|---|---|
| A stranger on the internet controls a robot | No robot listens for connections. Commands exist only in the answer to a robot's own signed request, and only an account's own actions create them |
| A stranger enrolls a rogue device as someone's robot | Enrollment needs a one-time code that a signed-in person created; 15 minutes, one use, stored as a hash, attempts limited per network address |
| Someone who can read network traffic replays a command | Each command has a sequence number that only goes up, a nonce, and an expiry in seconds; the robot keeps the last sequence on disk |
| Someone alters a command in transit | HMAC-SHA256 over the exact text; any change fails |
| Someone replays a robot's request to the server | Each request is signed over a counter that must increase and a time within one minute |
| A stolen database | A robot's secret is sealed with the vault key, which is not in the database |
| A model is tricked into commanding a robot | The model can only choose a capability; the Safety Gateway, the approval and the robot's own checks don't involve a model. No capability reaches an actuator |
| An agent's developer key is stolen | A key can ask for missions and stop robots. It can't approve, enroll, reconfigure, revoke or remove a robot |
| A physical robot is passed off as a simulation to avoid approvals | The owner declares the kind; the runtime declares it; they must match, and the ROS 2 adapter refuses to start if "simulation" and simulated time disagree |

Not protected against: someone with control of the robot's own computer (they have the robot); a compromised HANNAH server sending valid commands (the robot's own limits, layers 6 to 11 of the Safety Gateway, are the defence); denial of service against the server (the robot then stops and holds).

## 2. Identity and enrollment

```
Person (signed in)                 Server                               Robot runtime
  POST /api/robots  ───────────►   robot record "pending"
  {name, simulated}                one-time code (hash stored)
  ◄──────────── code, shown once
                                                                   enroll --server … --code …
                                   ◄───────────────────────────  POST /api/robots/enroll {code, descriptor}
                                   check: code valid, unused, not expired;
                                          kind matches; descriptor valid;
                                          capabilities against the contract
                                   make a 256-bit secret; seal it in the vault
                                   ───────────────────────────►  {robotId, secret}   once
                                                                   store in credentials.json (mode 0600)
```

- **Unique identity:** `rb_` + 72 random bits, unique across accounts.
- **Device-specific credentials:** one secret per robot. Two keys are derived from it with HMAC and fixed labels: one signs the robot's requests, the other signs commands to it. A request signature can't be used as a command signature.
- **Rotation:** a new enrollment code for an enrolled robot replaces its secret when used; the old one stops working at that moment.
- **Revocation:** immediate. The sealed secret is deleted; the robot's next request is refused; the runtime holds position and takes no missions.

## 3. Every request from a robot

`POST /api/robots/device/sync`, headers `X-Hannah-Robot`, `X-Hannah-Time`, `X-Hannah-Counter`, `X-Hannah-Signature`.

```
signature = HMAC-SHA256(request key, robotId \n time \n counter \n METHOD \n path \n SHA-256(body))
```

The server checks, in this order: the signature (constant-time), the time (within 60 s), the counter (strictly greater than the last accepted, by a conditional database update). An unknown robot, a malformed header and a wrong signature all get the same answer; only a revoked robot is told that it was revoked, so its runtime can hold and say why.

## 4. Every command to a robot

A command is a JSON text plus an HMAC of exactly that text, so neither side re-serialises anything to check it.

```json
{ "v": 1, "type": "mission", "robotId": "rb_…", "missionId": "ms_…", "seq": 1795…, "nonce": "…32 hex…",
  "capability": "navigate_to", "params": { "x": 3.1, "y": 1.9, "tolerance": 0.25, "maxSpeed": 0.5 },
  "issuedAt": …, "expiresAt": …, "timeoutS": 180, "limits": { "maxLinearSpeed": 0.5 } }
```

The robot's `CommandGuard` accepts it only if: the signature matches; it names this robot; it has not expired and was not issued more than a minute in the future; its sequence is higher than any accepted before; its nonce is new. The last sequence is written to disk before the command is acted on. A damaged state file refuses everything rather than reopening the window. A command already accepted is recognised as a repeat delivery and acknowledged, not run again.

A cancellation needs a valid signature and a mission the robot knows. Replaying one can only stop something.

**Expiring authorization:** a command is valid for the robot's `commandTtlS` (20 s by default, 2 to 300). An approval waiting for a person is valid for 24 hours, but the command is created and signed only when it is approved, and the Safety Gateway runs again at that moment.

## 5. Transport

HTTPS, opened by the robot. The runtime refuses a plain `http://` server unless it is this computer (loopback) or `--allow-insecure` is given for a closed development network. Signatures protect integrity and origin on their own; TLS adds confidentiality (a robot's position and map are private) and server authentication.

Not built: certificate pinning; mutual TLS. Both are options for Block 2 if a deployment needs them.

## 6. Roles and least privilege

| Role | Who | May |
|---|---|---|
| Owner | A person signed in to the account | Everything: enroll, set limits, switch capabilities off, approve, revoke, remove |
| Operator | An agent or program holding one of the account's developer keys; a workflow; an MCP host | Read robots, state and missions; ask for missions (which then wait for the owner unless a standing permission covers that robot); cancel a mission; stop a robot |
| Device | The robot's runtime | Report its own state and its own missions; receive its own commands. Nothing else, and nothing about another robot |

Roles for several people on one robot (a second operator, a read-only viewer) are not built. A robot belongs to one account.

## 7. Audit

- Every request for a robot action is an Action Engine record: who asked, through what, the permission decision and its reason, the approval and who gave it, the response and the verification. Kept 180 days.
- Every mission: when it was sent, accepted and finished, its result and how the server checked it.
- Every device event, from the robot or the server: enrollment (and refused attempts), emergency stop, faults, refused commands, link loss, stop requests, revocation.
- On the robot: a JSON line per event on standard output. The robot's secret is never logged (a test checks).

## 8. Secure configuration

- The robot's limits live in a file on the robot. The server can't write to it.
- The credentials file is created with mode 0600 in a directory with mode 0700.
- A server without a vault key refuses to enroll robots rather than store a secret in the clear.
- New environment settings are in `server/.env.example`.

## 9. Signed firmware and configuration updates — design only

Nothing in this section is built. Block 1 delivers the architecture so later work doesn't have to retrofit it.

**Principle:** HANNAH never writes firmware directly. It can only *offer* a signed update to the robot's own update agent, which decides.

```
Vendor or owner builds an update
  → signs it OFFLINE with a release key (Ed25519; the private key never touches HANNAH's server)
  → uploads the bundle and a signed manifest:
       { robotModel, hardwareRevision, component, version, minPreviousVersion,
         sha256, size, releasedAt, expiresAt, rollbackTo }
  → the owner approves the rollout for a named robot (an Action Engine action, kind "destroy": always asks)
  → the robot's update agent, not HANNAH's runtime:
       verifies the manifest signature against a public key installed at manufacture
       refuses a version older than the installed one (anti-rollback counter), unless it is a signed rollback
       refuses unless docked, idle, battery above a threshold, emergency stop state normal
       writes to the inactive slot (A/B), verifies the hash, switches, reboots
       runs a self-test; reports the new version
       falls back to the previous slot automatically if the self-test fails or the robot doesn't check in
```

**Rollback planning:**

- A/B slots, so a failed update never leaves the robot without working firmware.
- The previous version stays installed until the new one passes its self-test and the owner confirms.
- A rollback is itself a signed manifest, so an attacker can't use "rollback" to install an old vulnerable version.
- Updates roll out to one robot first, then the rest; a failure stops the rollout.
- Configuration (limits, maps, places) is versioned the same way; a configuration update can't loosen a limit without a person at the robot.

Established pieces to build this on, not reinvent: The Update Framework (TUF) or Uptane for the trust model; RAUC, Mender or SWUpdate for A/B updates on Linux; the microcontroller's own secure bootloader (for example MCUboot) for micro-ROS boards.

## 10. Why HMAC and not public-key signatures

A public-key design (the server signs with a private key; each robot holds only public keys) would mean a database copy plus the vault key could not forge commands. The phone bridge in this codebase uses P-256 that way.

Robots use HMAC because the runtime is meant to run on any robot computer with nothing beyond the Python standard library, which has no elliptic-curve signatures. The consequences: the server must hold each robot's secret, and it is sealed in the vault for that reason; a full server compromise can forge commands to enrolled robots. The robot's own limits remain the defence in that case.

**Upgrade path:** the command envelope has a version field. A version 2 with Ed25519 command signatures (and the runtime depending on `cryptography`, which ROS 2 installations already carry) is a contained change: `signCommand` on the server, `CommandGuard.check` on the robot.

## 11. Open items for a security review

1. An independent review of the protocol; it has had none.
2. A request counter that survives a server restore from backup (a restored database could accept an older counter).
3. Rate limiting on the signed sync endpoint (enrollment is limited; sync is not, beyond the signature check).
4. Certificate pinning or mutual TLS for deployments that want it.
5. Telemetry retention and who may export it, before any robot with a camera is supported.
