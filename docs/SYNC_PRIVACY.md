# Sync Privacy

## Threat Model
The relay stores and forwards only opaque encrypted payloads. It cannot read memory, tasks, or side-effect ledger contents.

## What the relay can see
- Opaque ciphertext blobs (AES-256-GCM, with a key derived from your sync passphrase by PBKDF2-SHA-256, 310,000 rounds).
- Which device id sent each envelope, when, and how large it is.

## What the relay cannot see
- Decrypted memory contents.
- Task prompts or results.
- Side-effect targets.

## Self-hosting
Run `node server/sync-relay.js` to host your own relay (`SYNC_RELAY_PORT`, default 8787), and give each device its address, either `https://relay.example` or `https://relay.example/sync`. The relay checks only that each upload is an encrypted envelope from a named device. It doesn't log or inspect content.

The protocol:

| Request | Body / answer |
|---|---|
| `POST /sync` | `{ "deviceId": "…", "envelope": { …encrypted… } }` → `{ "stored": true }` |
| `GET /sync/<deviceId>` | → `{ "envelopes": [ … ] }`: every other device's envelopes, never this device's own |

Limits: 1 MB per envelope, the newest 100 envelopes per device, 1,000 devices. Envelopes live in memory, so a restart empties the relay; devices keep their own queue until an upload succeeds. Anyone who can reach the relay can download the envelopes, but can't read them without the passphrase, so use a long passphrase. Cross-device sync for signed-in accounts goes through the HANNAH server instead and doesn't need a relay.