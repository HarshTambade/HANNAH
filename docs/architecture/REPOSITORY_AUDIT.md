# HANNAH repository audit

Date: 2026-11-18. Commit audited: `adee6fd` (main), plus the fixes listed in [KNOWN_ISSUES.md](KNOWN_ISSUES.md) that this audit led to.

How this audit was done:
- **Read the code** for each subsystem, rather than relying on its docs or UI.
- **Ran the real thing where possible:**
  - the server with a real SQLite account database and the real Groq API;
  - all six workflow templates and every node type that needs no outside account;
  - a burst of concurrent runs, a real webhook, and AI drafting.
- **Ran every test suite and repository gate.**
- **Read the GitHub Actions logs** of the last 12 runs.
- **Opened the v1.4.0 release files** (macOS zip and Android APK) and the APK from the latest `main` CI run.
- **Made read-only requests to the production site.**

Nothing here is marked as working on the strength of an interface alone.

Status key:
- **Tested**: implemented, with automated tests, and run for real during this audit.
- **Partial**: works, but with a known gap.
- **Unverified**: built and unit-tested, but not run on the real platform.
- **Blocked**: needs credentials, hardware or a platform decision from the owner.
- **Missing**: not built.

## 1. Summary

The primary product is:
- **`client/`:** the React app, served as a website and PWA, wrapped for Android and iOS by Capacitor, and for desktop by Electron through Capacitor;
- **`server/`:** an Express server with the provider gateway, accounts, durable task runs, the workflow engine, Phone Bridge relay and MCP.

The code is substantial and well tested: 217 server, 292 client, 25 desktop-plugin and 55 browser end-to-end tests. The biggest problems found are not missing code. They are:

1. **Every v1.4.0 download shows a framework icon** (Electron's on macOS, Capacitor's on Android). The fix is on `main` but hasn't been released (KI-9).
2. **The live site runs without its account database**, so accounts, sync and server workflows are off in production (KI-2).
3. **CI had been red on `main` for 9 pushes** because of a Windows path bug in the audit gate (KI-3). It is green again from run 44250391204.
4. **Automations failed whenever the AI provider rate-limited**, which on a free Groq key is most of the time under load (KI-1).

KI-1 and KI-3 are fixed in code by this round. KI-9 needs a release. KI-2 needs the owner's secrets.

## 2. Subsystems

