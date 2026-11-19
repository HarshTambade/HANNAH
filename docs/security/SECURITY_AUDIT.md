# Security audit

Date: 2026-11-19, for 1.5.1. This records what was checked and how; it is not a penetration test.

## Fixed in this round

| Issue | Severity | Fix | Evidence |
|---|---|---|---|
| A state-changing request carrying the session cookie was accepted from a foreign `Origin` | Low to medium (browsers already withhold a `SameSite=Lax` cookie on cross-site POSTs) | Origin check in `accountAuth` for cookie sessions | `accounts.test.js`; live 403 |
| Sync relay: guessable ids (`Math.random`), no body limit, any payload accepted | Medium for anyone self-hosting it | Per-device storage, 1 MB limit, envelope validation, caps | `sync-relay.test.js` |
| Workflow drafts could contain model-invented outbound URLs | Low | Placeholder addresses cleared; drafting forbids invented addresses | `workflows.draft.test.js` |

## Checked and found in order

| Area | What was checked | Result |
|---|---|---|
| Secrets in the repository | `scripts/scan-secrets.mjs` over 542 files | None |
| Dependencies | `npm audit --omit=dev` in root, client, server; audit gate | 0 vulnerabilities; nothing forced |
| Authentication | Wrong password refused; revoked developer key refused; no key on `/v1` refused; password delete requires the password | Pass (live) |
| Authorization | Accounts can't reach operator routes (desktop control, MCP servers); per-user rows keyed by `user_id` in every query reviewed in accounts, tasks, workflows | Pass |
| SSRF | Page reader and workflow HTTP refuse private, loopback and link-local addresses unless the operator opts in | Pass (live: 169.254.169.254 refused) |
| Prompt injection | Tool results, memories, document passages and community skills are labelled untrusted in the prompt; approvals are enforced in code (`SafetyGuard`), not by the model; community skills are re-screened on the server | Pass (red-team suite in CI) |
| Command execution | Desktop terminal and file tools are operator-only and behind approval; not exposed to accounts or A2A | Pass (by route test) |
| Stored credentials | Provider keys and OAuth tokens sealed with AES-256-GCM under the vault key; sync envelopes AES-256-GCM with PBKDF2 (310,000) | Pass (vault tests) |
| Rate limits | Per credential and per address; shared across serverless instances through the database | Pass |
| Webhooks | HTTPS targets only; HMAC signatures with replay protection | Pass |
| Uploads | Size and type checks on audio, images and workflow files | Pass (live: bad audio and image refused) |
| XSS | Model output rendered through `MessageContent` (no raw HTML); `dangerouslySetInnerHTML` is not used anywhere in the client | Pass by review |

## Open items

| Item | Why it's open | Who |
|---|---|---|
| Installers are unsigned | No certificates; users see OS warnings and auto-update on macOS is limited | Owner |
| `isChatModel` is a name filter | A provider could name a non-chat model in a way it misses; effect is a failed request, not a security issue | Low |
| Guest access uses the operator's Groq key | By design (`guestAccess`); bounded by rate limits and the daily budget, but it is your quota | Owner decision |
| The relay holds envelopes in memory and lets any caller download ciphertext | Documented; confidentiality rests on the passphrase | Documented |
| Production secrets backup | `~/hannah-production-secrets.env` on this Mac is the only copy of the vault key outside Vercel | Owner: move to a password manager |
