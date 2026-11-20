# Autonomous operator architecture

Status: 1.7.0 · Last reviewed 2026-11-20

HANNAH acts for a person through one shared engine. This page describes that engine, what sits on top of it, and what is and isn't built. Every feature has one of six states, defined at the end.

## The shape

```
 Chat · Voice · Team specialists · Marketplace agents · Workflows · MCP hosts · Devices
                                   │
                     one tool entry point (client)          services.action (workflows)
                     executeHANNAHTool → Operator.ts         hannah_action (MCP)
                                   │
                ┌──────────────────▼───────────────────┐
                │  Action Engine   server/actions/      │
                │  understand → permission → approval   │
                │  → execute once → verify → record     │
                └───────┬───────────────────┬───────────┘
        permission manager             action catalog
        levels, standing permissions,  calendar · mail · messages · code · device
        always-ask rules, stop         each: preview, execute, verify
                │                           │
        hannah_permissions,          Google / Microsoft APIs, chat platforms,
        hannah_grants                GitHub, the coding service, the device
                │
        hannah_actions: the approval queue and the audit history are the same rows
```

There is no second execution path. An agent doesn't send email or open a pull request by itself; it asks for the action `mail.send` or `code.publish`, and the engine decides and does the rest. This is the same decision as for research and documents in 1.6.0 (`ARCHITECTURE.md`): capabilities are platform services, and agents are callers.

## The engine (`server/actions/engine.js`)

An action is a definition with: an id, a service, a kind, a way to normalize its input, `assess` (what it touches, which account, any flags), `preview` (what the person sees), `execute`, and `verify`.

| Step | What happens |
|---|---|
| Normalize | The definition checks the input. A recipient that isn't a full address, or a name that matches no one or several people, is refused here. |
| Assess | Reads what is needed to describe the action: the calendar around the time (conflicts, duplicates), the repository's access setting, the files to attach. Returns the resource and flags. |
| Permission | `permissions.evaluate` with the account's current policy and standing permissions, read fresh every time. Outcome: allow, ask, suggest, or deny. |
| Record | A row in `hannah_actions` before anything runs, with the request, the agent, the preview and the decision. |
| Approval | An action that must ask waits (24 hours for server actions, 30 minutes for device actions). Only a signed-in person can answer, from any device; the first answer wins (a conditional update). Before running, the stop switch and the level are checked again. |
| Execute | At most once. The row moves to `executing` conditionally; a request repeated with the same idempotency key returns the first record. |
| Verify | The destination service is asked whether it happened: the event is read back, the message is found in Sent, the branch head and pull request are read from GitHub. |
| Outcome | `done` (executed and confirmed), `unverified` (accepted, couldn't be confirmed), `failed` (the service's error), `unknown` (started, no result came back; never retried automatically). |

