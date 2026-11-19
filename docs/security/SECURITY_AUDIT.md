# Security audit

Date: 2026-11-19, for 1.5.1. This records what was checked and how; it is not a penetration test.

## Fixed in this round

| Issue | Severity | Fix | Evidence |
|---|---|---|---|
| A state-changing request carrying the session cookie was accepted from a foreign `Origin` | Low to medium (browsers already withhold a `SameSite=Lax` cookie on cross-site POSTs) | Origin check in `accountAuth` for cookie sessions | `accounts.test.js`; live 403 |
| Sync relay: guessable ids (`Math.random`), no body limit, any payload accepted | Medium for anyone self-hosting it | Per-device storage, 1 MB limit, envelope validation, caps | `sync-relay.test.js` |
| Workflow drafts could contain model-invented outbound URLs | Low | Placeholder addresses cleared; drafting forbids invented addresses | `workflows.draft.test.js` |

## Changed on purpose in this round

Two routes became reachable by more callers. Both were reviewed for what that opens up.

| Change | What a caller can now do | What limits it | Evidence |
|---|---|---|---|
| A visitor with no credential can use `/api/connectors/discover`, `/register`, `/token` and `/rpc` | Connect and call the 32 connectors in HANNAH's own directory, with their own vendor sign-in or token | A guest is refused any address outside the directory before anything is fetched, so the routes are not a relay to arbitrary servers; 40 requests a minute per address (120 for signed-in callers); the SSRF-safe client, https only, and redirect-URI checks apply as before; the server still stores no connector tokens | `connectors.test.js` (guest allowed in the directory, refused outside it, other routes still closed) |
| `/mcp` is on by default and accepts a developer key, the operator token, a Groq key or a signed-in session | Call `hannah_chat`, `hannah_status` and `hannah_models`, the same things `/api/chat` and `/api/models` already allow that credential | The same credential middleware as `/api/chat`; each tool call goes to the API with the caller's own credential, so rate limits, budgets and operator-only rules are unchanged; no credential answers 401; `MCP_ENABLED=false` turns it off | `mcp-client.test.js` (none and wrong refused; own credential works; standalone mount still needs its token) |

On serverless hosting, MCP tool calls reach the API through the site's public address taken from the platform's forwarded host header. That header is set by the platform there; on other hosts the endpoint calls `127.0.0.1` and ignores it.

## Research and Document Studio (1.6.0)

New code that fetches from the web, reads uploaded files and stores generated files. What was checked:

| Risk | What stops it | Evidence |
|---|---|---|
| Prompt injection from a web page | The model sees only evidence passages inside a block labelled untrusted; sentences addressed to a model are removed first and the source is flagged; no tool is callable from the research prompt | `research.test.js`: the injected line never reaches the model |
| Prompt injection from an uploaded file | File text is passed as labelled data; reading a file grants nothing and tools keep their approvals | Review; `studio.test.js` (prompt shown to the model) |
| Fabricated citations | Citations are checked in code against the retrieved sources; ones that match nothing are removed; unsupported figures and quotations are reported | `research.test.js` |
| SSRF through research | Every search and page fetch uses the existing SSRF-safe client; `robots.txt` is obeyed; redirects are re-checked | `research.test.js` (disallowed page never requested) |
| Fetching while making a document | Rendering fetches nothing; an image must be inline PNG or JPEG data, anything else is dropped | `documents.test.js` |
| One user reading another's files or research | Every query filters by user id; another account's id answers 404 on read, download, change and delete; no credential answers 401 | `studio.test.js` |
| Malicious uploads | 20 MB limit; ZIP parts are read in memory with a 150 MB unpacked limit; XML is parsed with patterns, not an entity-expanding parser; nothing is written to disk or executed | `documents.test.js`; review |
| Formula injection in workbooks | A cell from an uploaded file, a converted file or a document table that begins with `=` is written as text. Formulas come only from column-name templates resolved by code, or from a workbook description the caller wrote for their own file | `documents.test.js` (a hostile CSV produces no formulas) |
| Download header injection | File names are sanitized for the header and sent with `filename*`; `nosniff`; `no-store` | Review of `studio.js` |
| Storage exhaustion | 12 MB per file, 200 files and 250 MB per account, 30-day expiry, oldest unkept files evicted | `studio.test.js` (expiry) |
| New dependencies | `pptxgenjs` 4.0.1, `docx` 9.15.2, `pdfkit` 0.20.2, `jszip` 3.10.2, `unpdf` 2.1.0, `fast-formula-parser` 1.0.19, all pinned and at least two weeks old. `exceljs` was rejected for vulnerable dependencies. `image-size` (declared by `pptxgenjs`, not loaded by it) is overridden to a patched 2.0.4 | `npm audit`: 0 vulnerabilities |

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
| Tool output | A tool result the output screen objects to is now withheld from the model instead of ending the turn; long results are shortened | Pass (`Marketplace.test.ts`) |
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
