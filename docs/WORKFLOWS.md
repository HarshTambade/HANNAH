# Workflows: HANNAH's automation engine

Visual workflows that run on HANNAH's server: a trigger, then steps that read, decide, call AI models and act, connected on a canvas. This document covers what was wrong before, how the engine works, how to deploy it, its security model, and what isn't built yet.

## 1. Why the old automations failed

Investigated on 2026-11-17 with the real UI, the real client code and the real server (only Groq replaced by a local stand-in):

| Finding | Evidence | Fix |
| --- | --- | --- |
| Every cloud automation failed at its first AI step | The run showed **Failed**; `POST /api/agent` answered `400 {"error":"The agent tool schemas are invalid."}`. Automation steps deliberately run with no tools, and the server's `normalizeTools` rejected an empty list. The unit and browser tests mocked `/api/agent`, so they never saw it. The daily briefing step and its preview had the same failure. | `normalizeTools` accepts no tools (the provider runtime already omits an empty list). Regression test: `server/gateway.test.js` "accepts a turn with no tools", which fails against the old validator. The same automation now finishes **Done** through the UI. |
| Schedules only ran while HANNAH was open | The runner is a 30-second timer in the page (`AutomationService.ts`); there was no server worker, queue or scheduler. | The server engine below. Device routines remain for people without an account. |
| No conditions, branches, HTTP, webhooks or integrations | The step model was a fixed chain of four kinds. | The node registry below. |

## 2. Decision: a first-party engine, not n8n

n8n is licensed under the **Sustainable Use License**: use is allowed "only for your own internal business purposes or for non-commercial or personal use", and distribution only "free of charge for non-commercial purposes"; files marked `.ee.` need a separate n8n Enterprise License (from `LICENSE.md` in the n8n repository, checked 2026-11-17). Letting HANNAH's users build and run their own workflows inside HANNAH is outside those terms without a commercial embed agreement, whose price isn't public. A first-party engine also keeps HANNAH's security model (approvals, credential vault, account isolation) in one place. No n8n code, branding or interface assets are used. The canvas uses React Flow (`@xyflow/react`, MIT) and schedules use `croner` (MIT).

## 3. Architecture

```
Browser / desktop / mobile app                     HANNAH server (Express)
┌──────────────────────────────┐   REST    ┌────────────────────────────────────────────────┐
│ Automations screen            │ ───────► │ workflows/router.js   API, auth, validation      │
│  WorkflowEditor (React Flow)  │          │ workflows/engine.js   validate, plan, execute    │
│  Runs center, credentials     │ ◄─────── │ workflows/nodes.js    node registry + handlers   │
└──────────────────────────────┘  polling  │ workflows/runtime.js  queue, worker, scheduler,  │
                                            │                       triggers, services         │
Other services ── POST /api/hooks/:id ────► │ workflows/expressions.js  safe {{ }} language    │
Vercel Cron ───── /api/workflows/tick ────► │ workflows/http.js     SSRF-safe outbound HTTP    │
Gmail / Outlook ◄── polled by the tick ──── │ workflows/sandbox.js  Code step: QuickJS (WASM)  │
                                            │                       in a worker thread         │
                                            └──────────────┬─────────────────────────────────┘
                                                           │ account database (Postgres or SQLite)
                                                           ▼
                         hannah_workflows · _versions · _executions · _node_runs · _triggers
                         · _deliveries · _credentials (vault-encrypted) · hannah_notifications
```

The editor never runs a workflow. It saves a draft, asks the server to validate, test, publish or activate it, and reads runs back.

### Data model

- **Workflow**: a draft (edited, versioned with optimistic concurrency) and published versions (immutable history; one is live). Definition: `{ format: "hannah-workflow", version: 2, nodes, connections, settings: { timezone, timeoutMs } }`.
- **Node**: `{ id, name, type, params, position, credentialId?, disabled?, settings: { retries, retryDelayMs, timeoutMs, continueOnFail } }`.
- **Connection**: `{ source, sourceOutput, target, targetInput }`. Ports are named: If has `true`/`false`, Switch `case0…`/`otherwise`, Approval `approved`/`denied`, Merge inputs `input1`/`input2`.
- **Items**: data moves as a list of items `{ json }`. A node gets every item from its input and returns items per output port; parameters are resolved per item. A node that receives no items is skipped, and so is everything after it: that's how branches work. Loops are item-based (Split into items), so graphs are acyclic.

### Expressions

`{{ $json.amount > 1000 }}`, `{{ $node["Extract"].json.vendor }}`, `{{ addDays($now, 1) }}`. A small language parsed and interpreted by `expressions.js`; never `eval` or `Function`. It reads data and calls a fixed list of pure functions; it can't assign, loop, call methods on values or reach prototypes (`__proto__`, `constructor`), and evaluation has a step budget. A field that is exactly one expression keeps the value's type. Scope: `$json`, `$items`, `$node`, `$trigger`, `$now`, `$today`, `$execution`, `$workflow`, `$index`.

