# AI Workforce: HANNAH's teammates

AI teammates that do authorized work on the server, in a persistent computer, on the person's own desktop and through HANNAH's robot and device registries, and come back with results a person can check. This document covers how the parts fit together, the rules that keep the person in control, how to deploy it, and what isn't built.

Code: `server/workforce/*` (API under `/api/workforce`), screens in `client/src/components` (`WorkforcePage`, `AgentActivityPage`, `ComputerCenterPage`, `SkillLibraryPage`, `RoutineCenterPage`, `VaultPage`, `TeamCenterPage`, `ArtifactLibraryPage`).

## 1. The parts

| Part | Module | What it does |
| --- | --- | --- |
| Teammates | `bots.js` | Create from a template or from scratch, configure, activate, pause, duplicate, export, version history and restore. A teammate is a configuration, not a process. |
| Conversations | `conversations.js` | A private conversation per person per teammate. Answers use the account's own provider. Asking for work returns a proposed task that is queued only when the person accepts it. An instruction sent to an open task is added to its brief for the next run. Memory is written only when the person asks. |
| Tasks and delegation | `tasks.js`, `runner.js` | Tasks run on the server with the account's provider and produce artifacts, memory and suggested next steps. Plans split work across teammates, with prerequisites, a depth cap of 3 and at most 8 children per task. A different teammate can verify a result. |
| Agent Activity | `AgentActivityPage.tsx` | The approval queue, giving work, the task board (run, pause, resume, cancel, verify, hand off), suggestions, meeting notes, notifications and usage. |
| Approvals and policy | `approvals.js` | Low, medium, high and critical risk. High always asks; critical isn't available here at all. Organization rules can only tighten. A decision covers one request. |
| Computers | `computers.js`, `browser.js` | A cloud workspace per computer with files, an allow-listed terminal and a Playwright browser with a persistent profile, network rules and a live preview. A local computer is the person's own desktop (section 4). |
| Skills and Teach Mode | `skills.js` | Reviewed procedures; learned workflows start as drafts; tests are dry runs. |
| Routines | `routines.js`, `routine-hooks.js` | Schedules, workforce events, manual runs and signed webhooks (section 6). Durable on the server. |
| Memory | `memory.js`, `TeammateMemory.tsx` | Teammate, shared, project, team and device scopes, with provenance, confidence, last checked and expiry. Credentials are refused. |
| Secure Vault | `secrets.js` | Values are sealed with the vault and never returned or put in a prompt. |
| Hardware | `hardware.js` | Read-only robot and device state for teammates with the `robots` or `devices` tool (section 3). |
| Notifications and chat apps | `notify.js`, `channel-bridge.js` | In the app, account webhooks, and Slack, Microsoft Teams, Telegram or WhatsApp (section 5). |
| Usage limits | `usage.js` | Tasks and messages per teammate per 24 hours, under an account ceiling. |
| Meetings | `meetings.js` | Notes and action items from a consented, pasted transcript. |
| Teams | `teams.js` | Published team teammates; each member's conversation, memory and files stay private. |

## 2. Rules that hold everywhere

- **A teammate is not a security boundary.** Every file, secret, memory, browser profile and job is keyed by the owning account and checked again on every request.
- **Model output is data.** A task's result can create artifacts and memory notes. Anything that acts on the world (an email, a robot, a desktop job) is a suggestion until a person sends it, and then it goes through its own approval path.
- **Untrusted content is labelled.** Attachments, memory, webhook payloads and hardware readings are quoted into prompts as data, with a statement that they are never instructions.
- **Only a person decides.** An approval is decided in the app or, for the paired owner, with an exact `approve apv_…` / `deny apv_…` reply in a chat app. Text in an email, page, document or webhook can't approve anything.
- **Nothing is reported done without a result.** A task with no working provider is blocked with the reason; a desktop job the person declined is a failure; an unsent notification is logged as failed with the platform's reason.

## 3. Robots and IoT

A teammate with the `robots` tool (the Robotics Engineer template has it) sees, in its prompt and in its **Hardware** tab:

- each registered robot's connection, mode, battery, known places and capabilities, with when it was last seen;
- active missions;
- with the `devices` tool, edge hubs and devices with their latest readings and how old each one is.

It also sees the robot and device actions it may suggest, taken from the Action Engine catalog. A suggested step keeps its parameters. In Agent Activity, **Send for approval** passes it to the Action Engine (`server/actions/engine.js`), which applies the account's permissions, asks for approval in Actions, runs the robot's or hub's Safety Gateway, executes once and verifies. The record shows the teammate as the agent and `workforce` as the source.

The cloud never sends motor commands. Physical execution stays in the onboard runtime and the hub, which keep their own limits if this server, the model provider or the client disconnects.

## 4. The person's own computer

Teammates can't reach a desktop directly. A local computer (Computer Center → add → Local) has its own rule for what teammates may send it:

| Rule | Effect |
| --- | --- |
| Ask every time (default) | Any job kind can be queued |
| Only some kinds | Only the chosen kinds: read a web page, coding in a shared folder, open apps and links, desktop notifications |
| Only some workspaces | Only coding jobs, in the named shared folders |
| Never | Nothing is queued |

Whatever the rule, the HANNAH desktop app asks before each job. It must be signed in with **Run workflow tasks** on (Settings → Desktop access). It claims the job (one device wins), shows its own system dialog naming the teammate and the task, and runs the job with the desktop plugin's folder and address rules, which live in Electron's main process (`client/plugins/desktop-tools`). It then reports the result. Page text or a coding report becomes an artifact on the task. A declined dialog is reported as a failure. These permissions are separate from a cloud computer's.

