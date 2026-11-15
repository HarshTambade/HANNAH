# Sync Privacy

## Threat Model
The relay stores and forwards only opaque encrypted payloads. It cannot read memory, tasks, or side-effect ledger contents.

## What the relay can see
- Opaque ciphertext blobs.
- Operation metadata such as timing and payload size.

## What the relay cannot see
- Decrypted memory contents.
- Task prompts or results.
- Side-effect targets.

## Self-hosting
Run `node server/sync-relay.js` to host your own relay. The relay does not validate, log, or inspect content.