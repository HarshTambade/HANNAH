# AI Workforce: HANNAH's teammates

AI teammates that do authorized work on the server, in a persistent computer, on the person's own desktop and through HANNAH's robot and device registries, and come back with results a person can check. This document covers how the parts fit together, the rules that keep the person in control, how to deploy it, and what isn't built.

Code: `server/workforce/*` (API under `/api/workforce`), screens in `client/src/components` (`WorkforcePage`, `AgentActivityPage`, `ComputerCenterPage`, `SkillLibraryPage`, `RoutineCenterPage`, `VaultPage`, `TeamCenterPage`, `ArtifactLibraryPage`).

## 1. The parts

| Part | Module | What it does |
| --- | --- | --- |
| Teammates | `bots.js` | Create from a template or from scratch, configure, activate, pause, duplicate, export, version history and restore. A teammate is a configuration, not a process. |
| Conversations | `conversations.js`, `TeammateCall.ts` | A private conversation per person per teammate, typed or spoken (**Talk**). Answers use the account's own provider. Asking for work returns a proposed task that is queued only when the person accepts it. An instruction sent to an open task is added to its brief for the next run. Memory is written only when the person asks. |
| Tasks and delegation | `tasks.js`, `runner.js` | Tasks run on the server with the account's provider and produce artifacts, memory and suggested next steps. Plans split work across teammates, with prerequisites, a depth cap of 3 and at most 8 children per task. A different teammate can verify a result. |
| Agent Activity | `AgentActivityPage.tsx` | The approval queue, giving work, the task board (run, pause, resume, cancel, verify, hand off), suggestions, meeting notes, notifications and usage. |
| Approvals and policy | `approvals.js` | Low, medium, high and critical risk. High always asks; critical isn't available here at all. Organization rules can only tighten. A decision covers one request. |
| Computers | `computers.js`, `browser.js`, `sandbox.js` | A cloud workspace per computer with files, an allow-listed terminal under the host's sandbox, and a Playwright browser with a persistent profile, network rules and a live stream the person can take control of (section 4). A local computer is the person's own desktop (section 5). |
| Skills and Teach Mode | `skills.js` | Reviewed procedures; learned workflows start as drafts; tests are dry runs. |
| Routines | `routines.js`, `routine-hooks.js` | Schedules, workforce events, manual runs and signed webhooks (section 7). Durable on the server. |
| Memory | `memory.js`, `TeammateMemory.tsx` | Teammate, shared, project, team and device scopes, with provenance, confidence, last checked and expiry. Credentials are refused. |
| Secure Vault | `secrets.js` | Values are sealed with the vault and never returned or put in a prompt. |
| Hardware | `hardware.js` | Read-only robot and device state for teammates with the `robots` or `devices` tool (section 3). |
| Notifications and chat apps | `notify.js`, `channel-bridge.js` | In the app, account webhooks, and Slack, Microsoft Teams, Telegram or WhatsApp (section 6). |
| Usage limits | `usage.js` | Tasks and messages per teammate per 24 hours, under an account ceiling. |
| Meetings | `meetings.js`, `LiveMeetingNotes.tsx` | Live notes from the person's own device, or a pasted transcript, with consent; then notes and action items (section 8). |
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

## 4. Cloud computers: live view and isolation

**Live view.** Computer Center → a session → **Live view** streams the session's browser: Chromium's own screencast, sent as Server-Sent Events (`GET /api/workforce/sessions/<id>/stream`). Everyone watching a computer shares one screencast. A stream lasts up to 10 minutes and the viewer reconnects.

**Take control.** Watching is read-only. **Take control** (`POST /api/workforce/sessions/<id>/handoff`) puts the session in "waiting for a person" and holds the browser: teammate and skill browser actions are refused until the person chooses **Hand back**. While they hold it, their clicks, scrolling, keys and typing go to the page (`POST /api/workforce/sessions/<id>/input`, coordinates as fractions of the page). Only a signed-in person can send input. Input is rate limited, and the session's activity records that input happened, never what was typed. The stream and the hold live in the server process, so they need a long-running server (they don't work on serverless functions).

**Terminal isolation.** Terminal commands run under the host's sandbox when one passes a check:

| Host | Driver | What a command can't do |
| --- | --- | --- |
| macOS | `sandbox-exec` | open any network connection; write outside its workspace; read or list other workspaces; read the server's folder |
| Linux | bubblewrap (`bwrap`) | the same, with new user, process, network, IPC and host namespaces; only the system folders (read-only) and its workspace are visible |

Before a driver is used, the server runs a real program under it with the same rules. The program must be able to write in its workspace, and writing outside, reading another workspace, listing them, reading the server's folder and connecting to the network must all fail. A driver that fails the check isn't used. The Computer Center's capabilities (`GET /api/workforce/computers/capabilities`) show the driver and the check's results, or why there's none. `HANNAH_WORKFORCE_SANDBOX` is `auto` (default), `off`, or a driver's name. Naming a driver makes it required: if it's missing or fails the check, commands are refused, not run unsandboxed. This is process isolation in the host's kernel, not a virtual machine (section 11).

## 5. The person's own computer

Teammates can't reach a desktop directly. A local computer (Computer Center → add → Local) has its own rule for what teammates may send it:

| Rule | Effect |
| --- | --- |
| Ask every time (default) | Any job kind can be queued |
| Only some kinds | Only the chosen kinds: read a web page, coding in a shared folder, open apps and links, desktop notifications |
| Only some workspaces | Only coding jobs, in the named shared folders |
| Never | Nothing is queued |

Two more kinds are off on every local computer until the person turns them on for it (**Also allow** in the Computer Center), whatever its rule:

- **Terminal commands:** one exact command in a named shared folder, run without a shell (no pipes, redirects, `&&` or variables). The desktop shows the command and the teammate every time. "Always allow" never applies to a teammate's command. Under "Only some workspaces", only in the listed folders.
- **Desktop control:** using the person's apps for a task with a short plan. The desktop asks the person to allow a timed control session. Every action is taken on a fresh look at the screen and checked afterwards. Anything that sends, deletes, buys or posts asks again, and so does every action in a terminal or System Settings. It never types passwords, never pays, and stops at once from the menu bar or its shortcut. The job counts as done only when the screen confirmed the last action. The session always ends with the job. Desktop control is available in the macOS desktop app.

A teammate is told about these kinds only on computers where they're on, and a suggested terminal or control step is high risk. The person sees the exact command or the plan before sending it.

Whatever the rule, the HANNAH desktop app asks before each job. It must be signed in with **Run workflow tasks** on (Settings → Desktop access). It claims the job (one device wins), shows its own system dialog naming the teammate and the task, and runs the job with the desktop plugin's folder and address rules, which live in Electron's main process (`client/plugins/desktop-tools`). It then reports the result. Page text or a coding report becomes an artifact on the task. A declined dialog is reported as a failure. These permissions are separate from a cloud computer's.

## 6. Notifications and chat apps

