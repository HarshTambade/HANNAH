# Full product audit

Date: 2026-11-19. Base: v1.5.0 (`c70e584`). Result: v1.5.1.

## How it was done

1. **Static sweep** of client and server for the usual marks of unfinished code: `Math.random`, timers standing in for work, "simulated", "mock", "scaffold", "not implemented", TODO/FIXME, hard-coded statuses and literal data arrays in components.
2. **Use of the running product** with Playwright against a real server, a real database (SQLite) and Groq's real API: every screen as a guest, as a signed-in account and as the operator; then each feature driven as a person would, reading what came back.
3. **API smoke test** as an account and with a developer key: 29 checks over accounts, keys, `/v1`, A2A, sync, export, audit log, phone pairing, voice, vision, web, and the refusals that must happen.
4. **Each failure traced** from the control to the request, the handler and the provider call, fixed at the cause, covered by a test, then re-run live.
5. **Regression**: full unit, API and end-to-end suites, lint, typecheck, secret scan, dependency audit.

Details per bug are in [BUGS_AND_ROOT_CAUSES.md](./BUGS_AND_ROOT_CAUSES.md); the status of every feature is in [REPAIR_TRACKER.md](./REPAIR_TRACKER.md).

## By subsystem

| Subsystem | Finding |
|---|---|
| **Models and providers** | The largest failure of the audit: Auto was broken everywhere because curated model lists had gone stale. Fixed by following each provider's live list. Pickers no longer show non-chat models. Only Groq was exercised with a real key. |
| **Agents** | The single-agent loop and Team mode run real tools (memory, reminders, web search, knowledge, connectors). Two tool-selection filters hid tools; fixed. Team's silent rate-limit waits looked like hangs; now shown. |
| **Automations (device)** | Work: schedule, run now, approvals, run history with each step's output. |
| **Workflows (server)** | A real engine: node registry with schemas, durable executions, retries, pause/resume, versions, webhooks with HMAC, schedules, approvals. Drafting from text produced workflows that couldn't run; fixed, and a web-search step was added. |
| **Memory and Knowledge** | Memory save (with approval), recall, categories, export and delete work. Knowledge answers failed unless the message used certain words; fixed. The background "consolidation" used random choice; fixed. |
| **Voice** | Speak and Call start and listen in the browser. Speech recognition quality, wake word and background behavior need a person and a device. |
| **Accounts and data** | Register, sign in, keys, sync, export, audit log and delete all verified live. Cross-site origin check added. |
| **Integrations page and APIs** | `/v1` and A2A had the same stale-model bug; fixed. The remote MCP endpoint didn't exist on serverless hosting and took one operator token; it now works there with each caller's own credential. The page was documentation only; it now tests each integration live. |
| **Marketplace** | Connectors failed for every visitor who wasn't signed in (401 on Connect); fixed, and all 32 checked against the vendors. Agents and skills were six short text snippets with a two-step install and no trace in chat; now 22 packages with tools and prompts, one click, and a visible active agent. |
| **Home page** | Asked every newcomer for an API key before anything else. It now starts from a message or a task, and follows what the server offers. |
| **Communications** | Code is real and tested against stand-ins. Not verified with real Google or Microsoft accounts (needs your OAuth credentials). |
| **Phone Bridge** | Server side verified; no physical phone here. |
| **Desktop and mobile apps** | Build in CI on all platforms. Android launched on an emulator. Desktop control and iOS not exercised by hand. |
| **Database** | 15 migrations, applied cleanly to SQLite, PGlite and the live Neon database (schema version 15). No schema defects found in this pass. |
| **Security** | See [SECURITY_AUDIT.md](../security/SECURITY_AUDIT.md). |
| **UI** | Every screen loads without console errors in all three modes; the e2e crawler presses every control on every screen. Routes have real paths and titles. No invented statistics or testimonials on public pages. |

## 1.6.0: search, research and documents

Inspected before building (2026-11-20):

| Area | What existed | Verdict |
|---|---|---|
| Web search | `web_search` tool and "Search the web" workflow step: one Groq browser-search call returning a short answer and links | Real, but a single lookup: no plan, no page reading by HANNAH, no check of what the answer cited |
| Page reading | `web_read`, through the SSRF-safe client | Real; reused by the research engine |
| Research agent | The Team "Research" specialist, with the two tools above | Real; now uses the shared research service |
| Knowledge | Local documents with BM25 search | Real; text files only (no PDF, Word, PowerPoint or Excel) |
| File upload in chat | None | Missing |
| Document generation or export | None: no PPTX, PDF, DOCX or XLSX was produced anywhere | Missing |
| Fake search progress, fabricated source cards, placeholder export buttons | None found | Nothing to remove |

Built: one research engine and one Document Studio on the server, used by every caller. See [RESEARCH_AND_DOCUMENTS.md](../RESEARCH_AND_DOCUMENTS.md) and the 1.6.0 table in [REPAIR_TRACKER.md](./REPAIR_TRACKER.md).

## Dummy or fake code found

| Where | What it did | Outcome |
|---|---|---|
| `OnDeviceLoRAService`, `DreamingConsolidator` | Idle-wait loop; kept notes at random | Made real |
| `PersonaKernel.update` | Threw "not implemented in scaffold" | Removed |
| `server/sync-relay.js` | Relay that didn't match its client | Made real |
| Workflow draft output | Invented `example.com` endpoints | Prevented and cleaned |
| Marketplace packages | Installed packages did nothing until activated, and nothing showed they were on | Made real: one click, visible in chat, tools and prompts per agent |
| Figma connector | Listed, could never connect | Removed |
| Integrations page | Described integrations without exercising any | Live checks added |
| Earlier pass (1.5.0) | Sync, CRDT merge, orchestrator, research agent, PAP sign-in, hardware adapter, interop card | Made real, see CHANGELOG 1.5.0 |

Chaos mode's "simulated" faults are a deliberate, labelled testing feature, off by default.

## What this audit did not cover

Real Google/Microsoft/WhatsApp accounts; providers other than Groq; a physical phone; the packaged desktop app by hand; iOS at runtime; thirteen panels that no screen shows. Each is listed with what it needs in the tracker.
