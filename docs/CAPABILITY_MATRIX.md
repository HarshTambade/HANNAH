# Capability Matrix

What works where, as of 1.5.0 (`main`, not yet released; 1.4.0 is the published release). Each entry has one of five statuses:

- **Verified**: implemented, and run for real: automated tests against the real server and database, or on this platform's hardware.
- **Partly verified**: implemented and tested, but not yet run end to end where it matters (a real account, a physical device, a signed package). The row says what's missing.
- **Restricted**: the platform doesn't allow it; HANNAH does what the platform supports instead.
- **Blocked**: implemented, but it needs something only the owner can provide (credentials, signing, a device).
- **Not implemented.**

Issue numbers (KI-…) are in [architecture/KNOWN_ISSUES.md](architecture/KNOWN_ISSUES.md).

## By platform

| Capability | Web | macOS | Windows | Linux | Android | iOS |
| --- | --- | --- | --- | --- | --- | --- |
| Chat, model routing, agents | Verified | Verified | Partly verified (CI build) | Partly verified (CI build) | Partly verified (KI-26) | Blocked (KI-23) |
| Phone Bridge: send a call or SMS to your phone | Verified (server and pairing tests) | Verified (same) | Verified (same) | Verified (same) | Partly verified: dialer and composer hand-off not run on a physical phone (KI-31) | Partly verified (KI-23, KI-31) |
| Phone Bridge: act as the paired phone | n/a | n/a | n/a | n/a | Partly verified (KI-31) | Partly verified (KI-23, KI-31) |
| Workflows: engine, triggers, AI, data, approvals | Verified | Verified | Verified | Verified | Verified | Verified |
| Workflows: phone steps (check, find contact, call, text) | Verified against a signing test phone; physical phone not run (KI-31) | same | same | same | same | same |
| Workflows: desktop steps (open apps and links, notification, web page, coding) | n/a | Partly verified (desktop tests, packaged smoke test) | Partly verified | Partly verified | n/a | n/a |
| Gmail and Outlook: search, read, needs-reply, reply drafts, archive and labels, attachments, send | Partly verified: tested against recorded Google and Microsoft APIs; not run with a real account (KI-30) | same | same | same | same | same |
| Google Chat as you: spaces, messages, post | Partly verified (KI-30) | same | same | same | same | same |
| WhatsApp | Business number only, through Meta's Cloud API bot (Chat apps); personal WhatsApp is **Restricted** (no official API) | same | same | same | same | same |
| Computer control | n/a | Partly verified (KI-24) | Not implemented (KI-25) | Not implemented (KI-25) | n/a | n/a |
| Voice turns (speech in and out, barge-in) | Verified | Verified | Partly verified | Partly verified | Partly verified | Blocked (KI-23) |
| "Hey HANNAH" wake word | While the tab is open | Keeps listening while the window is hidden; menu bar shows it | Same as macOS, partly verified | Same as macOS, partly verified | Native foreground service with a Stop notification: not yet compiled on a dev machine or run on a phone (KI-28) | **Restricted**: no third-party wake word. "Hey Siri, talk to HANNAH" instead (KI-29) |
| Memory: save, edit, delete, categories, sensitivity, secrets refused | Verified | Verified | Verified | Verified | Verified | Verified |
| Memory: newer facts replace older ones (with history), temporary chat, Markdown export | Verified (unit tests) | same | same | same | same | same |
| Memory: semantic (vector) search, pgvector | Not implemented: retrieval ranks by matching words (KI-32) | same | same | same | same | same |
| Cross-device sync | Verified (server tests); opt-in | same | same | same | same | same |
| Reminders | In the open app | Verified | Partly verified | Partly verified | Partly verified (KI-26) | Blocked (KI-23) |
| Updates | Site redeploys | Stable and beta channels; signed builds Blocked on signing secrets | Same | Same | Store or APK | Store (Blocked) |

## Privacy and consent

| Capability | Privacy implications | Cost implications | Required consent |
| --- | --- | --- | --- |
| Phone Bridge | Only matching contact names and numbers leave the phone; requests last one minute | None | Pairing on both devices; each call or SMS approved, then tapped on the phone |
| Mail and Google Chat | Read through your own OAuth grant; other people's content is never treated as instructions | Provider API quotas | Connecting the account; every draft, label, archive, post or send approved |
| Wake word | Detection on the device; no audio is sent until you speak to HANNAH after it | Battery on Android while the service runs | Turned on by you; Android shows a notification the whole time |
| Multimodal perception | Processes user images/audio | On-device first; cloud optional | Per-modality consent |
| Memory evolution | Stores derived insights | Background, low cost | Memory consent; temporary chat turns it off per conversation |
| Cross-device sync | Encrypted payloads only | Relay hosting cost | Sync opt-in |
| Tool synthesis | Executes generated scripts in sandbox | Sandbox compute | Explicit approval |
| Proactive participation | Uses emotional trajectory | Budget capped | Proactive settings |