| Subsystem | Where | Status | Evidence |
| --- | --- | --- | --- |
| Web app and PWA | `client/src` | Tested | vitest (292), Playwright (55), production `GET /` serves it |
| Path routing (no `#/`) | `client/src/routes.ts`, `App.tsx` | Tested | `e2e/routing.spec.ts`; the leftover `/#section` cases fixed (KI-7) |
| Express server, gateway | `server/index.js`, `gateway.js`, `providers/*` | Tested | `server/*.test.js` (217 pass) |
| Model routing | `server/router.js`, `client/src/services/LLMRouter.ts`, `ModelRouting.ts` | Tested | `router.test.js`, client routing tests |
| Accounts, sessions, vault | `server/accounts.js`, `vault.js` | Tested locally; **off in production** | `accounts.test.js`, `accounts.pglite.test.js`; production `/api/account/status` → `database.configured: false` |
| Durable task runs | `server/task-runs.js`, `client/src/services/TaskRecords.ts` | Tested | `task-runs*.test.js` |
| Server workflow engine | `server/workflows/*` | Tested; rate-limit failure fixed this round | Real runs with Groq (§4); `workflows*.test.js`, `engine.test.js` |
| Device routines | `client/src/services/AutomationService.ts` | Partial by design | Run only while HANNAH is open; AI steps retry 429 through `requestAgentStep` |
| Agent runtime and tools | `client/src/services/AgentRuntime.ts`, `AgentRouter.ts`, `DeviceTools.ts` | Tested | client tests; real-model run in the previous round (`docs/DEVICE_INTELLIGENCE.md` §2b) |
| Desktop runtime (Electron) | `client/electron*`, `client/plugins/desktop-tools` | macOS tested; Windows and Linux unverified | Desktop smoke test; plugin tests; CI builds all three, but Windows has been failing at the audit step (KI-3) |
| Desktop vision and action | `plugins/desktop-tools` (screen, apps, browser, PDF) | Partial | Screen and browser verified on macOS; accessibility-based app control missing (needs the user's Accessibility permission) |
| Phone Bridge | `server/phone-bridge.js`, `client/src/services/PhoneBridge.ts`, `ios/App/App/HannahPhonePlugin.swift` | Unverified on devices | Server and client tests; emergency numbers refused; no physical-device run recorded |
| Android app | `client/android` | Unverified on devices | CI builds an APK; v1.4.0 shipped Capacitor's icon (KI-9) |
| iOS app | `client/ios` | Blocked for release | CI archives it; there's no IPA in the v1.4.0 release (signing) |
| Memory | `MemoryService.ts`, `MemoryStore.ts`, `capacitor-lancedb` | Partial | Local store tested; native vector store not verified on devices |
| Integrations | `server/connections.js` (Google, Microsoft), MCP client and server, webhooks | Tested with stand-ins | `connections.test.js`, `mcp-client.test.js`; no live OAuth run recorded |
| Website (landing, About, downloads) | `client/src/components/LandingPage.tsx`, `client/about`, `server/downloads.js` | Tested | `e2e/navigation.spec.ts`, `routing.spec.ts`, `downloads.test.js` |
| CI/CD | `.github/workflows/build.yml`, `nightly.yml` | **Broken on Windows**, fixed this round | 9 failing pushes (§5) |
| Release management | `scripts/check-versions.mjs`, `release-notes.mjs` | Partial | Versions agree (1.4.0); tags and releases don't (KI-8); released icons wrong (KI-9) |
| Secondary app path | `apps/frontend`, `apps/desktop`, `apps/mobile`, `backend/` (Python) | Secondary, not shipped | Not built by the release jobs; pulls packaging tools into the root workspace (KI-10) |
| eBPF sensor | `ebpf/` | Experimental | Linux only, needs root, opt-in |

## 3. The eight known problems, investigated

| # | Reported problem | What the evidence shows | Status |
| --- | --- | --- | --- |
| 1 | Automation workflows fail during execution | Reproduced with the real Groq API: 4 of 6 concurrent runs failed at their first AI step with "Provider returned HTTP 429." AI steps had 0 retries and ignored the provider's Retry-After. An earlier cause (empty tool list rejected) was fixed on 2026-11-17 and stays covered by `gateway.test.js`. | **Fixed** (KI-1). Also: production has no database (KI-2). |
| 2 | Execution may be incomplete or simulated | Not simulated: the engine really calls the provider, HTTP endpoints, the database and the sandbox; every node writes a checkpoint. Two silent cases: a run that skipped most steps because a list was empty still read **Completed** (KI-4), and on production nothing runs on the server at all (KI-2). | **Fixed** (KI-4); KI-2 needs config |
| 3 | Navigation exposes `#models` | App routes are real paths; old `#/route` links redirect. Landing-page links scroll without a hash. The leftovers: the About page's own section links, and its links to `/#features` and `/#download`, left the hash in the address bar. | **Fixed** (KI-7) |
| 4 | Downloaded apps show framework icons | **Confirmed in the shipped files.** v1.4.0's macOS app uses Electron's `electron.icns`, and its APK has Capacitor's launcher icons. HANNAH's icons were wired into packaging only after v1.4.0 was tagged (commit `423ab5a`), and the brand gate checks source files, not what's packaged. | Fixed on main, needs a release; CI now checks packaged icons (KI-9) |
| 5 | Native features may be incomplete | Native plugins exist (`HannahPhonePlugin.swift`, `capacitor-lancedb`, `capacitor-mobile-claw`, `capacitor-mobilecron`). None has a recorded run on a physical phone. | Unverified (KI-13) |
| 6 | CI failed dependency checks (11 vulnerabilities) | The current failure is 9 "high" advisories in `client/electron` on **Windows only**. They are already accepted with a reason in `.audit-exceptions.json`, but the gate compared `client\electron` with `client/electron`. The earlier failure (run 44133124475) was the old `npm audit --audit-level=high` step, since replaced by the gate. Production dependencies have 0 findings. | **Fixed** (KI-3); confirmed by the next CI run |
| 7 | Release and version information inconsistent | All version fields are 1.4.0 and match the latest release. Tags `v1.0.3`, `v1.1.0`, `v1.2.0` have no GitHub release, and the `v1.0.2` release is still titled "Shanaya". | Open (KI-8) |
| 8 | Landing page needs improvement | Redesigned in an earlier round; it passes the accessibility and navigation e2e tests. No new measured defect beyond KI-7. Any further redesign is a product decision. | Open, product |

## 4. Real workflow runs (this audit)

Setup: a local server with a SQLite account database, a vault key and the operator's Groq key (`HANNAH_ACCOUNTS_USE_SERVER_KEYS=true`, key never read). The client calls went through the HTTP API exactly as the app makes them.

| Run | Before the fix | After the fix |
| --- | --- | --- |
| Invoice intake template (webhook → extract → AI review → if → notify) | Completed: vendor, amount 1284.5 and date extracted correctly | Same |
| GitHub triage template (webhook → if → coding agent → notify) | Completed | Same |
| Evening memory template, no reminders today | **Completed** with 3 of 5 steps skipped and nothing explained | The run page names the step that returned nothing (KI-4) |
| AI-drafted "every morning summarize my reminders and notify me" | Completed, but no notification on an empty day | The drafter now knows the Aggregate "continue" option |
| 6 invoice runs at once on the free key | **4 failed** within seconds: "Provider returned HTTP 429." | **5 of 6 completed** after waiting up to about 25 minutes for the busy key. 1 failed at 29.6 minutes, saying it kept trying for 29 minutes and what to do (KI-1) |
| AI drafting while rate-limited | 429 "Provider returned HTTP 429." | Waits briefly, then a clear message with Retry-After |

## 5. CI evidence

`gh run list` on 2026-11-18: the 9 pushes after the v1.4.0 release build all failed.

- **Most failures:** the only failing job is **Electron (windows-latest)**, at "Dependency audit (Electron packaging tools)", with 9 high findings "without an exception".
- **Run 44133124475:** the old macOS `npm audit --audit-level=high` step failed.
- **Every other job passes:** gates, browser e2e, web, Android, iOS, Electron on Linux and macOS, and the red-team suite.

## 6. Architectural problems

| Problem | Evidence | Recommendation |
| --- | --- | --- |
| Two app paths | `client/` ships. `apps/*` and `backend/` (Python) have their own router and tool contracts, aren't built by the release jobs, and add electron-builder to the root workspace (the root audit exceptions exist only because of them). | Decide: archive `apps/*` and `backend/`, or keep them as clearly experimental outside the root workspaces. Not changed here: it's a deletion and needs the owner's decision. |
| Two automation engines | Device routines (`AutomationService.ts`) and server workflows (`server/workflows`) | Intentional: routines are for people without an account or server. Keep, but steer signed-in users to server workflows (already the default tab). |
| Serverless background work | Vercel has no worker. Waits and schedules need `/api/workflows/tick`, but `vercel.json` has no cron and `CRON_SECRET` isn't set in production (tick → 401). | KI-2 |
| One shared free AI key for guests | Production `/api/health`: `guestAccess: true`, provider Groq. Every guest shares one key's per-minute budget. | KI-6 |
| Source checks without output checks | The brand gate passed while the shipped apps had framework icons. | A packaged-output check was added (KI-9); the same idea applies to other release properties. |
| Unverified success states | No case found where the engine reports success it didn't achieve. The silent cases were "completed but did nothing" (KI-4) and the desktop "verified" flows that depend on dialogs only a person can click (documented in `docs/WORKFLOWS.md`). | Done for KI-4 |

## 7. Tests and gates run for this audit

| Check | Result |
| --- | --- |
| Server `npm test` | 217 pass, 0 fail (SQLite and PGlite/Postgres) |
| Client typecheck | Clean |
| Client vitest | 292 pass (53 files), including 2 new workflow tests |
| Desktop plugin `node --test` | 25 pass |
| Browser e2e, full suite | 54 of 55 passed; the WebGL avatar chat test timed out on an attribute check while the machine was busy, then passed when rerun (6 of 6 in chat.spec.ts) |
| Browser e2e: navigation, routing, workflows against a real server | 18 pass after the fixes |
| Audit gates (root, client, server; all and production-only) | No unexcepted findings; production dependencies have 0 findings |
| `client/electron` audit gate | Passes on macOS; the Windows path bug is fixed |
| Packaged-icon check | Passes on the current macOS package; fails on the v1.4.0 app, as it should |
| Versions, brand assets, native permissions, licences, secret scan | All pass |

## 8. Milestone 1: automation engine (2026-11-18)

### How a run flows (traced in the code)

1. **Editor:** `WorkflowEditor.tsx` saves drafts. `WorkflowApi.run` calls `POST /api/workflows/:id/run`.
2. **API:** `router.js` validates the workflow (`engine.validateWorkflow`) and checks the account owns it.
3. **Queue:** `runtime.enqueue` writes a `hannah_workflow_executions` row (`queued`) with the definition snapshotted.
4. **Worker:**
   - `runtime.startWorker` ticks every 5 s on a long-running server; Vercel uses `/api/workflows/tick`.
   - `tick` recovers expired leases, wakes due waits, fires schedules and polls mail.
   - It then `claim`s queued runs (a conditional update, with a lease), and `runClaimed` runs `engine.execute`.
5. **Persistence:** every step's checkpoint updates the execution's `state` and a `hannah_workflow_node_runs` row (status, attempts, input, output, error).
6. **Run page:** `ExecutionDetail.tsx` polls `GET /api/workflows/executions/:id`.
7. **Triggers:**
   - schedules: `hannah_workflow_triggers.next_run_at`;
   - webhooks: `/api/hooks/:id`, with token or HMAC and replay protection;
   - events: `emitEvent`;
   - mail and file uploads.

The structure was sound, so nothing was rebuilt. The failures found were specific: KI-1, KI-4, KI-15, KI-16, KI-17 and KI-18.

### Proof against real services

`node server/scripts/workflow-proof.mjs` starts the real server with a fresh database, then runs the milestone workflow:

> Manual trigger → HTTP request (GitHub's public API) → Process JSON (Code) → IF → Send notification → Save execution record (Create document)

Result on 2026-11-18: **7 of 7 checks passed.**

| Scenario | What happened |
| --- | --- |
| Success | `nodejs/node`, 123,868 stars, passed through every step; the notification was stored. |
| Failure | GitHub's 404 failed the run at the HTTP step, with GitHub's own message, after 1 attempt (a 4xx isn't retried). |
| Retry | httpbin's real 503 was tried 3 times with backoff (4 s), then reported "after 3 attempts". |
| Cancel | Cancelled during a Wait; the HTTP step never ran. |
| Restart | The server was killed with SIGKILL during a slow real request (`httpbin.org/delay/8`). After a restart the run was recovered (`recoveries: 1`) and finished 14 s after the kill. |
| History | All five runs and their steps were still recorded after the restart. |

### Automated tests added

- **Engine:** pause; rate limits; Aggregate on empty input; redaction.
- **API on SQLite and Postgres:**
  - pause during a real in-flight call, queued pause, cancel while paused, another account refused;
  - loop guards for webhooks and events;
  - recovery versus dead-lettering;
  - rate limits.
- **`server/workflows.restart.test.js`:** the real server process, killed with SIGKILL mid-HTTP-step and during a Wait, then restarted on the same database. It also runs the milestone workflow end to end.
- **Client:** live progress and empty stops.
- **Browser e2e:** a live run shows its step, is paused, resumed and completes.