Kinds, from least to most consequential: `read`, `prepare` (a draft; nothing submitted), `write` (changes something of the person's), `send` (reaches other people), `spend`, `destroy`.

Device actions (a file write, an outside tool, a setting, the dialer) use the same records. The device asks, acts only when the record says `authorized`, and reports the result. If it never reports, the record reads `unknown`, not done.

## Callers

| Caller | How it reaches the engine | State |
|---|---|---|
| Chat, voice, single-agent loop | `executeHANNAHTool` (the one way a tool runs) hands tools with an `engine` mapping to `Operator.perform`; device tools pass through `Operator.gate` | IMPLEMENTED AND VERIFIED (unit tests with a scripted server; voice enters the same function, not spoken aloud in a test) |
| Team specialists | The same tools. The coding specialist has the `code_` tools; the tasks specialist is the personal assistant with calendar, email and messaging | IMPLEMENTED BUT NOT FULLY VERIFIED (tool lists and instructions; no Team run exercised them) |
| Workflows | Steps "Do an action (with your permissions)" and "Check a repository" through `services.action` and `services.codeCheck` | IMPLEMENTED AND VERIFIED for the services; the step wrappers have no browser test |
| MCP hosts | Tool `hannah_action`. It can ask; it can never approve | IMPLEMENTED BUT NOT FULLY VERIFIED (listed and schema-checked; not called from a real host) |
| Developer keys (REST) | `POST /api/actions`. A key can ask and read history; it can't approve, change levels, add permissions, connect tokens or lift the stop | IMPLEMENTED AND VERIFIED |

## What is built on the engine

| Capability | Where | State |
|---|---|---|
| Permission manager, standing permissions, emergency stop, audit history | `server/actions/permissions.js`, `engine.js` | IMPLEMENTED AND VERIFIED. See `docs/security/PERMISSION_AND_TRUST_MODEL.md` |
| Calendar actions | `catalog/calendar.js` | IMPLEMENTED AND VERIFIED against a stand-in Google API for read, free time, create, delete; update, repeats, meeting links and the Microsoft paths are IMPLEMENTED BUT NOT FULLY VERIFIED. Real accounts: BLOCKED BY USER PERMISSION OR CREDENTIALS |
| Email actions | `catalog/communications.js` | IMPLEMENTED AND VERIFIED against a stand-in Gmail for drafts and sending; attachments verified as a message, not sent through a provider |
| Messaging actions | `catalog/communications.js` | IMPLEMENTED AND VERIFIED for a Telegram bot (stand-in API); Slack, WhatsApp Business and Google Chat use the same path and are IMPLEMENTED BUT NOT FULLY VERIFIED |
| Coding service | `server/coding/` | See `docs/engineering/CODING_AGENT_CAPABILITIES.md` |
| Integrations hub | `GET /api/account/integrations`, Actions → Connections | IMPLEMENTED AND VERIFIED |
| Actions screen | `client/src/components/OperatorPage.tsx` | IMPLEMENTED AND VERIFIED in a browser against a real server |
| Bookings | — | NOT IMPLEMENTED. No booking provider's API is connected (BLOCKED BY EXTERNAL PROVIDER). HANNAH can research options, draft a request by email or message, and add a calendar event. It never reports a booking as made. `bookings.payment` exists only so any paying step a device attempts is forced to ask |
| Browser actions | The desktop app's browser window (existing) | PARTIALLY IMPLEMENTED: navigation, reading, typing and pressing with the app's own approval. Tabs, downloads, uploads and signed-in sessions are NOT IMPLEMENTED. Typing and pressing aren't in the engine's history yet |

## Orchestration

HANNAH picks tools from the request's words (`AgentRouter.ts` tool families) and, in Team mode, a planner assigns steps to four specialists (research, coding, memory, tasks) and a verifier (`server/orchestrate.js`). The brief lists fourteen specialists. They are not fourteen agents here: each listed role is a set of the shared tools held by one of the four, because separate agents with separate execution code is what the shared engine replaces.

| Listed role | Held by | Tools |
|---|---|---|
| Coding, repository audit, debugging, software security | Coding | `code_*`, desktop files and commands |
| Web research, browser | Research | `research`, `web_*`, `browser_*` |
| Calendar, email, messaging, personal assistant, booking (research and drafting only) | Tasks | `calendar_*`, `email_*`, `message_*`, reminders |
| Data analyst, document creation | Every agent | `create_document`, `read_attached_files` |
| Verification | The Team verifier, and each action's own `verify` | — |

Multi-step tasks across services are durable in two places: coding tasks on the server (`hannah_coding_tasks`, see `docs/operations/AUTONOMOUS_TASK_RECOVERY.md`) and Team runs in `hannah_task_runs` (1.5.0). Every engine record carries a `taskId`, so a task's actions can be listed together. A single durable object for any cross-service task ("research, make two files, email them") is PARTIALLY IMPLEMENTED: the pieces run and are recorded, and a Team run checkpoints them, but that example was not run end to end.

## Data

Migration 17 adds `hannah_actions`, `hannah_permissions`, `hannah_grants`, `hannah_integrations`, `hannah_repos`, `hannah_coding_tasks`. All are per user; every query filters by the signed-in user. Tokens are sealed with the vault. Action records are kept 180 days, up to 5,000 per account.

## States used in these documents

- **IMPLEMENTED AND VERIFIED**: it ran in an automated test or a live check, and the evidence is named.
- **IMPLEMENTED BUT NOT FULLY VERIFIED**: the code is written to the provider's documented API; part of it has not run against a test or the real service.
- **PARTIALLY IMPLEMENTED**: some of what was asked exists; the rest is named.
- **BLOCKED BY EXTERNAL PROVIDER**: the provider offers no supported way to do it.
- **BLOCKED BY USER PERMISSION OR CREDENTIALS**: it needs an account, an app registration or a key only the owner can create.
- **NOT IMPLEMENTED**: nothing exists.