### Execution

1. **Validate** (`engine.validateWorkflow`): format, unique ids and names, known and available node types, required parameters (respecting `showIf`), select values, number ranges, patterns, expression syntax, schedule validity (5-minute minimum, valid time zone), credentials (present, owned, right type), port names, no trigger with inputs, no cycles; warnings for steps no trigger reaches and half-connected merges.
2. **Queue**: an execution row is the job (`status = queued`), with the definition snapshotted so later edits don't change a running workflow.
3. **Claim**: a worker moves `queued → running` with a conditional update and a 60-second lease, so two workers never run the same execution. A heartbeat renews the lease every 15 seconds and checks for a cancel request.
4. **Run** (`engine.execute`): topological order from the starting trigger. Per node: retries with exponential backoff and jitter (5xx, 429 and network errors; not 4xx or validation errors), a time limit, cancellation between items. A checkpoint (state + the step's sanitized input and output) is written after every node.
5. **Finish**: `completed`, `failed` (with the failing node and message), `cancelled`, `timed-out`, `waiting` (a timed wait or a resume URL) or `waiting-approval`.

Statuses: workflows are **draft**, **published** and **active** or **paused**; validation runs on every edit. Executions are **queued, running, waiting, waiting-approval, completed, failed, cancelled, timed-out**.

### Reliability guarantees

- **At-least-once per node, at-most-once for finished nodes.** A run that stops (worker crash, serverless freeze, wait, approval) continues from its last checkpoint; finished nodes never run again. The node that was mid-call when a worker died runs again, so HTTP steps can send an `Idempotency-Key` (`<execution>:<node>:<item>`). Exactly-once external effects are not claimed.
- **Recovery and dead-letter.** An expired lease puts the run back in the queue. After 3 recoveries it is marked failed as "dead-lettered" and never retried silently.
- **No silent success.** A failed node fails the run, unless that node is set to "continue on error"; then its error becomes its output and the run reads "completed with errors".
- **New mail starts one run per message.** Each check lists the newest matching messages and queues one execution per message that arrived since the last check, with the idempotency key `mail:<trigger>:<message id>`. The trigger's cursor (newest arrival seen plus recent message ids) lives in `hannah_workflow_triggers.state`. The first check after activation only records where the mailbox is, so old mail never starts runs; reactivating starts from that moment again. A failed check keeps the cursor and shows the error on the workflow.
- **Schedules fire once per slot.** Moving `next_run_at` forward is a conditional update, and each slot's execution has an idempotency key `sched:<trigger>:<slot>`. Missed runs: "run once when back" or "skip".
- **Webhooks don't run twice for one delivery.** `X-Hannah-Delivery` (or the HMAC signature) is recorded; a repeat returns `200 {duplicate: true}`.
- **Limits.** Per user: 3 concurrent runs (`WORKFLOW_USER_CONCURRENCY`), 500 runs a day (`WORKFLOW_DAILY_EXECUTIONS`), 200 workflows, 100 credentials. Per run: 5,000 items per node, 4 MB of state, node time limit up to 5 minutes, workflow limit up to 60 minutes. Webhooks: 60 requests a minute per hook, 120 per client address. Runs are kept 30 days.

## 4. Nodes

| Category | Nodes | Status |
| --- | --- | --- |
| Triggers | Manual, Schedule (interval, daily, weekly, cron; time zone), Webhook (token or HMAC), HANNAH event (reminder fired, team finished, budget exceeded, approval requested, workflow completed or failed, custom events), New email (Gmail or Outlook, optional search filter, checked every 5+ minutes), File uploaded (up to 1 MB; CSV and JSON can become one item per row) | Available |
| Actions | HTTP request, Send notification, Email (read newest, draft, send), Calendar (list, add), Slack, Discord, GitHub (issue, comment, list issues, list workflow runs), Notion page, Save to memory, Create or list reminders, Create document (Markdown or CSV) | Available |
| | PostgreSQL (parameterized SQL, read-only by default) | Beta |
| | Read a web page on your desktop, Coding task on your desktop (run by the signed-in desktop app; see "Desktop steps") | Beta |
| Logic | If, Switch, Filter, Merge, Split into items, Aggregate, Limit, Wait, Approval, Wait for webhook | Available |
| Data | Set fields, Map fields, Extract with pattern, Parse (JSON, CSV, key: value), Convert, Validate | Available |
| | Code (JavaScript in a sandbox; once for all items or once per item; console output kept with the run) | Beta |
| AI | Ask an AI model, Extract information (typed fields), Classify (one output per category), Search memory | Available |
| | Specialist agent (Research, Coding, Memory, Tasks; no device tools on the server) | Beta |

Each node declares its parameters (the editor renders them), ports, credential types, permissions, and one handler. Upcoming nodes are listed so people see what's planned, but validation refuses them, so a workflow can't be activated with a step that would only fail.

AI steps use the account's saved provider keys through the same gateway as chat (`requestWithProviderFallback`); with no key saved, they fail with a message saying where to add one. Server keys are used only when the operator allows it (`accountsUseServerKeys`).

### Desktop steps

"Read a web page on your desktop" and "Coding task on your desktop" run on the person's own computer, through the desktop app.

1. **The step queues a job.** On its first run, the step writes a row to `hannah_workflow_device_jobs`, and the execution waits (`waiting.kind = "device"`). The job id comes from the execution and step, so a retried step reuses it.
2. **A desktop app claims it.** The desktop app must be signed in to the same account, with **Run workflow tasks** turned on in Settings → Desktop access. Turning that on asks in a native dialog, and it's off by default. The app polls `GET /api/workflows/device-jobs` every 20 seconds and on focus. It claims a job with `POST …/:id/claim`, a conditional update, so only one device gets each job.
3. **The person approves it.** The desktop plugin asks in a native dialog before each task:
   - **Page reads:** the plugin checks the address first. It refuses this computer itself, link-local and metadata addresses, and flags local-network addresses in the dialog. It then opens the page in a hidden window with an in-memory session: no cookies, no Node.js, sandboxed, with no pop-ups, downloads or permissions. Requests to loopback addresses are cancelled, including requests made by the page's own scripts. Title, text, links and an optional screenshot go back to the workflow.
   - **Coding tasks:** the agent gets the desktop tools held to the one folder that was approved. Each file change and command still asks.
4. **It reports back.** `POST …/:id/complete` from the claiming device stores the result and resumes the execution. A decline or an error fails the step with that reason.
5. **It expires or is cancelled.** If no device finishes the job by the step's pickup time, the run times out with a message saying what's needed. Cancelling the run withdraws the job.

Verified by:
- **Server:** claim races, the wrong device, other accounts, success, decline, cancel and expiry, on SQLite and Postgres.
- **Plugin core:** address rules, the setting and the dialogs.
- **The page reader in real Electron 45:** JavaScript-rendered text, the screenshot, a blocked pop-up, and a page's own request to localhost that never arrived.
- **The app's job runner:** unit tests.

The full chain on a desktop with a person clicking the dialogs hasn't been run end to end. The dialogs can't be automated without a bypass, and adding one would be a security hole.

## 5. Security

- **Ownership.** Every query filters by the signed-in user. Workflows, runs, node data, triggers, credentials and notifications are invisible and unusable across accounts (tested, including using another account's credential id).
- **Permissions and consent.** Each workflow has a permission manifest (network, send email, AI, memory write …). Activation sends back exactly the manifest the user reviewed; publishing a version that changes it pauses the workflow until it's approved again. Imports and AI-drafted workflows are always inactive drafts. Activations are written to the account's security log.
- **Approval per run.** Sending email asks every time unless the user allowed "send without asking" at activation (shown as its own permission). The Approval node pauses for anyone's yes or no.
- **Credentials.** Encrypted with the vault key (AES-GCM envelope, `HANNAH_VAULT_KEY`), bound to the user and credential id. They're never returned by the API, never in workflow JSON, exports, runs or logs; the list shows a hint only. Imports drop credential references the importer doesn't own.
- **Outbound requests (SSRF).** Only http and https; the address is checked when the socket connects (no DNS rebinding); loopback, private, link-local and metadata (169.254.169.254), carrier-grade NAT, multicast and reserved ranges are refused for IPv4, IPv6 and mapped addresses; redirects are re-checked and drop credentials when the host changes; responses are capped. The PostgreSQL node resolves its host the same way. Self-hosters can allow their own network with `WORKFLOW_ALLOW_PRIVATE_NETWORK=true`.
- **Webhooks.** Unguessable ids; a secret token (stored as a hash) or HMAC-SHA256 over `timestamp.body` with a 5-minute window and replay protection; rate limits; only safe headers are passed to the workflow. Secrets are shown once and can be rotated.
- **Untrusted data.** Expressions can't execute code. External responses, email and AI outputs are data; AI prompts label them as such.
- **The Code step's sandbox.** User JavaScript never runs on the server's JavaScript engine:
  - It runs in QuickJS compiled to WebAssembly, a separate engine with its own heap, started fresh for each run in its own worker thread. The worker gets an empty environment.
  - The code can reach nothing: no `require`, `process`, network, file system, timers or credentials. It sees only the step's input items. The only bridge back is a `console.log` that copies strings out.
  - **Limits:** 2 seconds of execution (QuickJS's interrupt handler, plus a hard terminate of the worker), 32 MB for the engine, and 1 MB of output. The WebAssembly memory has a fixed maximum, because QuickJS's own memory limit doesn't count every string allocation (we measured a 200 MB string build passing it). With the fixed memory, the same code fails with "out of memory".
  - Running code is its own permission (`run-code`), shown before activation.
  - Tested: escapes through the `Function` constructor, endless loops, memory bombs, syntax errors.
- **Redaction.** Node data shown in the UI masks keys that look sensitive (`authorization`, `token`, `password`, `apiKey` …) and values that look like keys or card numbers.

## 6. Deploying

Workflows need the account database.

| Setting | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres (Supabase, Neon, any host) or SQLite. Migration 6 creates the workflow tables on start. |
| `HANNAH_VAULT_KEY` | 64 hex characters. Encrypts credentials and HMAC webhook secrets. |
| `CRON_SECRET` | 16+ characters. Authenticates `/api/workflows/tick` on serverless hosting. |
| `WORKFLOW_WORKER=off` | Don't run the in-process worker (for example when a separate process drives the tick). |
| `WORKFLOW_USER_CONCURRENCY`, `WORKFLOW_WORKER_CONCURRENCY`, `WORKFLOW_DAILY_EXECUTIONS` | Limits (defaults 3, 4, 500). |
| `WORKFLOW_ALLOW_PRIVATE_NETWORK=true` | Self-hosting only: let workflows reach your own network. |
| `HANNAH_PUBLIC_URL` | The public origin used in webhook URLs, when the server sits behind a proxy. |

**Long-running server** (self-hosted, Docker, the desktop dev server): the worker runs inside the server every 5 seconds. Nothing else is needed.

**Vercel** has no background process. Three things drive work instead: (1) a webhook runs its execution inside the request before answering (up to about 15 seconds); (2) an open execution page drives its own run while you watch; (3) a cron calls `GET /api/workflows/tick` with `Authorization: Bearer $CRON_SECRET` to fire schedules, wake waits and recover stalled runs. Add to `vercel.json`:

```json
"crons": [{ "path": "/api/workflows/tick", "schedule": "*/5 * * * *" }]
```

Vercel's Hobby plan allows only daily cron jobs (a more frequent schedule fails the deployment), so on Hobby use an external scheduler (for example cron-job.org or a GitHub Actions schedule) to call the tick URL every few minutes with the bearer header. Runs longer than the function's time limit continue across ticks from their checkpoints.

## 7. Testing

- `server/workflows/engine.test.js`: expressions (including sandbox escapes), SSRF checks, validation, schedules across time zones, data passing, branching, retries with backoff, continue-on-error, cancellation, approvals, email approval and denial, resume without re-running, split, filter and aggregate, single-node tests, redaction.
- `server/workflows.test.js` (SQLite) and `server/workflows.pglite.test.js` (Postgres): the API end to end with the real worker: draft versioning, validation errors pointing at nodes, token and HMAC webhooks with replay protection, AI extraction, notifications, retries and retry-from-failure, cancel while waiting and while running, approvals, crash recovery and dead-lettering, schedules firing once per slot with two workers ticking at once, event chaining, account isolation, credential secrecy, import and export, the cron secret.
- `server/workflows.test.js` also covers:
  - **New email:** against a Gmail stand-in. The first check only records the mailbox; one run per new message even with two workers checking at once; the body is read; a failed check is shown and doesn't re-run handled mail.
  - **File uploads:** CSV rows, quoted commas, base64 for binary files, the 1 MB limit, and other accounts refused.
  - **Code step:** items, per-item mode, console logs, escape attempts, endless loop, memory bomb, the `run-code` permission.
- `e2e/workflows.spec.ts`: a browser against a real server process:
  - Build a workflow in the editor, test-run it and see data on the canvas.
  - Run the invoice template from a real webhook.
  - See a failure with its exact error and retry it.
  - Test-run a file workflow with a CSV from the editor, see the Code step's console, activate it and upload a file from the list.
- `client/src/__tests__/WorkflowTemplates.test.ts`: every template passes the server's validator, except for credentials and fields its "needs" list asks you to supply.

## 8. Not built yet

- Database change triggers. New email uses polling (every 5+ minutes), not Gmail push or Graph subscriptions.
- Full computer use (screen, mouse, keyboard) as a workflow step. Desktop steps read pages and work in shared folders only.
- Packages in the Code step: plain JavaScript only, no npm modules or network.
- OAuth for integrations beyond Google and Microsoft (Slack, GitHub and Notion use tokens or webhook URLs today).
- Workspace sharing: workflows belong to one account.
- Push notifications when HANNAH isn't open: workflow notifications appear in the app and as the `workflow.notification` webhook event, which you can forward to ntfy or Pushover.