Three categories: approvals waiting, finished tasks, and blocked or failed work (including routines that couldn't run and desktop jobs that failed). The person chooses the categories and the destinations in Agent Activity → Notifications:

- **In the app:** always. Agent Activity, plus a toast anywhere in the app. When the app is in the background, a system notification is shown, but only if that permission was already given.
- **Account webhooks:** `workforce.approval.requested`, `workforce.task.completed` and `workforce.task.failed`, signed like every HANNAH webhook. Workflows can trigger on them.
- **Chat apps:** Telegram, Slack, Microsoft Teams and WhatsApp, sent to the chat the owner paired. HANNAH needs the owner to have written to the bot once, which pairing does. Discord and Google Chat can't take a message HANNAH starts, so they can't carry notifications. WhatsApp only delivers within Meta's 24-hour customer-service window; outside it the attempt is logged as failed with Meta's reason.

A teammate's own notification settings can mute it. Quiet hours (Proactive settings) hold chat and webhook messages unless the person turns that off. Every attempt is logged as sent, failed (with the reason), held for quiet hours, or muted.

A chat app can also be **bound to a teammate**. The paired owner's messages there then go to that teammate's conversation, with the same limits and memory rules. Replying `queue` queues its latest proposed task, `approve apv_…` or `deny apv_…` decides one approval, and `status` lists its open tasks. Anyone else the owner approved on that bot still talks to HANNAH, never to the owner's teammate.

## 7. Routine webhooks

A webhook routine gets a server-made secret, shown once and stored sealed with the vault (bound to the account and the routine). Deliveries go to `POST /api/hooks/routine/<id>` and are verified the provider's own way, against the exact bytes:

| Provider | Signature |
| --- | --- |
| GitHub | `X-Hub-Signature-256: sha256=<HMAC-SHA256(body)>` |
| Linear | `Linear-Signature: <HMAC-SHA256(body)>`, `webhookTimestamp` within 5 minutes |
| Sentry | `Sentry-Hook-Signature: <HMAC-SHA256(body)>` |
| PagerDuty | `X-PagerDuty-Signature: v1=<HMAC-SHA256(body)>` (several during key rotation) |
| Any service | `X-HANNAH-Signature: sha256=<HMAC-SHA256("<timestamp>.<body>")>` with `X-HANNAH-Timestamp` within 5 minutes |

A routine can filter by event (for example `issues.opened` or `issue.*`). Each delivery id runs once. Pings are acknowledged without running. Runs are capped at 30 per routine per hour and count against the teammate's usage limits. The payload reaches the teammate in the task's brief, labelled as untrusted data and cut at 12,000 characters. **New secret** in the Routine Center rotates it; the old one stops working at once.

## 8. Meetings

HANNAH doesn't join a Zoom, Google Meet or Microsoft Teams call as a participant (section 11). A meeting's notes come from one of two places:

- **Live notes from this device.** The meeting must have been added with consent to record and transcribe. Starting needs a fresh confirmation that everyone present knows and agreed. The browser asks for the microphone. It records complete pieces of about 20 seconds and sends them in order. The server transcribes each piece with the account's own Groq key (Whisper), appends a timestamped line, and keeps only the text: the audio is never stored. A retried piece isn't transcribed twice. A refused piece (the meeting ended, no key) stops the recording. While live, the transcript can't be pasted over or summarized. Live notes stop after 4 hours.
- **A pasted transcript,** with the same consent.

Then a model writes a summary, decisions, risks and action items from the transcript only. An action item becomes a task when the person chooses a teammate for it.

## 9. Talking with a teammate

**Talk** in a teammate's chat is a spoken conversation using HANNAH's voice service. After a pause, what the person said is sent as an ordinary conversation message, with the same limits and memory rules. The answer is spoken with the microphone off, so the teammate never hears itself. Long answers are cut short with a pointer to the chat. A proposed task is mentioned but never queued by voice; it waits in the chat. Saying "end call" hangs up without sending anything. A refused message, such as one over the usage limit, is said aloud and ends the call.

## 10. Deployment

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
| `HANNAH_WORKFORCE_DIR` | `~/.hannah/workforce` | Where cloud computer workspaces and artifacts live. |
| `HANNAH_WORKFORCE_EXTENDED_COMMANDS` | off | Lets the cloud terminal run node, git, npm and similar. Only with a working sandbox or inside a container. |
| `HANNAH_WORKFORCE_SANDBOX` | auto | The terminal's sandbox driver: `auto`, `off`, `sandbox-exec` or `bwrap`. Naming one makes it required (section 4). |
| `HANNAH_ACCOUNTS_USE_SERVER_KEYS` | off | When on, accounts may use the server's provider keys and an operator-configured local runtime (for example `OLLAMA_BASE_URL`). When off, a teammate answers only with the account's own key. |

## 11. Not built, and why

- **Virtual machine isolation for cloud computers.** The terminal runs under the host's sandbox (section 4), which is process isolation, not a VM or microVM. A microVM driver (for example Firecracker) needs a Linux host with KVM; none was available for this work. The bubblewrap driver was written and its arguments are tested, but it wasn't run on a Linux host. The server's own check decides whether it's used there, and it isn't used if the check fails.
- **Joining a call as a participant.** Joining or recording Zoom, Google Meet or Microsoft Teams from their side needs those platforms' meeting APIs and app credentials. Live notes record the person's own device instead (section 8).
- **A whole remote desktop.** A cloud computer has a browser and a terminal, not a desktop, so the live view streams the browser.
- **Full-duplex voice.** Talk takes turns: the microphone is off while the teammate speaks, and interrupting is a button, not speech. Speech recognition is the browser's or the device's own.
- **Desktop control outside macOS.** The desktop app's control tools have a macOS adapter only.