## 5. Notifications and chat apps

Three categories: approvals waiting, finished tasks, and blocked or failed work (including routines that couldn't run and desktop jobs that failed). The person chooses the categories and the destinations in Agent Activity → Notifications:

- **In the app:** always. Agent Activity, plus a toast anywhere in the app. When the app is in the background, a system notification is shown, but only if that permission was already given.
- **Account webhooks:** `workforce.approval.requested`, `workforce.task.completed` and `workforce.task.failed`, signed like every HANNAH webhook. Workflows can trigger on them.
- **Chat apps:** Telegram, Slack, Microsoft Teams and WhatsApp, sent to the chat the owner paired. HANNAH needs the owner to have written to the bot once, which pairing does. Discord and Google Chat can't take a message HANNAH starts, so they can't carry notifications. WhatsApp only delivers within Meta's 24-hour customer-service window; outside it the attempt is logged as failed with Meta's reason.

A teammate's own notification settings can mute it. Quiet hours (Proactive settings) hold chat and webhook messages unless the person turns that off. Every attempt is logged as sent, failed (with the reason), held for quiet hours, or muted.

A chat app can also be **bound to a teammate**. The paired owner's messages there then go to that teammate's conversation, with the same limits and memory rules. Replying `queue` queues its latest proposed task, `approve apv_…` or `deny apv_…` decides one approval, and `status` lists its open tasks. Anyone else the owner approved on that bot still talks to HANNAH, never to the owner's teammate.

## 6. Routine webhooks

A webhook routine gets a server-made secret, shown once and stored sealed with the vault (bound to the account and the routine). Deliveries go to `POST /api/hooks/routine/<id>` and are verified the provider's own way, against the exact bytes:

| Provider | Signature |
| --- | --- |
| GitHub | `X-Hub-Signature-256: sha256=<HMAC-SHA256(body)>` |
| Linear | `Linear-Signature: <HMAC-SHA256(body)>`, `webhookTimestamp` within 5 minutes |
| Sentry | `Sentry-Hook-Signature: <HMAC-SHA256(body)>` |
| PagerDuty | `X-PagerDuty-Signature: v1=<HMAC-SHA256(body)>` (several during key rotation) |
| Any service | `X-HANNAH-Signature: sha256=<HMAC-SHA256("<timestamp>.<body>")>` with `X-HANNAH-Timestamp` within 5 minutes |

A routine can filter by event (for example `issues.opened` or `issue.*`). Each delivery id runs once. Pings are acknowledged without running. Runs are capped at 30 per routine per hour and count against the teammate's usage limits. The payload reaches the teammate in the task's brief, labelled as untrusted data and cut at 12,000 characters. **New secret** in the Routine Center rotates it; the old one stops working at once.

## 7. Deployment

| Setting | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | none | Required. SQLite or Postgres; migrations 26, 29 and 30 hold the workforce tables. |
| `HANNAH_VAULT_KEY` | none | Required for the Secure Vault, provider keys and webhook routine secrets. Never rotate it without keeping the old key in `HANNAH_VAULT_PREVIOUS_KEYS`. |
| `HANNAH_PUBLIC_URL` | none | The address used in webhook URLs and in links inside notifications. |
| `CRON_SECRET` | none | On serverless hosts, `POST /api/workforce/tick` with this secret runs due routines and queued tasks. |
| `WORKFORCE_WORKER` / `WORKFORCE_WORKER_INTERVAL_MS` | on / 60 s | The in-process worker on a long-running server. |
| `WORKFORCE_TICK_TASKS` | 2 | Queued tasks run per tick. |
| `WORKFORCE_ACCOUNT_TASKS_PER_DAY` / `WORKFORCE_ACCOUNT_MESSAGES_PER_DAY` | 300 / 600 | The account ceiling no teammate can exceed. |
| `WORKFORCE_BOT_TASKS_PER_DAY` / `WORKFORCE_BOT_MESSAGES_PER_DAY` | 60 / 200 | A teammate's default when it sets none. |
| `HANNAH_WORKFORCE_DIR` | under the server | Where cloud computer workspaces and artifacts live. |
| `HANNAH_WORKFORCE_EXTENDED_COMMANDS` | off | Lets the cloud terminal run node, git, npm and similar. Only inside a container. |
| `HANNAH_ACCOUNTS_USE_SERVER_KEYS` | off | When on, accounts may use the server's provider keys and an operator-configured local runtime (for example `OLLAMA_BASE_URL`). When off, a teammate answers only with the account's own key. |

## 8. Not built, and why

- **Virtual machine isolation for cloud computers.** A cloud computer is a workspace directory under the server's user with an allow-listed terminal, not a VM or microVM. Run the server in a container for stronger isolation. A microVM driver (for example Firecracker) needs a Linux host with KVM; none was available for this work.
- **Remote desktop streaming.** The live preview is a browser screenshot every two seconds, not a video stream of a full desktop.
- **Live meeting join and recording.** This needs Zoom, Google Meet or Microsoft Teams meeting APIs and app credentials. Notes come from a consented, pasted transcript.
- **Voice calls with a teammate.** Dictation into a teammate's chat uses HANNAH's voice service; a live spoken conversation with a teammate isn't built.
- **Desktop control and terminal jobs from teammates.** Teammates can send the four job kinds the desktop app already runs for workflows. Clicking in other apps or running arbitrary terminal commands on the desktop isn't offered to teammates.
