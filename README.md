# HANNAH — Your AI Companion

<p align="center">
  <strong>A private, emotion-aware AI companion with a living 3D avatar. No paid tiers. Bring your own key. Every action reviewed.</strong>
</p>

<p align="center">
  <a href="https://github.com/HarshTambade/HANNAH/actions/workflows/build.yml"><img src="https://github.com/HarshTambade/HANNAH/actions/workflows/build.yml/badge.svg" alt="Build status"></a>
  <a href="https://github.com/HarshTambade/HANNAH/releases/latest"><img src="https://img.shields.io/github/v/release/HarshTambade/HANNAH" alt="Latest release"></a>
  <a href="https://github.com/HarshTambade/HANNAH/issues"><img src="https://img.shields.io/github/issues/HarshTambade/HANNAH" alt="Open issues"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-source--available-orange" alt="Source-available license"></a>
</p>

HANNAH (formerly **Shanaya**) is a source-available AI companion for the web, Android, iOS, macOS, Windows and Linux. You talk to her in a chat beside a real-time 3D avatar that reacts to the emotion of each reply. She can remember what you ask her to remember, use a small set of device tools, and run on a cloud model, a local server, or entirely on your device.

Three rules shape the product:

1. **No monetization.** There are no subscriptions, premium tiers, paywalls or ads in the app.
2. **Bring your own key (BYOK).** Paste your own free Groq key and start talking: no account, no sign-up. An operator access token is optional. Keys are kept for the browser tab session only.
3. **Nothing runs unchecked.** Every tool call is reviewed by the **GuardianAgent** first, and anything that changes your device or data also waits for **your approval**.

> **Status:** active development. The latest release is [v1.8.0](https://github.com/HarshTambade/HANNAH/releases/tag/v1.8.0). `main` is version **1.8.0**. What's new in 1.8.0 (see [1.8.0 in the changelog](./docs/CHANGELOG.md)):
> - **robots (beta)**: a robot registry, a capability contract, a Safety Gateway on the server and on the robot, and a runtime for the robot's own computer. Ask a robot to drive somewhere, inspect a route, take a picture or move an arm; every request is checked, approved by you and verified from the robot's own state;
> - plans of several steps under one approval, a fleet view that picks the nearest ready robot and says why, commissioning for physical robots, a Robots screen, four robot agents and 30 robot tools;
> - **tested with HANNAH's built-in simulators only.** The ROS 2 and Gazebo files are written and have not been run, no physical robot has been connected, and HANNAH is not safety-certified. See [Robots](#robots);
> - migrations 18 to 21 (eight new tables on first start).
>
> **On `main`, not in a release yet — devices (beta):** a hub you run on your own network (HANNAH Edge) that speaks MQTT, Modbus TCP and HTTP to lights, plugs, sensors and meters; adding a device from a list, from its manual or with a form, with no code; a Devices screen; automations the hub runs by itself. Read-only discovery of USB, serial, mDNS and MQTT services, QR-code profile lookup and a dependency-free device SDK have since been added. **Tested with HANNAH's own simulated devices only**: no physical device has been connected, no real product's profile ships, and there is no HANNAH OS image to install. See [Devices](#devices).
>
> **New on `main` — HANNAH Robot OS (in progress, not a shipped feature):** a Linux-based, AI-native operating environment for robot hardware that reuses HANNAH's model gateway, agents, safety gateways and robotics runtime. The architecture and the first implementation slices are in place (the tracker marks the programme **IN_PROGRESS** at Phase 0/1): service and safety boundaries, boot/READY design, motor-controller and sensor managers, a latched software stop shared by every service, signed updates, and an outbound-only gateway, verified at **unit/simulation/smoke level (62 tests)**. No OS image has been built or booted, ROS 2/Gazebo/Nav2 has not been run, no physical robot has been commissioned, and no safety certification is claimed. See [HANNAH Robot OS](#hannah-robot-os).
>
> **New on `main` — AI Workforce (beta):** AI teammates with a role, instructions and their own memory that take tasks, work on a cloud computer (files, a sandboxed terminal and a real browser you can watch and take over) or, with your permission, on your own desktop, talk by voice, take live meeting notes, learn skills from a demonstration, run on schedules or events, share credentials only through a Secure Vault, and wait for your approval before anything risky. Needs an account. See [AI Workforce](#ai-workforce).
>
> **Security hardening on `main`:** one address check behind every outbound request (internal, cloud-metadata and every IPv6 spelling refused), a checking proxy for the workforce browser, sandboxed artifacts, sign-in limits shared across server instances, an account confirmation for Google and Microsoft sign-ins finished outside the web app, and owner-set robot limits enforced on the robot itself. See [Other guardrails](#other-guardrails).
>
> **Also new on `main`:** Azure OpenAI, Amazon Bedrock and Hugging Face model gateways bring the provider catalog to **23**. See [Configuration](#configuration).
>
> 1.7.0 added one Action Engine that asks permission, runs an action once, reads back the result and keeps the record; calendar, email and messaging through it; and a coding service over GitHub or a local repository.
>
> Earlier releases: [1.5.1](./docs/CHANGELOG.md) (agents and skills that do visible work, integration tests, a home page) and [1.5.0](./docs/CHANGELOG.md) (web research and documents, connectors and chat apps, web search, macOS app control, Vercel and Supabase setup, command sandbox, CLI, Docker, plugin kit, phone and desktop workflows, mail and Google Chat, "Hey HANNAH", memory updates).
>
> See [Project status](#project-status) for what is finished, what is experimental, and what still needs a real-device run.

---

## Contents

- [Downloads](#downloads)
- [What you can do](#what-you-can-do)
- [The safety model: Guardian, then you](#the-safety-model-guardian-then-you)
- [Visual overview](#visual-overview)
- [Architecture](#architecture)
- [Privacy and data](#privacy-and-data)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Inference modes](#inference-modes)
- [Model routing](#model-routing)
- [Agent runtime and tools](#agent-runtime-and-tools)
- [Agent team](#agent-team)
- [Connectors, web search and chat apps](#connectors-web-search-and-chat-apps)
- [Accounts and your own database](#accounts-and-your-own-database)
- [Projects and shared links](#projects-and-shared-links)
- [Marketplace: agents and skills](#marketplace-agents-and-skills)
- [Automations](#automations)
- [AI Workforce](#ai-workforce)
- [Robots](#robots)
- [HANNAH Robot OS](#hannah-robot-os)
- [Devices](#devices)
- [MCP integration](#mcp-integration)
- [Desktop files and terminal](#desktop-files-and-terminal)
- [HANNAH uses your apps (macOS)](#hannah-uses-your-apps-macos)
- [Desktop computer use](#desktop-computer-use)
- [Command-line tool](#command-line-tool)
- [Voice and calls](#voice-and-calls)
- [Mobile, desktop and PWA builds](#mobile-desktop-and-pwa-builds)
- [Deployment](#deployment)
- [API reference](#api-reference)
- [Project structure](#project-structure)
- [Development commands](#development-commands)
- [Testing](#testing)
- [Project status](#project-status)
- [Troubleshooting and FAQ](#troubleshooting-and-faq)
- [Contributing](#contributing)
- [Further documentation](#further-documentation)
- [License](#license)

---

## Downloads

Installers for **HANNAH 1.8.0** are attached to the [latest release](https://github.com/HarshTambade/HANNAH/releases/latest), with a `SHA256SUMS` file to check them. The links below always point at the newest release.

| Platform | Download | Before you install |
| --- | --- | --- |
| macOS | [Apple silicon](https://github.com/HarshTambade/HANNAH/releases/latest/download/HANNAH-macOS-AppleSilicon.dmg) · [Intel](https://github.com/HarshTambade/HANNAH/releases/latest/download/HANNAH-macOS-Intel.dmg) | Not notarized yet. The first time, Control-click HANNAH in Applications and choose **Open**. |
| Windows | [Installer](https://github.com/HarshTambade/HANNAH/releases/latest/download/HANNAH-Windows.exe) | Not code-signed yet, so SmartScreen may warn: choose **More info → Run anyway**. Uninstall from Settings → Apps. |
| Linux | [AppImage](https://github.com/HarshTambade/HANNAH/releases/latest/download/HANNAH-Linux.AppImage) · [.deb](https://github.com/HarshTambade/HANNAH/releases/latest/download/HANNAH-Linux.deb) | x86-64. `chmod +x` the AppImage and run it, or install the `.deb`. |
| Android | [APK](https://github.com/HarshTambade/HANNAH/releases/latest/download/HANNAH-Android.apk) | A debug-signed test build for sideloading until a Play signing key is configured. |
| iOS | Not distributed yet | iOS apps need an Apple Developer signing identity. Build from source with Xcode ([Mobile, desktop and PWA builds](#mobile-desktop-and-pwa-builds)) or use the web app in Safari. |
| Web / PWA | Deploy it yourself; see [Deployment](#deployment). | Installable from a supported browser. |

What changed in each version is in [CHANGELOG.md](./docs/CHANGELOG.md). [Platform support](./docs/PLATFORM_SUPPORT.md) lists what works on each operating system and what was verified. Builds on `main` upload temporary [Actions artifacts](https://github.com/HarshTambade/HANNAH/actions/workflows/build.yml) without creating a release.

---

## What you can do

Every screen has its own address, so refresh, bookmarks and the back button work, and older `#/chat`-style links redirect. The build writes an `index.html` for each route, so any static host serves them without rewrite rules. The website is several pages, one per tab in its navigation: Home (`/`), Features (`/features`), Agents (`/ai-agents`), Robots & devices (`/robots-and-devices`), Privacy (`/privacy`), Download (`/downloads`) and FAQ (`/faq`). Each is pre-rendered for search engines, and an old `/#section` link opens the page that holds that section. Every screen except the website's pages, Marketplace and Integrations needs a connection first; opening one signed out asks you to connect, then takes you there. Unknown addresses show a "Page not found" screen.

| Screen | Route | What it does |
| --- | --- | --- |
| **Landing** | `/` | Introduces HANNAH. **Talk to HANNAH** opens the connect dialog: paste your Groq key (checked with Groq before the app opens). **I have an access token** is optional, for operator-provided models and features. When the server has a database, **Sign in or create one** opens email and password sign-in. |
| **Chat** | `/chat` | Conversation beside the 3D avatar. Pick a model, or **Auto** to let HANNAH choose a provider and model for each message in your [routing mode](#model-routing). A line above the message box previews the choice before you send. Speak or type, rate replies, approve or decline actions on the in-chat approval cards, and press **Stop** to halt a running task before its next step. Turn on **Team** to have HANNAH plan the task with specialist agents and verify the result. **Attach** files (PDF, Word, PowerPoint, Excel, CSV, text, JSON, images) to ask about them, and open **Library** for files HANNAH made and your research history. Use **Search the web** (quick, latest, deep research, academic, compare) for cited answers. |
| **Dashboard** | `/dashboard` | Bento-style overview built only from data on this device: replies this week, success rate, a 30-day activity matrix, your reply feedback, where you left off, memory and Guardian counts, and per-model latency and tokens. **Across your devices** shows agent team tasks and automations from all your signed-in devices and lets you approve or deny their next step here (see [Tasks across devices](#tasks-across-devices)). Also holds **Reminders**: add, cancel, and allow notifications. Empty states show `—` or `0`, never sample numbers. |
| **Agents** | `/agents` | The agent team: Research, Coding, Memory and Tasks specialists with their tools and model choice (Auto or a specific model), the always-on verification agent, and **Team activity**: every team run's plan, which steps ran in parallel, each step's status and result, verification and the final answer. Interrupted or stopped runs can be resumed, on this device or, when you're signed in, on any of your devices; runs another device is working on show its name and a **Cancel** button. |
| **Models** | `/models` | Model advisor. Enter or detect your device (RAM, GPU, VRAM, Apple unified memory) and pick a task, budget and goal (cheapest, fastest, best coding, privacy-first and so on). HANNAH ranks hosted and local models, shows whether each fits your memory (weights + KV cache + runtime), cost, privacy and limitations, and sets your choice for chat. |
| **Memory & trust** | `/memory` | The accountability page: an **Agent runs** log (every request with each tool step and how it ended, which survives reloads), Guardian strictness and its decision log (allowed and blocked, with reasons), the memory center (search, filter by category, edit, mark sensitive, export, switch kinds of memory or all memory off; each memory shows where it came from and when it was last used), **Knowledge** (your own documents, indexed on the device so HANNAH answers from them with citations; see [Knowledge](#knowledge)), personalization examples, the active persona, and installed plugins. |
| **Automations** | `/automations` | Routines built from trigger, agent-task, daily-briefing, action and output steps that run on a schedule while HANNAH is open, with approval before every action and a run history. See [Automations](#automations). |
| **Marketplace** | `/marketplace` | **Connectors**: 30 services (GitHub, Linear, Notion, Atlassian, Stripe, Vercel, Supabase and more) with their official icons, connected without needing an AI key, or any MCP server by URL once you're signed in. **Chat apps**: talk to HANNAH from Telegram, Slack, Discord, Google Chat, Teams or WhatsApp, and in the desktop app iMessage and Signal. **Agents and skills**: 11 agents (Study coach, Research analyst, Data analyst, Daily organizer and more) that set how HANNAH works for a conversation, the tools she keeps to hand and the prompts she suggests, and 12 skills that adjust every reply. One click turns one on; chat shows which agent is active and lets you switch. Plus **Community skills**: paste or open a skill manifest, review its publisher, permissions, privacy and integrity, then install and turn it on. |
| **Integrations** | `/integrations` | **Test this server now**: runs the REST API, the OpenAI-compatible API, a real reply, the MCP endpoint, A2A and webhooks with your credential and shows what came back; create a developer key there. REST and MCP guide with copyable examples, tool limits, server environment and host setup. **Database**: connection status and a guided setup for Supabase, Neon, any Postgres or SQLite, with a connection test for the operator. **Tools from other MCP servers**: what HANNAH can use as an MCP client. |
| **Robots** | `/robotics` | Robots you enrolled: each one on its map with its route and what its sensors detect, missions and how each was verified, plans with every step's outcome, the camera, the arm, the fleet with figures from real records, commissioning, destinations, capabilities and limits. Add a robot with a one-time code and run HANNAH's robot runtime on the robot's computer; with no robot, the runtime starts a built-in simulated one. Every robot is labelled **SIMULATION** or **PHYSICAL**, movement is approved through the Action Engine, and **Stop** is a software request, not an emergency stop. Beta, tested with the built-in simulators only. See [Robots](#robots). |
| **Devices** | `/devices` | Hubs on your network and the devices behind them: add a device from a list, from its manual or with a form; see what the hub heard when it checked the connection; choose what HANNAH may change; live values with their age; switch and set devices with approval; automations the hub runs by itself. Beta, tested with simulated devices only. Needs an account. |
| **Settings** | `/settings` | Connection (token, Groq key, disconnect). **Account** (when the server has a database): sign in, saved provider keys, sync, developer API keys, webhooks, security activity, export and deletion. **Calendar and email**: connect Google or Microsoft with their own sign-in. **Voice**: speaking and listening engines, voice choice, interrupt-by-talking and the **“Hey HANNAH”** wake word. **Daily briefing**: which sections, the place for the weather, and a preview (see [Daily briefing](#daily-briefing)). **Setup check**: one pass over the server, model, account, connections, voice, microphone, notifications, storage, desktop app and recent errors, with a verdict and a fix for each. Your data: per-item counts with **Clear** for conversation, memories and style feedback, **Export my data** as JSON, and **Delete everything**. Developer options. Also **Appearance** (text size), **Desktop app** (update channel, check for updates, update history, shortcut and `hannah://` links; desktop only), **Backup and restore** (one file with your data and choices, never your keys; optional passphrase; merge or replace on restore) and **Diagnostics** (what went wrong on this device, redacted, searchable, exportable). |

The design follows a bento and glassmorphism style: rounded `2rem` cards, pastel tones (sky, lavender, butter, mint), large light-weight stat numbers and a floating header. Layouts are responsive down to phone width.

---

## The safety model: Guardian, then you

Every action passes through the same chain, whether a model asked for it, it was a desktop action, or it changes memory:

```mermaid
sequenceDiagram
    autonumber
    participant M as Model (tool call)
    participant R as AgentRuntime
    participant G as GuardianAgent
    participant U as You (approval card)
    participant T as Tool
    M->>R: tool name + arguments
    R->>R: guardrails: known tool? not denied? within iteration cap?
    R->>G: screen(tool, args, your latest request)
    alt Guardian blocks
        G-->>R: GuardianBlockedError (reason logged)
        R-->>M: turn ends: "Guardian stopped … Nothing was changed."
    else Guardian allows
        G-->>R: allowed (risk score logged)
        opt tool changes something or reads private data
            R->>U: approval card (what, where, preview)
            U-->>R: Approve / Decline
        end
        R->>T: execute
        T-->>M: result
    end
```

### GuardianAgent

[`GuardianAgent.ts`](./client/src/services/GuardianAgent.ts) scores each proposed action, checks it against known attack patterns (for example `rm -rf` or "ignore previous instructions"), and looks for multi-step attempts across your last 10 actions. Its decisions are stored on the device (latest 100) and shown on **Memory & trust**.

| Strictness | Blocks |
| --- | --- |
| Permissive | Known attack patterns only. Approval is still required for every change. |
| Balanced (default) | Also blocks multi-step attempts to get around safety rules. |
| Strict | Also blocks high-risk actions, such as deleting or overwriting files, before they reach you. |

### Human-in-the-loop approval

[`SafetyGuard.ts`](./client/src/services/SafetyGuard.ts) and [`ApprovalCenter.ts`](./client/src/services/ApprovalCenter.ts) handle confirmation:

- With the chat open, an amber **approval card** appears in the conversation. It names the action, shows the target and a preview (a file write shows the path, byte size and first 700 characters), and offers **Approve** and **Decline**.
- With no chat open, HANNAH falls back to the native dialog on mobile or the browser's confirm dialog. If the chat closes while a request is pending, the request is declined.
- Declining ends the task with "Action cancelled. HANNAH did not make any changes."
- Approved actions are recorded in the local side-effect ledger.

### Other guardrails

- **Agent guardrails** ([`AgentGuardrails.ts`](./client/src/services/AgentGuardrails.ts)) flag prompt-injection phrases, deny shell and terminal tools, apply optional output deny-lists, and redact common credential, email, phone, ID and payment-card patterns from generated and tool text.
- **Iteration caps:** 8 tool rounds by default (`VITE_AGENT_MAX_ITERATIONS`), never more than 20.
- **Circuit breaker:** a tool that fails 3 times in a row is disabled for the session.
- **Routing profiles** limit which tools a task type can see (see [Agent runtime and tools](#agent-runtime-and-tools)).
- **Server limits:** with only a Groq key, a visitor can reach just the chat routes, and their key is forwarded only to Groq's official API. Server-held keys and every other route need the operator token. Rate limits apply per token and per visitor key.
- **Outbound requests:** web reading, workflow HTTP steps, connectors and webhooks share one address check ([`server/net-guard.js`](./server/net-guard.js)) that refuses loopback, private, link-local and cloud-metadata addresses in every spelling, including IPv4-mapped IPv6 such as `[::ffff:7f00:1]`. The check runs again when the connection opens, so a host can't pass it and then resolve to an internal address (DNS rebinding). Connectors don't follow a redirect from https to http, and reach servers outside the directory only with a key Groq accepts. Webhooks don't follow redirects. Self-hosters who need a private network set `WORKFLOW_ALLOW_PRIVATE_NETWORK=true`.
- **Sign-in limits:** attempts are counted per email and address, and per address, in the database when there is one, so every server instance shares them. Behind a reverse proxy the client's address comes from `X-Forwarded-For` (set `HANNAH_TRUST_PROXY=true` when the proxy isn't on the same machine or network).

These checks are defense in depth. They are not a guarantee against every prompt injection, so test your own release build before relying on them.

---

## Visual overview

HANNAH is a client-heavy app: the browser or native shell owns the chat, the avatar, the stores and the safety chain, while a small Express API owns provider credentials, routing policy and optional accounts. The diagrams below are the ones worth keeping in your head while you install or extend it.

### 1. System context

```mermaid
flowchart TB
    U["You (browser, phone, desktop app)"]
    C["HANNAH client<br/>React 19 + Vite + Capacitor/Electron"]
    S["HANNAH API<br/>Express 5 (server/)"]
    P["Model providers<br/>Groq, OpenAI, Anthropic, Gemini, …"]
    O["Local runtimes<br/>Ollama, LM Studio, llama.cpp, vLLM"]
    L["On-device models<br/>WebLLM, llama.cpp"]
    D["Your database<br/>(optional: Postgres or SQLite)"]
    E["Optional Python fallback<br/>FastAPI (backend/)"]

    U --> C
    C -->|local modes| L
    C -->|cloud / Ollama / accounts| S
    S --> P
    S --> O
    S -. optional .-> E
    S -. accounts, sync, vault .-> D
    C -. optional MCP hosts .-> S
```

### 2. Request lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant You
    participant Chat as ChatUI
    participant Router as AgentRouter
    participant LLM as LLMRouter
    participant API as Express API
    participant Prov as Provider
    participant Guard as GuardianAgent
    participant You2 as You (approval)
    participant Tool as Device tool
    You->>Chat: message
    Chat->>Router: classify task profile
    Router->>LLM: resolve inference mode
    alt local mode
        LLM->>LLM: generate on device
    else cloud / Ollama mode
        LLM->>API: POST /api/agent (token + optional Groq key)
        API->>Prov: provider request
        Prov-->>API: reply / tool calls
        API-->>LLM: reply, emotion, usage
    end
    opt tool call
        LLM->>Guard: screen(tool, args)
        alt blocked
            Guard-->>LLM: GuardianBlockedError
        else allowed
            Guard-->>LLM: allowed
            opt changes data or device
                LLM->>You2: approval card
                You2-->>LLM: approve / decline
            end
            LLM->>Tool: execute
            Tool-->>LLM: result
            LLM->>API: next step (if needed)
        end
    end
    LLM-->>Chat: final reply + emotion
    Chat-->>You: rendered reply, voice, avatar
```

### 3. Auto routing decision

```mermaid
flowchart TD
    M["Incoming message"] --> C["Classify task and complexity"]
    C --> Mode{"Routing mode?"}
    Mode -->|Balanced| B["Pick a model that fits the message"]
    Mode -->|Best quality| Q["Most capable model you can use"]
    Mode -->|Budget| U["Lowest-cost capable model"]
    Mode -->|Fastest| F["Lowest measured latency, then profiled fast"]
    Mode -->|Private| P["Self-hosted only"]
    Mode -->|Custom| K["Your provider list and caps"]
    B & Q & U & F & P & K --> Policy["Apply privacy policy and provider allow-list"]
    Policy --> Fallback["Up to 3 alternatives within the same policy"]
    Fallback --> Preview["POST /api/route/preview (no model call)"]
```

### 4. Agent team execution

```mermaid
flowchart LR
    Req["Your request"] --> Plan["Plan: split into up to 6 steps"]
    Plan --> Exec["Execute: up to 3 steps in parallel"]
    Exec --> V["Verify: check results, write final answer"]
    V -->|up to 3 steps back once| Exec
    V --> Done["Final answer"]
    Exec -->|declined / blocked / failed| Skip["Skip dependent steps"]
```

### 5. Cross-device approvals and task runs

```mermaid
sequenceDiagram
    participant A as Device A (started the run)
    participant S as Your account (server)
    participant B as Device B
    A->>S: checkpoint after each step
    A->>S: approval request
    S->>B: mirrored approval card
    B->>S: approve / deny (first answer wins)
    S->>A: result
    Note over A: continues from last checkpoint
    B->>S: resume or cancel (lease-aware)
```

### 6. Data storage map

```mermaid
flowchart LR
    subgraph Browser["Browser / app (this device)"]
        LS["localStorage<br/>chat history, usage, memories,<br/>Guardian log, team runs, automations"]
        SS["sessionStorage<br/>token + Groq key (tab only)"]
        IDB["IndexedDB / app storage<br/>knowledge, caches, models"]
    end
    subgraph Server["Server (optional)"]
        DB["Postgres or SQLite<br/>accounts, sync, vault, runs, budgets"]
        ENV["Environment<br/>provider keys, tokens"]
        FS["Files<br/>logs, audit chain, content reports"]
    end
    LS -. sync when signed in .-> DB
    ENV --> Server
```

### 7. Setup flow

```mermaid
flowchart TD
    Start["Clone repository"] --> Install["npm install (+ client/server)"]
    Install --> ServerEnv["Create server/.env<br/>token + provider keys"]
    ServerEnv --> ClientEnv["Optional client/.env"]
    ClientEnv --> Run["npm run dev"]
    Run --> Health["curl /api/health"]
    Health --> Connect["Open client, connect with Groq key or token"]
    Connect --> Optional{"Need more?"}
    Optional -->|accounts/sync| DB["Set DATABASE_URL + HANNAH_VAULT_KEY"]
    Optional -->|local models| Ollama["Install Ollama and pull a model"]
    Optional -->|mobile/desktop| Native["cap:sync and run on device"]
    Optional -->|Python fallback| Py["Create venv, install backend, run fallback"]
```

---

## Architecture

```mermaid
flowchart LR
    subgraph Client["Client · React 19 + Vite (web, Capacitor, Electron)"]
        UI["Screens<br/>Chat · Dashboard · Memory & trust<br/>Automations · Marketplace · Settings"]
        RT["AgentRuntime<br/>bounded tool loop"]
        LR["LLMRouter<br/>mode selection"]
        SG["SafetyGuard<br/>Guardian → approval"]
        DT["DeviceTools"]
        ST["Local stores<br/>chat · usage · memory · Guardian log"]
        AV["AvatarScene<br/>Three.js"]
        LOC["WebLLM · llama.cpp<br/>(on device)"]
    end

    subgraph Server["API · Express 5 (server/)"]
        AUTH["Bearer token + rate limits"]
        AG["/api/agent · /api/chat"]
        PR["Provider catalog<br/>Groq default + others"]
        MCP["/mcp (optional)"]
    end

    EXT["Model providers<br/>Groq · OpenAI · Anthropic · Gemini · …"]
    OLL["Ollama / local runtimes"]
    PY["Optional Python fallback<br/>(backend/, localhost)"]

    UI --> RT --> LR
    RT --> SG --> DT
    UI <--> ST
    RT -- emotion --> AV
    LR -- local modes --> LOC
    LR -- cloud / ollama --> AUTH --> AG --> PR
    PR --> EXT
    PR --> OLL
    LR -. retryable failure .-> PY
    MCP --> AG
```

### Request flow

1. You send a message from **Chat**.
2. `AgentRouter` classifies the request (chat, code, system, research and so on) and picks a profile with its allowed tools and iteration limit.
3. `LLMRouter` resolves the inference mode. Local modes generate on the device; cloud and Ollama modes call `POST /api/agent` with your token, plus your Groq key in the `X-Groq-API-Key` header if you gave one.
4. The server validates and bounds the request, adds your saved memories to the system prompt, calls the selected provider, and returns the reply, emotion, model, provider, latency and token usage.
5. A tool call goes through the [safety chain](#the-safety-model-guardian-then-you), then the result is sent back for the next step.
6. The final reply is rendered as Markdown, spoken if voice is on, and its emotion (`happy`, `sad`, `angry`, `neutral`, `surprised` or `thinking`) drives the avatar's face, pose and gestures. Turn metrics are saved for the Dashboard.

### Main modules

| Area | Files | Responsibility |
| --- | --- | --- |
| Composition and routing | [`App.tsx`](./client/src/App.tsx), [`AppShell.tsx`](./client/src/components/AppShell.tsx) | Hash routes, the connection gate and the floating header. |
| Chat | [`ChatUI.tsx`](./client/src/components/ChatUI.tsx), [`MessageContent.tsx`](./client/src/components/MessageContent.tsx) | Modes, voice, approval cards, ratings, Markdown replies. |
| Agent | [`AgentRuntime.ts`](./client/src/services/AgentRuntime.ts), [`AgentRouter.ts`](./client/src/services/AgentRouter.ts), [`LLMRouter.ts`](./client/src/services/LLMRouter.ts) | Tool loop, task profiles, mode routing. |
| Safety | [`GuardianAgent.ts`](./client/src/services/GuardianAgent.ts), [`SafetyGuard.ts`](./client/src/services/SafetyGuard.ts), [`ApprovalCenter.ts`](./client/src/services/ApprovalCenter.ts), [`AgentGuardrails.ts`](./client/src/services/AgentGuardrails.ts), [`CircuitBreaker.ts`](./client/src/services/CircuitBreaker.ts) | Review, approval, guardrails. |
| Tools | [`DeviceTools.ts`](./client/src/services/DeviceTools.ts), [`DesktopBridge.ts`](./client/src/services/DesktopBridge.ts) | Device and desktop actions. |
| Local data | [`ChatHistory.ts`](./client/src/services/ChatHistory.ts), [`UsageStats.ts`](./client/src/services/UsageStats.ts), [`MemoryStore.ts`](./client/src/services/MemoryStore.ts), [`PersonalizationEngine.ts`](./client/src/services/PersonalizationEngine.ts) | On-device stores behind the Dashboard and Memory & trust. |
| Persona and marketplace | [`PersonaKernel.ts`](./client/src/services/PersonaKernel.ts), [`MarketplaceService.ts`](./client/src/services/MarketplaceService.ts), [`PluginLoader.ts`](./client/src/services/PluginLoader.ts) | Persona prompt, agent and skill catalog, plugin state. |
| Native | [`AIService.ts`](./client/src/services/AIService.ts), [`MobileAgent.ts`](./client/src/services/MobileAgent.ts) | llama.cpp GGUF models and the optional MobileClaw agent. |
| Avatar and voice | [`AvatarScene.tsx`](./client/src/components/AvatarScene.tsx), [`avatar/`](./client/src/services/avatar/), [`SpeechService.ts`](./client/src/services/SpeechService.ts), [`VoiceService.ts`](./client/src/services/VoiceService.ts) | GLB avatar, facial expressions, body poses and gestures, speech in and out. |
| API | [`server/index.js`](./server/index.js), [`server/api-security.js`](./server/api-security.js) | Routes, auth, rate limits, provider calls. |
| Providers | [`server/providers/catalog.js`](./server/providers/catalog.js), [`server/providers/runtime.js`](./server/providers/runtime.js) | Provider presets, model discovery, request adapters. |
| Robots | [`server/robotics/`](./server/robotics/), [`server/actions/catalog/robots.js`](./server/actions/catalog/robots.js), [`robotics/runtime/`](./robotics/runtime/), [`RoboticsPage.tsx`](./client/src/components/RoboticsPage.tsx), [`Robotics.ts`](./client/src/services/Robotics.ts) | The robot registry, capability contract and Safety Gateway; the runtime that runs on the robot; the Robots screen and robot tools. |
| Robot OS (in progress) | [`robot-os/`](./robot-os/) | Onboard Linux services: hardware, motor-controller and sensor managers, ROS 2 runtime, Safety Gateway, AI bridge, update manager and remote gateway; unit/simulation only. |
| Devices | [`server/devices/`](./server/devices/), [`server/actions/catalog/hardware.js`](./server/actions/catalog/hardware.js), [`hannah-os/runtime/`](./hannah-os/runtime/), [`DevicesPage.tsx`](./client/src/components/DevicesPage.tsx), [`Devices.ts`](./client/src/services/Devices.ts) | The device registry, profiles, the Device Safety Gateway, the manual reader, and the hub that runs next to the devices. |
| MCP | [`server/mcp-core.mjs`](./server/mcp-core.mjs), [`mcp-http.mjs`](./server/mcp-http.mjs), [`mcp-stdio.mjs`](./server/mcp-stdio.mjs) | Exposes HANNAH to MCP hosts. |

### Vercel topology

The root [`vercel.json`](./vercel.json) defines two services in one project:

```text
/api/*  → server (Express)
/mcp    → server (unless MCP_ENABLED=false)
/*      → client (Vite static build)
```

The browser uses same-origin `/api` URLs, so `VITE_API_BASE_URL` stays empty on Vercel.

---

## Privacy and data

| Data | Where it lives | How long |
| --- | --- | --- |
| Access token and your Groq key | `sessionStorage` in this tab (`hannah.session.apiToken`, `hannah.session.groqKey`) | Until you close the tab or press **Disconnect**. Never in `localStorage` or a build variable. |
| Groq key in transit | `X-Groq-API-Key` header → your API → Groq over HTTPS only | Not logged or stored by the server. |
| Server provider keys | Server environment only | Never in `VITE_*` variables or the client bundle. |
| Chat history | `localStorage` (`hannah.chat.history.v1`) | Until you clear it in Settings. |
| Usage metrics | `localStorage` (`hannah.usage.turns.v1`): latency, success, provider, model and token counts. **No message text.** | Last 1,000 turns, or until cleared. |
| Memories | `localStorage` (`hannah.memory.v1`), sent with your requests so HANNAH can use them | Until you edit or delete them on Memory & trust. |
| Guardian log and strictness | `localStorage` (`hannah.guardian.*`) | Last 100 decisions. |
| Reply ratings | `localStorage` (`hannah.personalization.v1`) | Until you clear style data. |
| Conversation content on the server | Passed to the provider for the request and not stored. | Request lifetime. |
| Account data (only if you sign in, and only when the operator connected a database) | The operator's database: your email, a scrypt password hash, session and API-key hashes, provider keys encrypted with envelope encryption, synced memories, reminders, chat history and preferences, webhooks and a security log | Until you delete it, or delete the account in Settings → Account. |
| Account session | An HttpOnly cookie on the web (the app can't read it); a session token in app storage on native apps | 30 days from last use, or until you sign out. |
| Team runs | `localStorage` (`hannah.teamRuns.v1`): plans, step results and final answers | Last 20 runs, or until cleared on the Agents screen. |
| Voice with hosted engines | Reply text goes to OpenAI (OpenAI voices) and recordings to Groq (Whisper) only when you choose those engines | Request lifetime on HANNAH's server; the provider's own policy applies. |

**Telemetry.** The client sends a small allow-list of metadata events (for example `chat_opened` and `tool_confirmation_approved`) to your own server's `/api/events`, which writes them to its log. No message text, prompts or keys are included. **Sentry** and **PostHog** stay off unless you set their keys, and Sentry events are scrubbed of keys, tokens, chat text and file paths.

**Cloud providers** handle prompts under their own retention and training policies. For maximum privacy, use WebLLM, on-device llama.cpp or a local Ollama server.

See [`docs/PRIVACY_POLICY.md`](./docs/PRIVACY_POLICY.md) and [`RESPONSIBLE_AI.md`](./docs/RESPONSIBLE_AI.md).

---

## Quick start

### Requirements

- Node.js 20 or newer (CI uses Node 24) and npm
- Git and a modern browser (WebGPU for WebLLM)
- Optional: Ollama, Python 3.12 (fallback service), Android Studio, Xcode with CocoaPods

### 1. Install

```bash
git clone https://github.com/HarshTambade/HANNAH.git
cd HANNAH
npm install
npm install --prefix client --ignore-scripts
npm install --prefix server
```

The client installs with `--ignore-scripts` because a transitive package ships a broken lifecycle script that the app doesn't need.

### 2. Configure the server

```bash
cp server/.env.example server/.env
openssl rand -hex 32   # paste the output into HANNAH_API_TOKEN
```

Minimal `server/.env`:

```dotenv
PORT=3001
HOST=127.0.0.1
CLIENT_ORIGIN=http://localhost:5173
# Optional: operator access for server-held keys. Visitors can always bring their own Groq key.
HANNAH_API_TOKEN=<32–512 random characters>
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-120b
GROQ_MODEL_FALLBACKS=openai/gpt-oss-20b,llama-3.1-8b-instant
```

The legacy name `SHANAYA_API_TOKEN` is still accepted.

### 3. Configure the client (optional)

```bash
cp client/.env.example client/.env
```

The Vite dev server proxies `/api` to `localhost:3001`, so no settings are required for local development.

### 4. Run

```bash
npm run dev             # server on :3001 and client on :5173
curl http://localhost:3001/api/health
```

Open `http://localhost:5173`, choose **Talk to HANNAH**, and paste your own [Groq key](https://console.groq.com/keys). To use the server's own keys instead, open **I have an access token** and enter the token from step 2.

### Optional: Python model-step fallback

If Express fails with a network error, timeout, rate limit or 5xx, the client can ask the FastAPI service in [`backend/`](./backend) for one model step. The client still owns tool validation and approvals.

```bash
python3 -m venv .venv && source .venv/bin/activate
python -m pip install -r backend/requirements.txt
cp .env.example .env            # set the fallback provider key
npm run dev:with-python-fallback
```

The Python service binds to localhost only, requires approval for every tool (including reads) over a session-bound WebSocket, runs code in a network-disabled Docker container, and writes a redacted, hash-chained audit log to `logs/hannah_audit.jsonl`.

---

## Installation and setup (detailed)

This section expands the [Quick start](#quick-start) with the choices you usually have to make when moving from a laptop to a phone, a desktop app or a hosted server.

### 1. Prerequisites

| Tool | Required for | Notes |
| --- | --- | --- |
| Node.js 20+ (CI uses 24) and npm | Web app and API | `node --version` should be 20 or newer. |
| Git | Clone and updates | — |
| Modern browser with WebGPU | WebLLM on-device AI | Recent Chrome or Edge, or Safari 26+. Not needed for cloud mode. |
| Python 3.12+ | Optional Python fallback | Only if you run `backend/`. |
| Ollama | Local Ollama mode | `ollama serve`, then `ollama pull qwen3:8b` (or any model). |
| Android Studio + SDK 36 / NDK 29 | Android builds | See the Capacitor scripts. |
| Xcode + CocoaPods | iOS builds | iOS signing needs an Apple Developer identity. |
| Docker | Self-hosting or Python sandbox | Optional for the API; required for the Python fallback's code sandbox. |

### 2. Clone and install

```bash
git clone https://github.com/HarshTambade/HANNAH.git
cd HANNAH
npm install
npm install --prefix client --ignore-scripts
npm install --prefix server
```

The client uses `--ignore-scripts` because a transitive package ships a broken lifecycle script the app does not need.

### 3. Configure the server

```bash
cp server/.env.example server/.env
openssl rand -hex 32   # paste into HANNAH_API_TOKEN
```

Minimum working file:

```dotenv
PORT=3001
HOST=127.0.0.1
CLIENT_ORIGIN=http://localhost:5173
HANNAH_API_TOKEN=<32-512 random characters>
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-120b
GROQ_MODEL_FALLBACKS=openai/gpt-oss-20b,llama-3.1-8b-instant
```

With only `GROQ_API_KEY` set and no token, the server still forwards visitors' own Groq keys, but server-held keys and every other route need the token.

### 4. Configure the client (optional)

```bash
cp client/.env.example client/.env
```

Leave `VITE_API_BASE_URL` empty for local development: Vite proxies `/api` to `localhost:3001`. Set it only when the API is on another origin, such as a phone or a deployed server.

### 5. Run and verify

```bash
npm run dev
curl http://localhost:3001/api/health
```

Then open `http://localhost:5173`, choose **Talk to HANNAH**, paste a [Groq key](https://console.groq.com/keys), and send a message. The avatar should react to the reply's emotion. If you use the operator token instead, open **I have an access token**.

### 6. Optional: accounts and sync

```bash
# server/.env
DATABASE_URL=postgresql://user:password@host:5432/hannah
HANNAH_VAULT_KEY=$(openssl rand -hex 32)
```

Tables are created on first use. Check the connection with:

```bash
npm run db:check --prefix server
```

SQLite works for one self-hosted server: `DATABASE_URL=sqlite:./data/hannah.db`.

### 7. Optional: local models

- **Ollama:** `ollama serve && ollama pull qwen3:8b`, then set `OLLAMA_BASE_URL` and `OLLAMA_MODEL` in `server/.env`.
- **LM Studio / llama.cpp / vLLM:** set their `*_BASE_URL` and `*_MODEL` values.
- **WebLLM:** no setup; the browser downloads Llama 3.2 1B on first use.
- **On-device mobile AI:** set `VITE_OFFLINE_MODEL_URL` to an HTTPS GGUF URL.

### 8. Optional: Python fallback

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
cp .env.example .env
npm run dev:with-python-fallback
```

The fallback binds to localhost, requires approval for every tool, runs code in a network-disabled Docker container, and writes a redacted, hash-chained audit log.

### 9. Mobile and desktop builds

```bash
npm run cap:sync --prefix client          # build + sync + native patches
npm run cap:run:android --prefix client
npm run cap:run:ios --prefix client
npm run cap:run:electron --prefix client
```

On a physical phone, set `VITE_API_BASE_URL` to a reachable HTTPS API or your computer's LAN address, and add that origin to `CLIENT_ORIGIN`. The patch scripts fix third-party native modules (Kotlin/Java 17 on Android, zlib/privacy manifest on iOS).

### 10. Docker self-hosting

The [`Dockerfile`](./Dockerfile) builds one image with the API server and the web app, which the server serves when `HANNAH_SERVE_CLIENT` is set. [`docker-compose.yml`](./docker-compose.yml) adds a Postgres 16 database, and the workflow worker runs inside the server.

```bash
# .env next to docker-compose.yml (never commit it)
POSTGRES_PASSWORD=<a long random password>
HANNAH_VAULT_KEY=<openssl rand -hex 32>   # keep a copy: losing it makes saved keys unreadable
CRON_SECRET=<openssl rand -hex 32>

docker compose up -d --build
curl http://localhost:3001/api/health      # then open http://localhost:3001
```

The image runs as an unprivileged user, and its health check calls `/api/health`. The image and the compose stack haven't been built in CI yet.

### 11. Vercel deployment

1. Import the repository; `vercel.json` defines the `client` and `server` services.
2. Leave `VITE_API_BASE_URL` empty so the browser uses same-origin `/api`.
3. Set `HANNAH_API_TOKEN`, `GROQ_API_KEY` and other provider keys in the server service for operator features.
4. Set `VITE_SITE_URL` to your production origin.
5. Deploy and check `curl https://your-domain/api/health`.
6. **Database, vault and scheduler** (for accounts, workflows and chat apps), either way:
   - in the app: Settings → Account → **Set up HANNAH on Vercel and Supabase**, with a Vercel token and a Supabase token;
   - by hand: follow [Deployment](#deployment) below.

   Then set the GitHub secrets `CRON_SECRET` and `HANNAH_PRODUCTION_URL`, so the scheduled workflow tick runs every 5 minutes.

### 12. Setup verification checklist

- [ ] `npm run build --prefix client` succeeds.
- [ ] `npm test --prefix client` and `npm test --prefix server` pass.
- [ ] `/api/health` returns `{ status, provider, ready }`.
- [ ] A chat message returns a reply and the avatar changes expression.
- [ ] With a database, `npm run db:check --prefix server` succeeds.
- [ ] On mobile, `VITE_API_BASE_URL` points at a reachable API and the origin is in `CLIENT_ORIGIN`.
- [ ] No secret appears in any `VITE_*` variable or committed file.

---

## Configuration

### Client: `client/.env`

| Variable | Purpose |
| --- | --- |
| `VITE_API_BASE_URL` | API origin when it differs from the page origin (for example on a phone). Leave empty for the Vite proxy or Vercel. |
| `VITE_SITE_URL` | Public HTTPS origin for canonical URLs, social cards, `robots.txt` and `sitemap.xml`. |
| `VITE_PYTHON_FALLBACK_URL` | Optional FastAPI fallback (default `http://127.0.0.1:8000`). |
| `VITE_AGENT_MAX_ITERATIONS` | Tool rounds per request (default 8, maximum 20). |
| `VITE_AGENT_TOOL_DENY_LIST` | Extra tool names to deny, added to the built-in shell and terminal deny list. |
| `VITE_AGENT_OUTPUT_DENY_SUBSTRINGS` | Comma-separated phrases blocked in assistant output. |
| `VITE_OFFLINE_MODEL_URL` | HTTPS URL of a GGUF model for on-device AI on iOS and Android. |
| `VITE_AVATAR_MODEL_URL` | Avatar asset. When blank, the app loads the Draco-compressed `/models/avatar.draco.glb` (2.6 MB, decoded in a worker). Point it at another `.glb` to use your own avatar. |
| `VITE_HANNAH_ANTHROPIC_MODEL` | Model for the optional native MobileClaw agent. |
| `VITE_PINECALL_AGENT_ID` | Public Pinecall agent slug for voice calls. |
| `VITE_AGE_GATE_18_PLUS` | `true` shows an 18+ consent gate. |
| `VITE_SENTRY_DSN`, `VITE_SENTRY_*` | Optional browser error tracking; off when blank. |
| `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST` | Optional product analytics; off when blank. |
| `VITE_*_DOWNLOAD_URL` | Installer links for a Downloads menu (the component exists but is not shown in the app yet). |

Never put a secret in a `VITE_*` variable: Vite embeds those values in the public bundle.

### Server: `server/.env`

| Variable | Default | Purpose |
| --- | --- | --- |
| `HANNAH_API_TOKEN` | — | Operator bearer token, needed for server-held provider keys and for TTS, calls, desktop control, feedback and sync. When unset, the server serves bring-your-own-key visitors only. A value that is set must be 32–512 characters. |
| `HANNAH_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window. |
| `HANNAH_RATE_LIMIT_{CHAT,AGENT,DESKTOP,FEEDBACK,CONTENT_REPORT}_MAX` | `30`, `60`, `20`, `10`, `10` | Requests per token per window. |
| `PORT`, `HOST` | `3001`, `127.0.0.1` | Bind address. Use `0.0.0.0` only on a trusted LAN. |
| `CLIENT_ORIGIN` | Local origins | Comma-separated CORS allow-list. CORS is not authentication. |
| `HANNAH_DEFAULT_PROVIDER` | `groq` | Default provider in the model picker. |
| `GROQ_API_KEY`, `GROQ_MODEL`, `GROQ_MODEL_FALLBACKS` | —, `openai/gpt-oss-120b`, `openai/gpt-oss-20b,llama-3.1-8b-instant` | Groq configuration. |
| `<PROVIDER>_API_KEY`, `_BASE_URL`, `_MODEL`, `_MODELS` | — | Enables or configures one of the **23** catalog providers: Groq, OpenAI, Anthropic, Gemini, OpenRouter, Together, Cerebras, DeepSeek, Mistral, xAI, Fireworks, NVIDIA, SambaNova, Perplexity, Hyperbolic, **Azure OpenAI** (`AZURE_OPENAI_*`), **Amazon Bedrock** (`AWS_BEDROCK_*`; Converse API with AWS Signature V4), **Hugging Face** (`HF_*`), the local runtimes (Ollama, LM Studio, llama.cpp, vLLM) and `custom` (also used for MLX). Hosted providers use `<PROVIDER>_API_KEY`; local ones need only a reachable base URL. |
| `CUSTOM_BASE_URL`, `CUSTOM_API_KEY`, `CUSTOM_MODEL(S)` | — | Any OpenAI-compatible gateway (legacy `CLOUD_API_URL` and `CLOUD_API_KEY` also work). |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | `http://localhost:11434`, `qwen3:8b` | Ollama. |
| `LMSTUDIO_*`, `LLAMACPP_*`, `VLLM_*` | — | Other local OpenAI-compatible runtimes. |
| `CLOUD_REQUEST_TIMEOUT_MS` | `60000` | Per-model timeout (3–120 s). |
| `HANNAH_DAILY_BUDGET_USD` | — | Daily spending cap per token, account or visitor key, estimated from list prices. Users can set a lower cap in Settings. Stored in the database when one is connected, otherwise in memory per server process. |
| `DATABASE_URL` | — | Turns on accounts, sync, the key vault, developer keys, webhooks and persistent budgets. `postgres://…` for Supabase, Neon or any Postgres, or `sqlite:./data/hannah.db` for one self-hosted server. See [Accounts and your own database](#accounts-and-your-own-database). |
| `DATABASE_SSL`, `DATABASE_CA_CERT`, `DATABASE_POOL_MAX` | verified TLS, —, `3` | TLS mode (`no-verify` or `off` only if your provider needs it), a custom CA certificate, and the connection pool size. |
| `HANNAH_VAULT_KEY`, `HANNAH_VAULT_PREVIOUS_KEYS` | — | 32-byte master key (`openssl rand -hex 32`) that encrypts saved provider keys, and older keys still accepted during rotation. |
| `HANNAH_ALLOW_SIGNUP` | `true` | Set `false` to close new sign-ups. |
| `HANNAH_TRUST_PROXY` | `false` | `true` when a reverse proxy on another machine always sets `X-Forwarded-For`; a proxy on the same machine or private network is trusted already. Used for rate limits. |
| `CRON_SECRET` | — | Bearer secret for `POST /api/workflows/tick` and `POST /api/workforce/tick`, which a scheduler calls on serverless hosts. |
| `WORKFLOW_ALLOW_PRIVATE_NETWORK` | `false` | `true` lets web reading, workflow HTTP steps and connectors reach private addresses (self-hosting only). |
| `HANNAH_WORKFORCE_DIR` | `~/.hannah/workforce` | Where AI Workforce computers keep their files and browser profiles. |
| `WORKFORCE_ALLOW_PRIVATE_NETWORK` | `false` | `true` lets workforce browsers reach private addresses (self-hosting only). A computer's allowlist and "none" settings still apply. |
| `HANNAH_WORKFORCE_EXTENDED_COMMANDS` | — | `1` allows more terminal programs (node, git, npm and similar) on workforce computers. Use it only with a working sandbox or inside a container. |
| `HANNAH_WORKFORCE_SANDBOX` | `auto` | The workforce terminal's sandbox: `auto`, `off`, `sandbox-exec` or `bwrap`. Naming a driver makes it required, so commands are refused if it's missing or fails its check. |
| `WORKFORCE_WORKER`, `WORKFORCE_WORKER_INTERVAL_MS`, `WORKFORCE_TICK_TASKS` | on, `60000`, `2` | The built-in worker that runs routines and queued tasks (`off` turns it off), how often it runs, and tasks per tick. |
| `HANNAH_ACCOUNTS_USE_SERVER_KEYS` | `false` | `true` lets signed-in users use the server's provider keys, which you pay for. By default each user brings their own keys. |
| `OPENAI_TTS_MODEL`, `GROQ_STT_MODEL` | `gpt-4o-mini-tts`, `whisper-large-v3-turbo` | Models for the hosted voice engines. |
| `HANNAH_MCP_SERVERS` | — | JSON list of outside MCP servers HANNAH can use as a client, for example `[{"id":"docs","name":"Team docs","url":"https://…/mcp","headers":{"Authorization":"Bearer …"}}]`. |
| `HANNAH_PUBLIC_URL` | request host | Public base URL used in the A2A agent card. |
| `HANNAH_PROVIDER_FALLBACKS` | — | Comma-separated providers to try when `hannah-auto` requests without a routing mode fail with a retryable error, for example `openrouter,together`. Never used for visitor keys or a pinned provider. Routed requests fall back to the router's own alternatives. |
| `HANNAH_SELF_HOSTED_PROVIDERS` | — | Providers to treat as self-hosted in Private mode even on a public address, for example `custom,vllm` for your own inference box. Local runtimes and loopback or private-network endpoints count already. |
| `MCP_ENABLED`, `MCP_API_TOKEN`, `HANNAH_API_URL` | on, —, `http://127.0.0.1:3001` | Remote MCP endpoint at `/mcp`: `false` turns it off; the token is an optional extra operator credential. |
| `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`, `SEARXNG_URL` | — | Web search for research. The first one set is used; with none, research uses the caller's Groq key. Wikipedia, OpenAlex and arXiv need no key. |
| `ANTHROPIC_DESKTOP_MODEL` | `claude-sonnet-5-5` | Model for desktop computer use (needs `ANTHROPIC_API_KEY`). |
| `MITHI_TTS_URL` | — | Optional Mithi text-to-speech service. |
| `PINECALL_TOKEN_URL` | — | Trusted issuer of short-lived Pinecall credentials. |
| `SENTRY_*`, `LLM_TRACE_LOG`, `LANGFUSE_*` | — | Optional error tracking and metadata-only LLM traces. |
| `FEEDBACK_DISCORD_WEBHOOK_URL`, `MONGODB_*` | — | Destinations for in-app feedback (`/api/feedback` returns 503 without one). |
| `CONTENT_REPORT_LOG` | `logs/content_reports.jsonl` | Metadata-only AI content reports. |

[`server/.env.example`](./server/.env.example) lists every variable with comments. Real `.env` files are git-ignored.

---

## Inference modes

| Mode | Where it runs | Notes |
| --- | --- | --- |
| **Groq Cloud** (default) | Your API → the selected provider | Any provider configured on the server appears in the picker. The server discovers models and falls back only through your configured list. |
| **WebLLM Local** | In the browser via WebGPU | Downloads Llama 3.2 1B (about 900 MB) on first use, showing progress, and keeps it cached for offline use. Needs WebGPU (recent Chrome or Edge, or Safari 26+). If loading fails, the chat says why and offers **Retry** or **Use cloud instead**. Prompts stay on the device. |
| **Local Ollama** | Your API → your Ollama server | `ollama serve && ollama pull qwen3:8b`. |
| **On-device AI** | iOS and Android via llama.cpp | Needs `VITE_OFFLINE_MODEL_URL`; prepare the model while online. |
| **MobileClaw · Anthropic** | iOS and Android native agent | Uses an Anthropic key stored by the native plugin; optional local LanceDB memory. |
| **Desktop Agent** | Electron with the desktop bridge | Computer use with approval for every action. |

When offline, HANNAH chooses llama.cpp on mobile and WebLLM on web and desktop.

## Model routing

With the chat model set to **Auto**, the [router](./server/router.js) picks a provider and model for each message from every provider you can use: the server's providers for the operator, your saved keys when signed in, or Groq for a visitor key. Choose how in chat settings, under **How Auto chooses**:

| Mode | Picks |
| --- | --- |
| **Balanced** (default) | A model that fits the message: light for everyday chat, stronger for coding, research and reasoning. |
| **Best quality** | The most capable model you can use, every time. |
| **Budget** | The lowest-cost model that can still handle the message. |
| **Fastest** | The lowest measured latency (after three real replies), then models profiled as fast. |
| **Private** | Only self-hosted models: Ollama, LM Studio, llama.cpp, vLLM, or a provider on a loopback or private-network address, or one listed in `HANNAH_SELF_HOSTED_PROVIDERS`. |
| **Custom** | Your own provider list, a ceiling on the quality tier, and optionally self-hosted only. |

For fully offline use, pick the **WebLLM Local** or **On-device AI** inference mode, which never touches the network. API callers can send `mode: "offline"`, which the server treats like Private.

**Before you send**, the line above the message box shows the mode, provider and model. Open it for the reason, quality tier, cost, where the data goes, limitations, and up to three alternatives. **Use this** pins an alternative for the chat. The preview (`POST /api/route/preview`) calls no model.

**Privacy is enforced on the server.** In Private mode the server refuses to send a request to a hosted provider. That covers routed requests, fallbacks, and a model you pinned by hand, which gets `403 privacy_blocked`. If no self-hosted model is set up, you get a clear error instead of a quiet switch to the cloud. A local runtime counts only when its base URL or model list is set, because Ollama's built-in localhost default alone doesn't prove anything is running.

**Cost estimates are shown only when they can be defended.** Prices live in [`shared/model-prices.json`](./shared/model-prices.json), and each provider entry links to its official pricing page. The app shows a dollar estimate only for an entry with a `verified` date from the last 120 days. Every estimate states the reply length it assumes (about 700 tokens). Above your threshold (default $0.05), HANNAH asks before sending and offers cheaper alternatives. No entry is verified yet, so the app shows "No verified price" until an operator checks a provider's page and adds the date. Daily budgets still count every listed price, so caps err on the safe side.

**Failures:** when a routed request fails with a retryable error (rate limit, outage, timeout), HANNAH tries the next alternative that meets the same policy, up to three in all. The reply's `routing.fellBackFrom` says what was skipped. A provider that fails three times in a row sits out for a minute. Measured latency and health are kept per server process.

---

## Agent runtime and tools

### Device tools

| Tool | Needs your approval | Notes |
| --- | :---: | --- |
| `list_app_files` | — | HANNAH's private app storage only. |
| `read_app_file` | ✅ | In cloud mode, contents go to the selected provider. |
| `write_app_file` | ✅ | Card shows path, size and preview. |
| `delete_app_file` | ✅ | Blocked outright in Strict mode. |
| `open_app` | — | Opens an app or URL scheme. |
| `get_device_status`, `get_battery_status` | — | Read-only status. |
| `toggle_setting` | ✅ | For example the flashlight. iOS and Android don't allow apps to toggle Wi-Fi or Bluetooth. |
| `send_message` | ✅ | Opens an SMS draft; you press Send. |
| `make_call` | ✅ | Opens the dialer; you press Call. |
| `create_reminder`, `list_reminders`, `cancel_reminder` | — | Reminders. They alert in the app and, in the Android and iOS apps, as system notifications even when HANNAH is closed. |
| `search_memories` | — | Searches the facts you asked HANNAH to remember. |
| `save_memory` | ✅ | Saves one fact you asked her to remember. |
| `mcp_<server>_<tool>` | ✅ | Tools from outside MCP servers the operator connected (operator sessions only). Every call needs approval. |

The Guardian reviews **every** tool, including the ones that need no approval. Memory writes and deletions and saved-credential removal also need approval. Shell execution, arbitrary file-system access and notification reading are not available.

### Task profiles

[`AgentRouter.ts`](./client/src/services/AgentRouter.ts) (overridable with [`agent_profiles.yaml`](./agent_profiles.yaml)):

| Profile | Tools | Max rounds |
| --- | --- | :---: |
| `chat` | none | 4 |
| `code` | list, read, write files | 12 |
| `system` | device status, battery, open app, toggle setting, all file tools, reminders, memory search and save | 6 |
| `research` | list and read files | 10 |
| `maintenance` | none | 4 |
| `default` | all | 8 |

Local models (WebLLM and llama.cpp) receive tools through a JSON request format in the prompt, so the model has to follow that format.

---

## Agent team

Turn on **Team** under the chat box (cloud and Ollama modes) and HANNAH works on the request with specialist agents:

1. **Plan.** The server asks a model to split the request into up to six steps. Each step goes to one specialist and can depend on earlier steps. A plan that doesn't validate falls back to a single step for the best-matching specialist.
2. **Execute.** Steps whose dependencies are done run in parallel, up to three at a time. Each step is a normal agent turn limited to that specialist's tools and model, so the Guardian and your approval apply to every tool call. When a step is declined, blocked or fails, the steps that depend on it are skipped.
3. **Verify.** A verification agent with no tools checks the results against your request and writes the final answer. It can send up to three steps back once, with feedback.

| Specialist | Tools | Auto tier |
| --- | --- | --- |
| Research | research, web search and read, create document, read attached files, list and read app files (desktop adds browser and YouTube tools) | complex |
| Coding | list, read and write app files, desktop files and commands, research, create document | complex |
| Memory | search memories, save memory | simple |
| Tasks | reminders, device status, open app, message and call drafts, create document, read and convert files | standard |

On the **Agents** screen you can turn specialists off, pick a model for each, and watch runs live. Every run is saved after each change. A run cut short by Stop or a closed tab can be **resumed**: finished steps keep their results and only the rest runs again. When you're signed in, each change is also a checkpoint in your account, so you can resume the run on another device, or cancel it from there (see [Tasks across devices](#tasks-across-devices)). Code: [`Orchestrator.ts`](./client/src/services/Orchestrator.ts), [`TaskRecords.ts`](./client/src/services/TaskRecords.ts), [`server/task-runs.js`](./server/task-runs.js), [`SpecialistAgents.ts`](./client/src/services/SpecialistAgents.ts) and [`server/orchestrate.js`](./server/orchestrate.js).

---

## Connectors, web search and chat apps

### Connectors

Marketplace → Connectors lists 30 services on a public site and 33 on a local install (Vercel, Intercom and Square register local addresses only), each the vendor's own MCP server, shown with its official icon.
- **Connecting:** with your own sign-in (OAuth with PKCE), a token (GitHub), or no sign-in at all (docs search). You can also add any remote MCP server by URL.
- **Safety:** your tokens stay in your browser, and HANNAH asks before every action a connector takes.
- **Code:** the directory and its checks are in `server/connectors.js`.

### Web search and research

HANNAH searches on every platform. With a server key she uses Tavily, Brave Search or your own SearXNG; otherwise she uses Groq's browser search with your Groq key, then Wikipedia, OpenAlex and arXiv (no key needed). Research mode plans searches, reads the pages, scores sources and checks every citation; see [Research and Document Studio](#research-and-document-studio). She reads public pages through HANNAH's server (`server/web.js` and `server/research/`). The desktop app also has its own visible browser.

### Chat apps

Marketplace → Chat apps lets you talk to HANNAH from the apps you already use. It needs a signed-in account.

| App | How it connects | What you paste |
| --- | --- | --- |
| Telegram | Bot API; HANNAH sets the webhook herself | Bot token from @BotFather |
| Slack | Events API; requests signed with your signing secret | Bot token (`xoxb-…`) and signing secret |
| Discord | Interactions endpoint; Ed25519-signed; HANNAH registers `/hannah` | Bot token |
| Google Chat | HTTP endpoint app; Google-signed tokens for your project | Google Cloud project number |
| Microsoft Teams | Azure Bot (Bot Framework); Microsoft-signed tokens | App ID and client secret (tenant ID for single-tenant bots) |
| WhatsApp | Meta's official **Cloud API** (not the unofficial WhatsApp Web protocol); signed webhooks | Phone number ID, permanent access token, app secret |

- **Connecting:** HANNAH checks the credentials with the platform itself and seals them in the vault. She then shows the webhook URL, plus WhatsApp's verify token once, to paste where the platform needs it.
- **Checking every request:** each one is verified the platform's own way before anything is read.
- **Pairing:** you pair your own chat with a one-time code.
- **New people:** anyone else is told the bot is private and listed for you to **approve** or **deny**, like OpenClaw's pairing requests. Approved people get answers too, each with their own short history.
- **Groups:** group chats and channels are ignored.
- **Replies:** they use your account's AI key.
- **Code:** [`server/channels.js`](./server/channels.js) and [`server/channel-drivers.js`](./server/channel-drivers.js).

**iMessage and Signal (desktop app):** these read messages on your computer.
- **iMessage (macOS):** HANNAH reads Messages read-only (with Full Disk Access) and replies through the Messages app. Use a separate Apple ID on that Mac for HANNAH, so your own conversations aren't involved.
- **Signal (any desktop):** it works through [`signal-cli`](https://github.com/AsamK/signal-cli), linked with `signal-cli link -n HANNAH`.
- **Rules for both:**
  - off until you turn them on in a system dialog;
  - only people you approve are read, and anyone else is listed as asking;
  - HANNAH can only reply, once, to a message someone sent in the last 15 minutes. She never starts a conversation.
- **Code:** [`messages.mjs`](./client/plugins/desktop-tools/electron/dist/messages.mjs).

### Plugins

A HANNAH plugin is a remote MCP server, added as a custom connector. [`examples/hannah-plugin`](./examples/hannah-plugin) is a complete, dependency-free example with tests. The guide is in [`docs/API-INTEGRATION.md`](./docs/API-INTEGRATION.md#build-a-plugin).

### Setting up hosting from the app

Settings → Account → **Set up HANNAH on Vercel and Supabase** works from a Vercel token and a Supabase token. It creates the database, saves the settings in your Vercel project and redeploys (`server/hosting-setup.js`).

## Accounts and your own database

Accounts are optional, and they use **a database you choose**. Set `DATABASE_URL` on the server.

**On Vercel, Supabase connects in one click:** press **Connect Supabase on Vercel** in Settings → Account (or open [Supabase on the Vercel Marketplace](https://vercel.com/marketplace/supabase)) and approve it for this project, then accept Vercel's redeploy. HANNAH uses the integration's `POSTGRES_URL` when `DATABASE_URL` is empty, and derives its vault key from the integration's `SUPABASE_JWT_SECRET` when `HANNAH_VAULT_KEY` is empty. Set your own `HANNAH_VAULT_KEY` if you might rotate Supabase's secret: rotating it makes keys saved with the derived key unreadable.

| Database | `DATABASE_URL` | Notes |
| --- | --- | --- |
| **Supabase** | `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres` | Project Settings → Database → connection string. Use the pooler on serverless hosts (the direct host is IPv6-only). TLS is verified against Supabase's CA, which is built in. |
| **Neon** | `postgresql://<user>:<password>@ep-<name>-pooler.<region>.aws.neon.tech/neondb?sslmode=require` | Use the pooled connection string. |
| **Any Postgres 13+** | `postgresql://<user>:<password>@<host>:5432/<db>?sslmode=require` | RDS, Cloud SQL, Azure, Railway, Render, Aiven or your own server. |
| **SQLite** | `sqlite:./data/hannah.db` | One self-hosted server or the desktop app (Node 22.5+). Not for Vercel or other serverless hosts, whose disks are temporary. |

Tables are created and migrated automatically on first use, and `npm run db:check --prefix server` confirms the connection. Also set `HANNAH_VAULT_KEY` (`openssl rand -hex 32`) so users can save provider keys. **Integrations → Database** walks through the same setup and lets the operator test a connection string.

With a database, users get:

- **Sign-in** with email and password. Passwords are hashed with scrypt, and sessions are random tokens stored only as hashes. On the web the session is an HttpOnly, SameSite cookie.
- **Provider keys in an encrypted vault.** Each key is encrypted with its own data key, which is wrapped with the master key and bound to the user and provider. A saved key is sent only to that provider's hosted HTTPS API, and it's never shown or exported again.
- **Sync** of memories, reminders, community skills, chat history, preferences, projects and their chats, and automations with their schedules. The merge is three-way, so an edit or deletion made on one device isn't lost to another.
- **Developer API keys** (`hk_…`) for `/v1`, A2A and the SDK. They're shown once, stored as hashes and revocable.
- **Webhooks**: HMAC-signed POSTs when a reminder goes off, a team task finishes or the daily budget runs out. Only https URLs on public addresses are accepted.
- **Budgets that persist** across restarts and serverless instances, a **security activity** log, **export** and **account deletion**.

Signed-in users bring their own provider keys unless the operator sets `HANNAH_ACCOUNTS_USE_SERVER_KEYS=true`. Code: [`server/db`](./server/db), [`server/accounts.js`](./server/accounts.js), [`server/vault.js`](./server/vault.js) and [`server/webhooks.js`](./server/webhooks.js). The account tests run on both SQLite and real Postgres (PGlite).

---

## Projects and shared links

**Projects** group chats under a name with your own instructions (up to 4,000 characters), which go with every request from a chat in that project: the server adds them to the system prompt after HANNAH's rules (they can't add tools, grant permissions or change approvals), and on-device models get them in their prompt. Open **Projects** (the folder button in the chat header) to create one, move the open chat into it, start a new chat in it or reopen one of its chats. Projects and up to 40 of their most recent chats are kept on the device, signed in or not; signed in, they sync like memories (the `projects` and `projectChats` namespaces, each within the 1 MB sync limit). A chat outside any project works as before: New chat clears it. Code: [`client/src/services/Projects.ts`](./client/src/services/Projects.ts), [`server/projects.js`](./server/projects.js).

**Shared links** need an account. Chat history stays on your device, so the **Share** button (the link button in the chat header) uploads a copy of only the messages you tick, when you press Publish, and the server keeps that copy at `/s/<id>`. Messages written later aren't added; share again for a new link. Memories, tool results and file contents are never included; research sources and file names only if you tick them. The server hides keys, tokens and passwords it recognizes, whatever the app sends, but untick anything private. Delete a link in the same dialog and it stops working at once (the page is never cached). The page is rendered by the server with no scripts, under a CSP that allows only its own stylesheet, with `noindex` and `no-referrer`, using the same small Markdown subset as the chat. Making links is limited to 20 an hour and 100 per account. Account export includes every link and its copy; deleting the account deletes them. On Vercel, `vercel.json` sends `/s/` to the server; a self-hosted server serves it itself. Code: [`server/shares.js`](./server/shares.js) (migration 32), [`client/src/components/ShareDialog.tsx`](./client/src/components/ShareDialog.tsx).

---

## Marketplace: agents and skills

The catalog is bundled in [`shared/marketplace-catalog.json`](./shared/marketplace-catalog.json) and is first-party and offline.

- **Agents** are specialists, such as a study coach or the research analyst. Install one, then activate it; only one agent is active at a time. The catalog now includes a **Data analyst** that reads an attached spreadsheet or CSV and builds an Excel workbook with real formulas and charts.
- **Skills**, such as concise replies, can be combined. Enable the ones you want.

Entries add **prompt guidance only**. They don't add tools, request permissions, download code, or get around the Guardian. Choices are stored on this device.

**Community skills** install from a manifest (`manifestVersion: 1`, `type: "instruction-skill"`); the format is documented in [`CommunitySkills.ts`](./client/src/services/CommunitySkills.ts). The validator checks:

- every field;
- that the skill requests no permissions;
- the optional SHA-256 hash against the instructions;
- the optional Ed25519 **publisher signature** over the whole manifest;
- the instructions for prompt-injection text.

Publishers sign with `node server/scripts/sign-skill.js keygen <dir>`, then `node server/scripts/sign-skill.js sign manifest.json <key.pem>`. Check a signed manifest with `node server/scripts/sign-skill.js verify manifest.json`. Keys listed in [`shared/trusted-publishers.json`](./shared/trusted-publishers.json) show as a **trusted publisher**. The list starts empty, and you add a key only after confirming it with the publisher. Any other valid signature shows as signed by an unknown key, with its fingerprint. A manifest changed after signing is rejected. `keygen --force` overwrites an existing key pair.

The server checks the instructions again and labels them as untrusted guidance. At most three can be on at once. Executable plugins and MCP-server packages are refused until package signing and sandboxed execution exist. A public registry, reviews and sandboxed executable plugins aren't built yet.

---

## Automations

HANNAH has two kinds of automation:

- **Workflows** (signed in, on a server with its database): a visual editor on a canvas, run by the engine on HANNAH's server. Triggers: manual, schedules in your time zone, new email in Gmail or Outlook (checked every few minutes), file uploads (CSV, JSON or text up to 1 MB), webhooks (secret token or HMAC with replay protection) and HANNAH events. Steps: HTTP, email (read, draft, send with approval), calendar, Slack, Discord, GitHub, Notion, PostgreSQL (beta), memory, reminders, documents; If, Switch, Filter, Merge, Split, Aggregate, Wait, Approval; data mapping, parsing and validation with safe `{{ expressions }}`; a Code step (beta) that runs your JavaScript in an isolated WebAssembly sandbox with no network or file access; desktop steps (beta) that ask your signed-in desktop app to open apps, a shared project and links, show a notification, read a web page or run a coding task in a shared folder, after asking you there; phone steps (beta) that check your paired phones, find a contact on your phone, and open its dialer or Messages after you approve each run; Google Chat (beta: read a space, or post with approval); email steps that find conversations needing your reply and save reply drafts in the thread; AI prompts, structured extraction, classification and specialist agents. Every run records each step's input, output, timing and errors; you can retry from the failed step, cancel, or approve from any device. Credentials are encrypted and never shown again, internal network addresses are blocked, and a workflow lists what it may do before you activate it. Type a description and HANNAH drafts the workflow for you. Templates: invoice intake (webhook), invoice emails, morning email summary, GitHub issue triage, evening summary to memory, build failure monitor. Deployment, the security model and the API: [`docs/WORKFLOWS.md`](./docs/WORKFLOWS.md).
- **Routines on this device** (no account needed), below.

**Routines** are a trigger (chosen days at a time, every few hours, or only when you run it), then steps in order: **Ask HANNAH** (an agent task), **Daily briefing** (today's calendar, reminders, mail, weather and news, narrated; see [Daily briefing](#daily-briefing)), **Action** (save to memory or create a reminder, after your approval) and **Output** (notification, speech or run history only). Build one with **New automation** or start from a template (Morning briefing, Morning plan, Evening reflection, Stretch break, Friday review), add steps, move them up or down, and save. Each step gets the previous step's result. The editor ([`AutomationDraft.ts`](./client/src/services/AutomationDraft.ts)) stores it as a workflow chain ([`WorkflowSchema.ts`](./client/src/services/WorkflowSchema.ts)) on the device; automations made with the old canvas open with their steps in run order.

- **Running.** [`AutomationService.ts`](./client/src/services/AutomationService.ts) checks every 30 seconds while HANNAH is open in a tab or the desktop app and starts what's due. A run missed while HANNAH was closed happens once when it reopens, not once per missed slot. **Run now** starts one on demand.
- **Across your devices.** Signed in, automations and schedules sync to your account, and a due routine runs on whichever of your devices has HANNAH open. Each scheduled slot runs once: the first device to claim it runs it, the others skip it. Every run is saved to your account step by step ([`TaskRecords.ts`](./client/src/services/TaskRecords.ts)). You can approve an action from any device; continue a run that was cut off when its device closed (**Continue here**); or cancel a run from another device (**Cancel on …**), which stops it before its next step. Signed out or offline, runs stay on the device.
- **Steps.** An agent task runs one agent turn, with no tools, on the AI chosen in chat (provider, model and your key, or Ollama), with the previous step's result as context. On-device chat models can't run in the background, so with one selected an agent task says so. An action (save to memory, create a reminder) pauses the run until you press **Approve** or **Deny**, here or on another signed-in device. An output shows a notification and an in-app card, speaks the result, or only records it.
- **History.** The latest 50 runs are kept on the device with each step's status and result.
- **Limits.** Nothing runs while HANNAH is closed on every device; on Android and iOS the app has to be open. Agent tasks use your connected AI and count toward its usage.

---

## Memory

HANNAH remembers what you add on the **Memory & trust** screen, what you mark with **Remember this** in chat, and what she saves when you ask (you approve each save).

- **Only what's relevant is sent.** With each message HANNAH picks the memories that relate to it, ranking by shared words (rarer words count more; English, Hindi and Hinglish all work), and adds up to three of your preferences. Unrelated memories stay on the device.
- **Sensitive memories stay private.** Memories about health, money, beliefs or contact details are marked sensitive (you can change that). They're sent only to Ollama or to Auto in Private routing, never to hosted models, and the `search_memories` tool never returns them.
- **No secrets.** Passwords, PINs, API keys, tokens, card numbers and ID numbers are refused, wherever a save comes from.
- **You're in control.** Every memory shows its category, where it came from and when it was last used. You can edit, re-categorise or delete it, switch a whole category off, export your memories, or turn memory off entirely: then nothing is used or saved.
- **No duplicates.** Saving something that says nearly the same as an existing memory updates it instead.
- **Facts that change.** When a new statement changes a fact HANNAH remembers ("I live in Pune" after "I live in Mumbai", "my favourite food is biryani" after "pizza"), it replaces the old memory instead of contradicting it, and the old value is kept as that memory's history (shown under it, and in exports).
- **Temporary chat.** The eye button in chat starts a temporary chat: HANNAH doesn't use or save memories in it, and it isn't kept in your chat history. It ends when you turn it off or reload.
- **Export** as JSON or as readable Markdown, grouped by category with each memory's source.
- **Search is by words, not meaning.** There's no embedding (vector) search yet ([KI-32](./docs/architecture/KNOWN_ISSUES.md)).

Code: [`MemoryModel.ts`](./client/src/services/MemoryModel.ts), [`MemoryService.ts`](./client/src/services/MemoryService.ts), [`MemoryPanel.tsx`](./client/src/components/MemoryPanel.tsx).

## Research and Document Studio

Two platform services, each implemented once on the server and used by chat, voice, Team specialists, marketplace agents, workflows and MCP hosts. Full description: [`docs/RESEARCH_AND_DOCUMENTS.md`](./docs/RESEARCH_AND_DOCUMENTS.md).

- **Research** (chat → Search the web): Quick, Latest, Deep research, Academic and Compare modes.
  - It plans searches, runs them on interchangeable providers, opens and reads the pages (obeying `robots.txt`), scores sources and answers with `[n]` citations that link to the source.
  - Every citation is checked against the passages that were read. Pages that couldn't be opened are listed with the reason.
  - When nothing can be retrieved it says so instead of answering from memory.
- **Documents**: ask for a PowerPoint, PDF, Word or Excel file in plain words.
  - Written from attached files, a research result or the conversation, then rendered and validated by opening the file again.
  - Excel formulas stay formulas; a dataset is copied from your file, never retyped by a model; no figures are invented when there is no data.
  - Revisions ("make it more professional") rewrite only what was asked and keep the earlier version.
- **Attachments**: PDF, DOCX, PPTX, XLSX, CSV, text, JSON and images, each shown with how much of it was read.
- **Library**: files and research history on the device; signed-in accounts keep files for 30 days unless kept longer.

Code: [`server/research/`](./server/research), [`server/documents/`](./server/documents), [`server/studio.js`](./server/studio.js), [`client/src/services/Studio.ts`](./client/src/services/Studio.ts).

## Images and video clips

Ask in chat, the way you would with Grok: "draw a red fox in snow", "make a picture of a lighthouse at dusk, landscape", "make a 5-second clip of waves". You can also turn on **Create** above the message box, pick **Image** or **Video clip**, and type only the description. The picture or clip appears in the conversation with a **Download** button and is kept with your other files on this device (Library → Files). The agent can also call `generate_image` and `generate_video` itself. A video asks for your approval first, because it costs more and takes a minute or more.

- **Whose key pays.** Generation uses the same keys as chat: a key saved to your account in Settings → Account, or the operator's key on the server. Images work with an **OpenAI**, **xAI** or **Together AI** key, through the OpenAI-style `/v1/images/generations` endpoint. Video works with an **xAI** key only, through xAI's video job API (start a job, then check it until the clip is ready). Without a suitable key, HANNAH tells you which key to add. OpenAI's Sora video API was shut down in September 2026, so it isn't offered.
- **Models.** By default these are `gpt-image-2` (OpenAI), `grok-imagine-image-2.0` (xAI), `black-forest-labs/FLUX.1-schnell` (Together) and `grok-imagine-video-1.5` (xAI video). Change them with `OPENAI_IMAGE_MODEL`, `XAI_IMAGE_MODEL`, `TOGETHER_IMAGE_MODEL` and `XAI_VIDEO_MODEL` on the server. Clips are 1 to 15 seconds long (5 by default) and 720p.
- **What HANNAH won't make.** It refuses sexual content involving anyone who might be under 18, pictures or videos of real private people (for example "my neighbour Sarah"), and sexual images of real, named people. These are word checks on the server, applied before any provider is called. They catch the plain cases, not every possible wording. The provider's own moderation still applies, and when a provider says no, HANNAH shows its reason word for word.
- **Cost.** Your daily budget (Settings, or `HANNAH_DAILY_BUDGET_USD` on the server) applies: once it's used up, nothing more is generated that day. xAI reports what each image and video cost, and HANNAH counts that toward the budget. OpenAI and Together don't report a cost, so set `HANNAH_IMAGE_COST_USD` (per image) and `HANNAH_VIDEO_COST_USD_PER_SECOND` if you want those counted too.
- **Storage.** The server doesn't keep generated media. It passes the file to the app, which saves it in the browser's storage with the documents HANNAH makes. Generated media isn't copied to your account, so it doesn't follow you to another device.
- **Tested so far.** The server routes and the app's code are tested with stand-ins for the provider APIs, built from each provider's public documentation. **No real OpenAI, xAI or Together key has been used yet.** Field names that the docs leave unclear, such as xAI's video status values other than "done", "failed" and "expired", haven't been checked against the live APIs. A clip comes back from the server as one response, so a long clip may be larger than a serverless host allows in a single response (Vercel's limit is about 4.5 MB).

Code: [`server/media.js`](./server/media.js), [`client/src/services/Media.ts`](./client/src/services/Media.ts).

## Code in chat

Python and JavaScript in a reply can run **in your own browser or app**, never on a server.

- **Run button.** A `python` or `javascript` code block in a reply has a **Run** button. The output appears under it: printed text, errors, the last expression's value, pandas tables and `console.table`, and matplotlib charts as images.
- **HANNAH runs code herself.** For sums, statistics, data or a chart she can call the `run_code` tool, read the output and answer from it. The code and its output appear under her reply as **Code HANNAH ran**.
- **Attached files.** With files attached to the chat, tick **Use attached files** (or HANNAH sets `use_attached_files`): Python opens them with `open("data.csv")`, JavaScript reads `files["data.csv"]`. Text files up to 2 MB, four per run; spreadsheets are passed as CSV.
- **Python** is [Pyodide](https://pyodide.org) 0.29.5, loaded from jsDelivr the first time Python runs (about 10 MB, more for numpy, pandas or matplotlib). It **needs a connection the first time**; the website then keeps a copy for offline use, and the apps rely on the WebView's cache. Variables carry over between runs until a run times out.
- **Limits.** 20 seconds per run, after which the worker is terminated. 20,000 characters of output, four images, 50 table rows, 50,000 characters of code. Memory is limited only by what the browser allows a worker.
- **Sandbox.** Each language runs in its own Web Worker: no page, no cookies, no app storage. Before any code runs, the worker removes `fetch` (Python's may only download Pyodide's own files), `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, nested workers, `eval` and `new Function`, and JavaScript may not use `import`. On the website, and under `vite` and `vite preview`, the worker scripts also get their own strict Content-Security-Policy (`vercel.json`, `client/scripts/codeRunnerHeaders.ts`), so the browser blocks any connection the code tries. The desktop and phone apps don't send that header, so there the sandbox is only the worker's own lockdown.

Code: [`CodeRunner.ts`](./client/src/services/CodeRunner.ts), [`codeSandbox.ts`](./client/src/services/codeSandbox.ts), [`workers/`](./client/src/workers), [`CodeBlock.tsx`](./client/src/components/CodeBlock.tsx).

## Knowledge

**Knowledge** is your own documents, indexed on this device so HANNAH can answer from them and show where each answer came from. Add files or paste text on **Memory & trust → Knowledge**; in the desktop app, index the text files of a shared folder. Each document is split into overlapping passages, and a search ranks them with BM25 over the same tokenizer memory uses (any script, light stemming).

- **Ask in chat.** "What does my trip notes file say about the train?" HANNAH calls `knowledge_search` (and `knowledge_documents` to see what you gave her), reads the passages, and cites each claim with a tag such as `[Trip notes §3]`, so you can check it against the passage. The Research specialist has the same tools, and a multi-part question runs several searches.
- **Stays here.** Documents are kept in this browser's storage (up to 2 MB of text in total, 400 KB per document, 200 documents), are included in backups, and are never synced to your account. A passage reaches the AI only when it calls the search tool, and it's marked as document content, not instructions.
- **Text files only for now:** notes, Markdown, code, CSV, JSON, YAML, HTML and the like. PDFs and Office documents aren't read yet; they're refused with a clear message.

Code: [`Knowledge.ts`](./client/src/services/Knowledge.ts), [`KnowledgePanel.tsx`](./client/src/components/KnowledgePanel.tsx).

## Daily briefing

Say **"good morning"** in chat, ask for a briefing, or add the **Daily briefing** step to an automation (the **Morning briefing** template runs it every day at 07:30 and speaks it), and HANNAH gives you a short spoken-style summary of the day: today's calendar and the newest mail (once Google or Microsoft is connected), reminders due today, routines and preferences she remembers, and, if you turn them on in **Settings → Daily briefing**, the weather and the news.

- **How it's made.** HANNAH collects each section herself ([`Briefing.ts`](./client/src/services/Briefing.ts)) and hands the lines to the AI chosen in chat as one task; the AI only narrates. Mail and headlines are labelled as other people's content, never instructions. Sensitive memories are never included. **Preview today's briefing** in Settings shows the narration and what was collected.
- **Weather and news are off by default** because they call third parties: the forecast comes from [Open-Meteo](https://open-meteo.com/) for a place you choose by name (only that place's coordinates are sent, never your device's location), and headlines come from the Hacker News front page through Algolia's public API. Nothing about you is sent with either request.
- **What's not there yet:** other news sources, health and fitness sources, and a briefing that runs while HANNAH is closed (automations need HANNAH open on one of your devices).

## Tasks across devices

Sign in with the same account on your laptop, phone and desktop app, and each device reports the longer tasks it runs (agent team runs and automations) to your account. **Dashboard → Across your devices** lists them with the device, status and progress.

- **Approve from another device.** Every approval HANNAH asks for in chat, and every automation action, is mirrored to your other signed-in devices. They show it as a card on any screen (with the full request), and you can approve or deny from whichever device is in your hand. The first answer wins: the server records it with a single conditional update, so two devices can't both decide, and an expired request (10 minutes for chat, 30 for automations) can't be approved. The work keeps running on the device that started it, which continues as soon as it sees the answer.
- **Continue a team run on another device.** Each agent team run is saved to your account after every step, as a checkpoint with the plan and each step's result. One device works on a run at a time: it holds a 90-second lease and renews it while it works. When a run is paused, or its device goes quiet (closed, asleep, offline), open **Agents** on another device and press **Resume**: it continues from the last checkpoint and doesn't redo finished steps. While a step waits for your approval, the run shows **Waiting for you** on every device. **Cancel on <device>** stops a run from wherever you are; that device stops before its next step, and cancelled runs can't be resumed. A device that comes back after another took over can't overwrite the newer progress. Checkpoints made offline are sent when the device reconnects. Saved runs are kept for 30 days (at most 100) and included in the account export.
- **Automations too.** The same rules apply to automation runs: a scheduled routine runs on whichever device is open (once per slot), and you can approve, continue or cancel its runs from any device. See [Automations](#automations).
- **Not running in the background.** A device sees new approvals while HANNAH is open on it (every 8 seconds, and at once when you come back to it). To be told when HANNAH isn't open, add a webhook for `approval.requested` (Settings → Account → Webhooks) and forward it to a push service such as ntfy or Pushover.
- **Privacy.** Shared tasks hold the task title, progress text and approval text, kept in your account for a week. Turn **Share with my devices** off on a device to keep its tasks and approvals local. Signed out, nothing is shared.

Server: [`server/device-tasks.js`](./server/device-tasks.js), [`server/task-runs.js`](./server/task-runs.js). App: [`DeviceTasks.ts`](./client/src/services/DeviceTasks.ts), [`TaskRecords.ts`](./client/src/services/TaskRecords.ts), [`ApprovalCenter.ts`](./client/src/services/ApprovalCenter.ts).

## Phone Bridge

Use your own phone from your computer.
- **Pairing:** pair it once in **Settings → Phone**. Press **Pair a phone** on the computer, type the code in HANNAH on the phone (signed in to the same account), and check that both show the same fingerprint.
- **Asking:** say "call Aman using my phone" or "text my brother I'll be late", or use the panel. HANNAH finds the person in the phone's contacts (only matches come back) and asks you to confirm the name and number. The phone's own dialer or Messages then opens with it filled in, and you tap Call or Send.
- **What HANNAH reports:** only what the phone verified, never "connected" or "delivered".
- **Limits:** requests last a minute, and a phone that isn't open with HANNAH gets nothing, rather than a call happening later. Emergency numbers and `*`/`#` codes are refused. No restricted call or SMS permissions are used.
- **In workflows:** the steps Check my phones, Find a contact on my phone, Call on my phone and Text on my phone use this same bridge, with approval on every call or text (see [`docs/WORKFLOWS.md`](./docs/WORKFLOWS.md#phone-steps)).
- **More:** design, security and verification are in [`docs/DEVICE_INTELLIGENCE.md`](./docs/DEVICE_INTELLIGENCE.md), along with the audit and backlog for computer use, startup routines and communication services.

## Calendar and email

Connect Google (Calendar and Gmail) or Microsoft (Outlook calendar and mail) in **Settings → Calendar and email**. You sign in on the provider's own page; HANNAH stores the sign-in encrypted in your account, so it works on all your devices.

- **What HANNAH can do:** list your events, add an event, search and read mail, save a draft and send mail. Adding an event, saving a draft and sending mail each show you exactly what will happen and wait for your approval. Events are created without attendees, so nobody is invited.
- **Mail that needs you:** "what emails need a reply?" finds conversations where the newest message is from someone else and you haven't answered (automated senders are left out). HANNAH can then prepare a reply draft in the same thread, archive a message or add labels, after your approval. She never deletes mail. She lists attachments and can read one up to 10 MB. The **Communications** card on the Dashboard shows the same list, labelled by account.
- **Google Chat:** choose **Also connect Google Chat** on your Google card. HANNAH can then list the spaces you're in, read and summarize recent messages, and post as you after you approve the exact text. The operator also needs the Chat API set up ([`docs/CALENDAR_AND_EMAIL.md`](./docs/CALENDAR_AND_EMAIL.md)).
- **WhatsApp:** only a WhatsApp Business number, through Meta's official Cloud API ([Chat apps](#chat-apps)). Personal WhatsApp has no official API, so HANNAH doesn't read it.
- **Mail is untrusted.** Mail HANNAH reads is marked to the model as other people's content, never instructions.
- **Signing in from the apps:** the mobile and desktop apps finish the provider's sign-in in your system browser, which isn't signed in to HANNAH. There, nothing is saved until you confirm a page that names the mailbox and the HANNAH account it will join. A browser signed in to a different HANNAH account is refused.
- **Server setup:** the operator registers a Google and/or Microsoft sign-in app and sets `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`. Step-by-step: [`docs/CALENDAR_AND_EMAIL.md`](./docs/CALENDAR_AND_EMAIL.md). Gmail access for the public needs Google's app verification.

## AI Workforce

**Beta. Needs a signed-in account and the account database.** Open **Workforce** in the app. AI teammates are workers with a role, instructions and their own memory. They take tasks, work on a cloud computer or (when you allow it) on your own desktop, hand work to each other and come back with results you can check. Anything risky waits for you. The operator guide, with every rule and setting: [`docs/AI_WORKFORCE.md`](./docs/AI_WORKFORCE.md).

| Part | What it does |
| --- | --- |
| **Teammates** | Start from 11 templates (Chief of Staff, Research Analyst, Software Engineer, QA Engineer, Security Analyst, Marketing Manager, Sales Assistant, Finance Assistant, Personal Assistant, Robotics Engineer, IoT Manager) or describe your own. Each has an autonomy level (`observe`, `suggest`, `approval`, `scoped`, `autonomous`), version history with restore, a test run, duplicate, export and archive. |
| **Conversations and Talk** | A private chat with each teammate, typed or spoken (**Talk**, which takes turns: the microphone is off while the teammate speaks). Asking for work returns a proposed task that is queued only when you accept it; a task is never queued by voice. |
| **Tasks** | Run by a worker on the server, not in your browser tab, so they keep going when HANNAH is closed. A task can be planned, delegated or handed to another teammate, produces artifacts, and can be verified by a different teammate. **Agent Activity** holds the approval queue, the task board, suggestions, notifications and usage limits. |
| **Cloud computers** | A workspace per computer on the server: files, a terminal limited to allow-listed commands with checked arguments (no shell), and a real browser (Playwright and Chromium) whose sign-ins persist. Each computer has a storage limit, and network (open, allowlist, none) and download settings its browser obeys. **Live view** streams the browser; **Take control** holds it so teammates can't act while you click and type, until you hand it back. |
| **Your own computer** | A teammate can't reach your desktop directly. It queues a job, and the HANNAH desktop app asks you before each one in its own dialog. Each local computer has a rule for which kinds of job it takes. Terminal commands (one exact command in a shared folder, shown every time) and **desktop control** (using your apps with a short plan, in a timed session you allow; never types passwords or pays) are off until you turn them on for that computer. Desktop control is macOS only. |
| **Skills and Teach mode** | A skill is a reviewed list of steps. Teach mode records a demonstration only with your consent, never records audio, and never keeps a typed password: it becomes an input filled from the vault when the skill runs. A taught skill starts as a draft and must be tested and approved before it runs. |
| **Routines** | Run a teammate or skill on a schedule (cron in your time zone, or every N minutes), when an event happens, or from a signed webhook (GitHub, Linear, Sentry, PagerDuty, or any service using HANNAH's signature). Every run is recorded. Events from a routine's own runs never start a routine, and two servers ticking together run it once. |
| **Secure Vault** | Credentials encrypted with the server's vault key. The API never returns a value and the model never sees one: a teammate refers to `secret:<id>`, and the server types the value into the page itself, only on the sites you name, if you name any. A teammate can use a credential only when you assign it; an unassigned one is yours alone. |
| **Approvals** | Every action has a risk level. Low-risk actions follow the teammate's autonomy level, high-risk ones (sending, publishing, deleting, changing access) always ask, and critical ones (payments, destructive or safety changes, robot motion) are refused here. A team rule can only tighten yours. An approval covers the one step you saw: if the skill changes, the step asks again. Text from a web page, mail or a tool is never an approval. |
| **Meetings** | With everyone's consent, take **live notes** from your own device: it records pieces of about 20 seconds, the server transcribes them with your Groq key and keeps only the text, never the audio. Or paste a transcript. A model then writes the summary, decisions, risks and action items, and an action item becomes a task when you pick a teammate for it. |
| **Notifications and chat apps** | Approvals waiting, finished tasks and failed work reach you in the app, through account webhooks, or in Telegram, Slack, Microsoft Teams or WhatsApp. A chat app can be bound to a teammate, and the paired owner can reply `approve apv_…` there. Quiet hours hold chat and webhook messages. |
| **Teams, suggestions, artifacts** | Share a teammate with a team without sharing anyone's private data; removing a member withdraws the teammates they published. Suggestions are opt-in, use real signals and respect your settings. Artifacts are versioned; HTML and SVG ones open sandboxed, so their scripts can't act as you. |

**How the browser is contained.** Every request a computer's browser makes (page loads, scripts' requests, images, frames and every redirect) goes through that computer's own proxy on `127.0.0.1` ([`egress-proxy.js`](./server/workforce/egress-proxy.js)). The proxy checks the address it actually connects to: internal and cloud-metadata addresses are refused in every spelling, along with anything outside the computer's network setting. Uploads can't read the saved sign-ins or follow a link out of the workspace, and downloads are capped at 100 MB.

**How the terminal is contained.** Commands run under the host's own sandbox when one passes a check ([`sandbox.js`](./server/workforce/sandbox.js)): `sandbox-exec` on macOS, bubblewrap on Linux. Before using a driver, the server runs a real program under it and confirms that writing in the workspace works while writing outside it, reading another workspace, reading the server's folder and any network connection all fail. A driver that fails the check isn't used. `HANNAH_WORKFORCE_SANDBOX` is `auto` (the default), `off`, or a driver's name, which makes that driver required: commands are then refused rather than run unsandboxed. The Computer Center shows which driver is in use.

**Server setup.**
- **Database and vault:** `DATABASE_URL` and `HANNAH_VAULT_KEY`.
- **Workspace location:** `HANNAH_WORKFORCE_DIR` sets where workspaces live; the default is `~/.hannah/workforce`.
- **Browser:** Playwright and its Chromium must be installed on the server (`npx playwright install chromium`); without them, browser steps say so.
- **Tasks and routines:** on a long-running server, a built-in worker runs them every minute (`WORKFORCE_WORKER=off` turns it off). On Vercel, call `POST /api/workforce/tick` with `Authorization: Bearer $CRON_SECRET` on a schedule.
- **Live view and take control** keep their stream in the server process, so they need a long-running server; they don't work on serverless functions.

**Not done yet.**
- **Isolation:** a cloud computer is a folder and a browser profile on the HANNAH server. The terminal sandbox is process isolation in the host's kernel, not a virtual machine or container per person. The bubblewrap driver hasn't been run on a Linux host yet; its own check decides whether it's used there. Extra terminal programs (`HANNAH_WORKFORCE_EXTENDED_COMMANDS=1`) belong only with a working sandbox or inside a container.
- **Live models:** no live model has carried a whole task end to end in the tests; they use a scripted stand-in.
- **Joining calls:** HANNAH doesn't join Zoom, Google Meet or Microsoft Teams calls as a participant; live notes record your own device instead.
- **A whole remote desktop:** a cloud computer has a browser and a terminal, not a desktop, so the live view streams the browser.
- **Voice and desktop control:** Talk takes turns rather than being full duplex, and desktop control has only a macOS adapter.

---

## Robots

**Beta. Tested with HANNAH's built-in simulators only.** Nothing here has run in Gazebo, with ROS 2 or MoveIt 2, or on a physical robot. HANNAH is not safety-certified, and its Stop button is a software request, not an emergency stop.

![HANNAH's Robots screen during a simulated trip: the robot on its map with the planned route to the workbench, the points its range sensor returns, and a message that the robot accepted the mission, which confirms the start and not the result.](./client/public/screens/robotics.webp)

*A real run in the built-in simulator, captured by the project's own browser test.*

HANNAH tells a robot **what** to do, in named high-level capabilities; the robot's own planner and controller decide **how** to move. A language model never controls an actuator.

```text
You ask → the model picks a capability → permission → Safety Gateway (server) → your approval
   → a signed command that expires in seconds → the robot checks it again against its own limits
   → the robot's planner moves it → its state reports → the server verifies the result → you are told what was verified
```

**Try it in two minutes** (Python 3.9 or newer; nothing to install):

```bash
# 1. In HANNAH: sign in, open Robots, add a robot as "Simulated". Copy the one-time code.
cd robotics/runtime
python3 -m hannah_robot enroll --server http://127.0.0.1:3001 --code XXXXX-XXXXX
python3 -m hannah_robot run
# 2. Back on the Robots screen: pick a place, ask to drive there, approve it, and watch the map.
#    For the arm simulator, add --profile ../profiles/sim-arm.json to both commands.
python3 -m hannah_robot doctor     # checks this computer: profile, limits, credentials, server, clock
```

| You can ask for | How it is kept honest |
| --- | --- |
| Drive to a named place or a point, return to the dock, visit points and report | Refused before you are asked if the goal is outside the workspace or the robot isn't ready. "Arrived" only when the robot's reported position matches the goal |
| A plan of several steps under one approval (go and come back, an inspection route, pick and place) | Every step is on the approval card and is checked again when it is sent. The plan stops at the first step that doesn't finish; nothing is retried |
| What is around it; a sensor reading; its battery | Sensor measurements with their time and source. A sensor that stopped reporting says so |
| A picture, and the regions of colour in it | Camera use is off until you switch it on for that robot. Pictures expire, and opening one is logged. It cannot say what an object is, and nothing identifies a person |
| Move an arm, grasp, release | Each asks every time. A grasp counts only when the gripper reports it is holding the object |
| "Send whichever robot is free" | HANNAH picks the nearest ready robot and says why, and why not the others. A failed task is handed to another robot only when you ask |
| Stop, pause, cancel | Never need approval. A robot that loses its link to HANNAH stops by itself |

A **physical** robot is refused all movement until a signed-in person has taken it through eleven commissioning steps, and after that every movement still asks. No physical robot has been commissioned.

Limits you tighten on a robot's page (speed, turning speed, acceleration, joint speed, link timeout) go with every command, and the robot applies the stricter of its own and yours. A robot whose controller can't apply a lower limit refuses the move instead of ignoring it. The runtime sends its profile each time it starts, so a profile changed after commissioning (a higher limit, a removed keep-out zone, a longer link timeout) withdraws the approval until it is commissioned again. Mission numbers come from a per-robot counter, so two server instances never send the same one.

**What is not done:** the ROS 2 adapter, the Gazebo robot and the container are written and have never been run (no ROS 2 or Docker on the development machine); no physical robot, no MoveIt 2, no physical camera, no learned vision model, no industrial or IoT connectors. Every requirement with its real state and the tests behind it: [`robotics/PROGRESS.md`](./robotics/PROGRESS.md).

More: [architecture](./docs/robotics/ROBOTICS_ARCHITECTURE.md), [safety gateway](./docs/robotics/SAFETY_GATEWAY.md), [security](./docs/robotics/SECURITY_ARCHITECTURE.md), [developer guide and JavaScript client](./docs/robotics/DEVELOPER_SDK.md), [deploying the runtime](./docs/robotics/DEPLOYMENT.md), [tests](./docs/robotics/TESTS.md), [`robotics/README.md`](./robotics/README.md).

---

## HANNAH Robot OS

**In progress. Not a shipped feature and not installable.** HANNAH Robot OS is a Linux-based, AI-native operating environment for the computer on a robot. It is not a ROS 2 connector, a dashboard or a chatbot: ROS 2 is one middleware component inside a broader OS that manages boot, hardware, motor controllers, sensors, safety, AI, networking, updates, recovery and the link to the parent HANNAH control plane. This is separate from the Robots beta above (the runtime already used with HANNAH's simulators) and from the HANNAH OS image descriptions under [Devices](#devices). The programme is **IN_PROGRESS (Phase 0/1)**; its tracker never marks planned, mocked or untested work as VERIFIED.

### What exists today

The [`robot-os/`](./robot-os/) tree holds image profiles and manifests, systemd units, Python services and managers, default config and safety limits, unit/simulation tests, and build/check tools. The design reuses HANNAH's model gateway, agents, memory, voice, device and robot registries, workflows, security and API rather than rebuilding them.

- **Two separate boundaries.** A deterministic safety boundary (E-stop input, watchdog, motion limits, command expiry, motor enable, fault states) starts before motion-capable services and has minimal dependencies. The AI/orchestration boundary (local/cloud model routing, natural-language intents, mission planning, memory, voice bridge) is isolated and **never** drives PWM, torque or joint velocity directly.
- **Motion path.** intent → Action Engine/permission → server Safety Gateway → signed command → onboard Safety Gateway → Motor Controller Manager → validated controller interface → embedded controller. Lost communication, a stale command, a watchdog timeout, an E-stop or invalid feedback means a safe stop/fault state.
- **Services and boot.** systemd-targeted units for first boot, hardware discovery, motor controllers, sensors, ROS 2 runtime, navigation, perception, Safety Gateway, AI runtime, telemetry, updates and the outbound-only remote gateway. READY is emitted only when mandatory hardware, safety and profile checks pass, and motors stay disabled until those checks pass.
- **Software stop shared by every service.** The safety-gateway service is the only process that changes the safety state; it publishes it every tick, and the motor-controller service follows it, stopping the motors on an engaged or latched stop, a fault, or a state that stopped arriving. A released stop stays latched until an operator resets it: `hannah-robot-os safety engage|release|status` and `hannah-robot-os safety reset --operator <name>`. Speed-ups are limited to the configured acceleration; slowing down never is. `hannah-robot-os ready` passes only when each required service reported ready within the last 5 seconds. This is coordination between processes, not a safety-rated stop.
- **Commands from the parent.** Signed commands are checked once: accepted nonces can be kept on disk, a repeated command gets its first answer instead of a failure, and a malformed one is refused rather than crashing the service.
- **Hardware managers.** A simulated serial motor controller and a generic `ros2_control` interface exist; encoder feedback is simulated. A sensor registry with timestamp/frame checks and health handling exists, and an unhealthy required sensor blocks readiness. Physical controller families (ODrive, CANopen, Modbus) and board targets (Raspberry Pi 5, Jetson Orin) are not supported.
- **Offline operation and updates.** Signed manifests with hash, size, signer and signature checks, staged A/B slot state and rollback, a bounded offline queue, and a draft parent-API contract. TLS/signature transport, production signing infrastructure and bootloader/image integration are still pending.
- **OS foundation.** Ubuntu Server 24.04 LTS is selected for desktop/edge, robotics development and developer profiles; Ubuntu Core 24 is the evaluated target for unattended industrial/IoT profiles; Yocto is deferred until a validated board target exists. Version choices must be re-checked against upstream release pages before the first image build.

### Verification and limits

**62 unit/simulation/smoke tests pass** on a macOS arm64 development host (`python3 -m pytest -q robot-os/tests`): motor-controller commands (valid, expired, over-speed, raw-AI rejection, E-stop and watchdog timeout, the acceleration limit), Safety Gateway denials and the latched stop, the shared stop across two real service processes (including a gateway that stops reporting), the service readiness gate with fresh status only, sensor health, update-manifest tamper rejection, A/B rollback and recovery, the bounded offline queue, signed commands (re-delivery, restart, malformed input), hardware-discovery abstraction, serial and CAN transports, the service-runtime CLI, and five image-profile manifests. The build script honestly reports missing tools instead of building an image. The earlier [test report](./docs/HANNAH_ROBOT_OS_TEST_REPORT.md) records the first 18.

What has **not** been run: an OS image build or boot (no Docker, QEMU, snapcraft or `ubuntu-image` on the host), systemd service startup (macOS), ROS 2 Jazzy/Gazebo/Nav2 (no runtime installed), and any physical motor, sensor or commissioning. There are no production signing keys, no live provider credentials in the environment and no independent security or functional-safety reviewer ([blockers RB1–RB6](./docs/HANNAH_ROBOT_OS_BLOCKERS.md)). **No safety certification is claimed.** The physical E-stop is independent hardware; the app's Stop button is not one. Threats and standards (ISO 3691-4, ISO 12100, ISO 13849, IEC 62443, ISO 10218, ISO/TS 15066, ISO 13482, IEC 61508, IEC 60204-1, ISO 13850) are listed as input for a future assessment in the [security document](./docs/HANNAH_ROBOT_OS_SECURITY.md), not as evidence of conformance.

The [implementation tracker](./docs/HANNAH_ROBOT_OS_IMPLEMENTATION_TRACKER.md) records every phase as VERIFIED, IMPLEMENTED, IN_PROGRESS, NOT_STARTED or BLOCKED with its evidence; the [hardware compatibility matrix](./docs/HANNAH_ROBOT_OS_HARDWARE_COMPATIBILITY.md) records that nothing has been physically commissioned. Build and deployment steps are drafts: [build guide](./docs/HANNAH_ROBOT_OS_BUILD_GUIDE.md), [deployment guide](./docs/HANNAH_ROBOT_OS_DEPLOYMENT_GUIDE.md).

---

## Devices

**Beta. Tested with HANNAH's own simulated devices only.** No physical device has been connected, no profile for a real product ships, and no HANNAH OS image has been built. HANNAH is not a safety system: a lock, a heater or a machine keeps its own protections.

![HANNAH's Devices screen: one hub connected, a simulated room sensor reporting a live temperature, and a simulated fan that is on, with a message confirming that an automation was created.](./client/public/screens/devices.webp)

*A real run with HANNAH's server, hub and simulated devices, captured by the project's own browser test.*

A **hub** (HANNAH Edge, [`hannah-os/runtime`](./hannah-os/runtime/), Python 3.9+, standard library only) runs on a computer on the same network as your devices. It speaks to them and opens a signed connection to the server; nothing connects in. The app never talks to a device.

**Adding a device needs no code.** Pick it from the list, give HANNAH its manual, or describe it with a form (the Hardware Studio). The hub then connects and reports what it heard, and only after that can you switch the device on and choose what HANNAH may change.

**Discovery is read-only and person-initiated.** The hub can list USB metadata (vendor and product IDs are kept separate from readable labels; no device is opened or written), serial ports, one allowed `.local` DNS-SD service type (mDNS), and MQTT topics. Each query runs in a short-lived child process with a wall-clock limit, and each built-in adapter runs in its own child process, so one failed worker is reported for its device without taking the others down. These workers have the hub's own user and permissions — they are not a sandbox. QR codes can preselect a compatible profile using an installed profile ID; a QR URL is never fetched. No arbitrary network scan, physical network service or physical camera scan was tested. A dependency-free [JavaScript device SDK](./hannah-os/sdk/devices/js/README.md) covers profile preflight and save, devices through the Action Engine, workflows and declarative adapter manifests; third-party executable hub drivers remain unsupported.

```sh
cd hannah-os/runtime
python3 -m hannah_edge simulate                       # simulated devices: a room sensor, a fan and a lamp on MQTT, a power meter on Modbus TCP
# In the app: Devices → Add a hub. It shows this command with a one-time code:
python3 -m hannah_edge enroll --server http://127.0.0.1:3001 --code XXXX-XXXX
python3 -m hannah_edge run
# Then: Add a device → Simulated room sensor → the broker address the simulator printed.
```

What holds for every device:

- **A model never addresses a device.** It names a device and one of the points its profile lists ("temperature", "power"). It never sees a topic, a register or a URL.
- **Reading and changing are separate.** A point can be changed only if you allowed it for that device, inside its range. A lock, an actuator or industrial equipment asks every time.
- **Checked on the server, and again on the hub.** A change that can't be valid is refused with the reason before you are asked.
- **Done means the device said so.** A write the device didn't confirm is reported as not confirmed.
- **A value says how old it is.** When the hub is away, values are shown as last known, and nothing is queued for later.
- **Automations have no AI in them.** "When the temperature is above 28, switch the fan on" is approved once and then runs on the hub, also without the internet. The account's emergency stop pauses them.
- **A manual can propose, never verify.** Each value comes with the page and the line it was read from, and starts as unverified. A proposal changes nothing and is marked experimental.

Every profile shows how far it was tested: plug and play, guided, experimental, simulation, developer required or unsupported. Nothing that ships today is plug and play.

**What is not done:** real devices and real product profiles; Matter, Zigbee, Z-Wave, Bluetooth, OPC UA and Modbus over a serial line; discovery against a physical network service or a camera scan (USB, serial, mDNS and MQTT were tested with simulators and fixtures only); a model reading manuals; a marketplace for profiles; executable third-party hub drivers; building and booting HANNAH OS images; wiring the hub's self-update to the server.

More: [architecture](./hannah-os/HANNAH_OS_MASTER_ARCHITECTURE.md), [device compatibility and the profile format](./hannah-os/HANNAH_OS_DEVICE_COMPATIBILITY.md), [security](./hannah-os/HANNAH_OS_SECURITY_ARCHITECTURE.md), [deployment](./hannah-os/HANNAH_OS_DEPLOYMENT_GUIDE.md), [tests](./hannah-os/HANNAH_OS_TEST_REPORT.md), [what is blocked](./hannah-os/HANNAH_OS_BLOCKERS.md), and [every requirement with its real state](./hannah-os/HANNAH_OS_IMPLEMENTATION_TRACKER.md).

---

## MCP integration

HANNAH includes a Model Context Protocol server, so MCP hosts (IDEs, desktop assistants) can talk to her.

| Tool | Purpose |
| --- | --- |
| `hannah_chat` | Send a prompt with optional history and mode; returns `{ reply, emotion }`. |
| `hannah_status` | Check API and provider readiness without revealing credentials. |
| `hannah_models` | List configured models. |

**Local (stdio):** run `npm run dev:server`, then add this to your MCP host:

```json
{
  "mcpServers": {
    "hannah": {
      "command": "node",
      "args": ["/absolute/path/to/repo/server/mcp-stdio.mjs"],
      "env": { "HANNAH_API_URL": "http://127.0.0.1:3001" }
    }
  }
}
```

**Remote (Streamable HTTP):** connect to `https://your-domain/mcp` with the credential you already have: `Authorization: Bearer <hk_ developer key or operator token>`, or your Groq key in `X-Groq-API-Key`. Each tool call runs with that credential's limits and budget. It works on serverless hosting too. `MCP_ENABLED=false` turns the endpoint off; `MCP_API_TOKEN` (`openssl rand -hex 32`) is an optional extra token that acts as the operator. Hosts that need OAuth discovery require an OAuth gateway in front.

The MCP server exposes no shell, file, messaging or computer-control tools. See [`docs/API-INTEGRATION.md`](./docs/API-INTEGRATION.md).

**HANNAH as an MCP client.** List outside Streamable HTTP servers in `HANNAH_MCP_SERVERS` and their tools become available in chat for sessions with the operator token. Each call goes through the Guardian and an approval card that shows the server, tool and arguments, because HANNAH can't know what an outside tool changes. URLs must be https, or http on localhost. [`server/mcp-client.js`](./server/mcp-client.js) is tested against HANNAH's own MCP server.

**Agent2Agent (A2A).** `GET /.well-known/agent-card.json` serves HANNAH's agent card, and `POST /api/a2a` accepts JSON-RPC `message/send` with text parts. Remote agents get conversation only, with no device tools, memories or account data. They use the same credentials as the API.

---

## Desktop files and terminal

In the desktop app, **Settings → Desktop access** lets you share folders with HANNAH. The Research and Coding agents (and HANNAH herself) then get five tools: `desktop_folders`, `desktop_list_files`, `desktop_read_file`, `desktop_write_file` and `desktop_run_command`.

The rules live in the `HannahDesktop` plugin ([`client/plugins/desktop-tools`](./client/plugins/desktop-tools)), which runs in Electron's main process, outside the web page and the AI model:

- **Folders you pick.** Folders are added only through the system folder dialog, as read-only or read-write. The whole drive, your home folder, system folders and folders holding keys (`.ssh`, `.aws` and so on) are refused.
- **Paths stay inside.** Every path is resolved, symlinks included, and must stay inside its shared folder. Reads are limited to 256 KB of text.
- **Writes ask first.** Writing needs a read-write folder and your yes in a native dialog that shows the path and the start of the content.
- **Commands ask first.** Each command shows the exact command line and folder in a native dialog: **Run once**, **Always allow this exact command here**, or **Cancel**. Commands run one program without a shell (no pipes, redirects, `&&` or variables), with a minimal environment, a 60-second limit and 100 KB of output. `sudo`, shells, disk tools and system-service tools are never run.
- **Your record.** Recent reads, writes and commands are listed in Settings, and removing a folder revokes its access and its always-allowed commands.
- **Optional sandbox.** Turn on **Run commands in a Docker sandbox** for a folder, and its approved commands run in a throwaway container instead of on your computer.
  - **What it sees:** only that folder, read-only if you shared it read-only.
  - **Network:** none unless you allow it.
  - **Limits:** no added privileges, your user ID, and memory, CPU and process limits.
  - **Image:** your choice, `node:22-bookworm-slim` by default.
  - **Needs:** Docker Desktop or Docker Engine.

On Windows, `.cmd` and `.bat` programs (such as `npm`) can't run without a shell; run `node`, `git` or `python` directly instead.

### Your screen, apps and startup routine

The desktop app can do three more things, also from **Settings → Desktop access** and in chat:

- **Look at your screen when you ask.** Ask "what's on my screen?" or "explain this error".
  - HANNAH asks first: **Look once** or **Allow for 15 minutes**. While allowed, the menu bar or tray and an in-app banner show it, with **Pause** and **Stop**.
  - One screenshot goes through the server to a vision model you can use, and only the answer comes back. Private mode keeps it on self-hosted models.
  - Nothing is saved, and this tool only looks. Using your apps is separate and needs its own permission; see [HANNAH uses your apps](#hannah-uses-your-apps-macos).
  - On macOS, turn on HANNAH in **System Settings → Privacy & Security → Screen & System Audio Recording**.
- **Open apps:** say "open VS Code with my project".
  - HANNAH finds the app from your system's launchers and asks first, unless you chose "always".
  - She says it's open only when she sees its process running. With a project folder, she also checks that the app's window shows that folder (this needs Accessibility permission on macOS).
- **Startup routine:** apps, links and waits, run in order when you sign in, with a history.
  - It's off until you turn on **Start HANNAH when I sign in**, which adds HANNAH to your system's login items.
  - Saving a routine shows every step first.

### HANNAH's browser and study notes

- **HANNAH's browser:** ask "find a GATE operating systems lecture on YouTube and make PDF notes" or "look this up".
  - HANNAH uses her own browser window, visible and signed out, after you allow it once.
  - She asks before typing anything other than a search, and before pressing buttons that send, order, post or change something.
  - She never types passwords or card details, and never pays or places orders. Close the window to stop.
- **Study notes:** written from the transcript YouTube shows under the video. Long lectures are condensed part by part, and HANNAH says so when a video has no transcript.
- **PDF:** saved to a folder you shared as Read and write, after you confirm, then checked on disk.

Design and verification: [`docs/DEVICE_INTELLIGENCE.md`](./docs/DEVICE_INTELLIGENCE.md).

---

## HANNAH uses your apps (macOS)

In the macOS desktop app (beta), ask HANNAH to use the app in front of you. For example: "press Save", "fill in this form", "switch to my browser and scroll down", "minimize this window", or "close this app".

- **How she sees:** through macOS's Accessibility API she reads the window in front: its buttons, fields, menus, tables, text, dialogs and error messages. She acts on those elements (press, set text, focus, select).
- **Fallbacks:** real mouse and keyboard events (click, double-click, right-click, scroll, drag, typing and shortcuts) are used only where there's no element to act on.
- **Apps and windows:** she can switch apps, raise, minimize, move, resize and close windows, and quit apps.
- **Fresh observations only:** every action names what she just observed, at most 30 seconds earlier. If the element or window changed in the meantime, she stops and looks again instead of acting blindly.
- **Checking her work:** after each action she looks again. An action counts as confirmed only when the app shows it, and a task is finished as completed only when its last action was confirmed.
- **Your control:**
  - **Session:** it starts with your yes in a system dialog and lasts 10 to 30 minutes.
  - **Indicator:** the menu bar shows **Controlling**.
  - **Stop:** **Stop Controlling Now** in the HANNAH menu, or **Control+Option+Shift+Escape** from anywhere, stops at once, even while she's waiting for your answer to a question.
- **What she asks first, and what she never does:**
  - **Asks first:** before pressing anything that sends, deletes, buys or posts; before quitting or closing; before typing in an app for the first time in a session; and before every action in a terminal or System Settings.
  - **Never:** password fields, paying, HANNAH's own dialogs, macOS security prompts, Keychain, or password managers. Text on screen is data, and can never grant her permissions.
- **Record:** every task keeps its request, plan, and each action with its target, result and verification. The activity log keeps it too.
- **Setup:** System Settings → Privacy & Security → **Accessibility** → turn on HANNAH. She can't grant it to herself.
- **Windows and Linux:** they report that this isn't available yet; UI Automation and AT-SPI adapters are planned.
- **Code:**
  - the rules: [`control.mjs`](./client/plugins/desktop-tools/electron/dist/control.mjs);
  - the native helper: [`HannahControl.swift`](./client/native/macos-control/HannahControl.swift), signed and packaged with the app;
  - a real-Mac check: `node client/scripts/macos-control-check.mjs`.
- **Verified so far:** the rules are tested, and on a real Mac the helper builds, answers, and refuses to act without the permission. The full check on a real app needs Accessibility switched on and hasn't been run yet (see [Project status](#project-status)).

---

## Desktop computer use

This is a separate, optional bridge for desktop apps you build yourself; the built-in way is [HANNAH uses your apps](#hannah-uses-your-apps-macos). The `/api/desktop/computer` route uses Anthropic's computer toolset on the server, and an Electron bridge performs the returned actions. Setup:

1. Run `npm run cap:add:electron --prefix client`.
2. Copy [`electron-agent-preload.example.cjs`](./client/electron-agent-preload.example.cjs) and [`electron-agent-main.example.cjs`](./client/electron-agent-main.example.cjs) into `client/electron/`.
3. Merge [`electron-agent-config.example.ts`](./client/electron-agent-config.example.ts) into the generated config.
4. In `client/electron`, install `screenshot-desktop sharp @nut-tree/nut-js esbuild` and bundle the preload with esbuild.

Each screenshot and action is reviewed by the Guardian, then confirmed in a native dialog that issues a one-use token. The renderer never sees the Anthropic key. Screenshots and task text go to Anthropic.

---

## Command-line tool

[`cli/`](./cli) is `hannah`, a dependency-free tool for using HANNAH from a terminal (Node 20+).

```bash
node cli/hannah.mjs login --server https://hannah.eliteforums.in --email you@example.com   # asks for the password
node cli/hannah.mjs status                  # server health and your account
node cli/hannah.mjs ask "What's on my agenda?"
node cli/hannah.mjs chat                    # streamed conversation; /clear starts over, /exit leaves
node cli/hannah.mjs workflows               # list your workflows
node cli/hannah.mjs run <workflowId>        # run one and watch each step finish
node cli/hannah.mjs channels                # your chat apps
node cli/hannah.mjs logout
```

- **Other ways to log in:** `login --groq-key …` (chat only) or `--token …`.
- **Credentials:** saved in `~/.config/hannah/config.json` (or `$HANNAH_CONFIG`) with owner-only permissions (0600), and never printed.
- **Tests:** `cd cli && npm test` runs the tool against the real server.

---

## Voice and calls

- **Languages:** English (`en-US`), Hindi (`hi-IN`) and Marathi (`mr-IN`), subject to platform support.
- **Input:** the microphone stays off until you press **Speak**. Choose the engine in **Settings → Voice**: the browser's or device's recognition, or **Groq Whisper**, which records on the device and transcribes each utterance with Groq. Whisper works in any browser that can record, including with a visitor's own Groq key.
- **Output:** spoken replies are off by default; HANNAH speaks during talk mode (hands-free voice input), and the Voice replies toggle turns spoken replies on for typed messages too (stored on the device). Choose **Automatic** (Mithi when `MITHI_TTS_URL` is set, otherwise the device voice), **Device voice** (offline, with a voice picker), or **OpenAI voices** (`gpt-4o-mini-tts`, ten voices; needs an OpenAI key saved to your account or on the server). If a hosted voice fails, HANNAH falls back to the device voice. The voice layer is in [`VoiceEngines.ts`](./client/src/services/VoiceEngines.ts) and [`server/voice.js`](./server/voice.js).
- **“Hey HANNAH” wake word:** turn it on in Settings → Voice to start a voice turn hands-free. In the desktop app it keeps listening while the window is hidden, and the menu bar says so. On Android, a native foreground service keeps listening in the background, with a notification and Stop button the whole time (built in 1.5.0, not yet run on a phone: [KI-28](./docs/architecture/KNOWN_ISSUES.md)). In a desktop browser, it listens only while the tab is open. On iPhone, which doesn't allow it, say **"Hey Siri, talk to HANNAH"** (or use the Shortcuts app): HANNAH opens ready to listen. Detection runs on the device with [Vosk](https://alphacephei.com/vosk/) (Kaldi compiled to WebAssembly) listening for only two things, "hey hannah" or anything else, so it can't transcribe speech and no audio leaves the device. The first time, the app downloads the ~41 MB English model from the HANNAH website and keeps it. It pauses while HANNAH is listening or speaking. It can't tell "Hey Anna" from "Hey Hannah". Code: [`WakeWord.ts`](./client/src/services/WakeWord.ts); the website build adds the model with [`scripts/wakeModel.ts`](./client/scripts/wakeModel.ts) (pinned SHA-256).
- **Interrupt by talking (barge-in):** while HANNAH speaks, the microphone listens with echo cancellation and she stops as soon as you start talking. This audio isn't recorded or sent anywhere. Turn it off in Settings → Voice.
- **Calls (Pinecall):** need `VITE_PINECALL_AGENT_ID`, a server-side `PINECALL_TOKEN_URL` that returns `{ token, server, expires_in }`, network access and microphone permission. The Pinecall API key never goes to the client.

```bash
hf download Oomni/mithi-v1-flash --local-dir ./mithi-v1-flash
pip install -r ./mithi-v1-flash/requirements.txt -r server/mithi-service-requirements.txt
python -m spacy download en_core_web_sm
MITHI_MODEL_PATH=./mithi-v1-flash uvicorn server.mithi_tts_service:app --port 8010
```

---

## Mobile, desktop and PWA builds

| Setting | Value |
| --- | --- |
| App name / ID | `HANNAH` / `com.hannah.companion` |
| Web directory | `client/dist` |
| Native projects | `client/android`, `client/ios` (checked in) |
| Desktop | Capacitor Electron (`@capawesome/capacitor-electron`), generated in CI |

```bash
npm run cap:sync --prefix client          # build + sync + native patches
npm run cap:run:android --prefix client
npm run cap:run:ios --prefix client
npm run cap:run:electron --prefix client
```

On a physical phone, `localhost` is the phone itself. Set `VITE_API_BASE_URL` to an HTTPS API or your computer's LAN address, and add that origin to `CLIENT_ORIGIN`.

The patch scripts ([`patch-capacitor-gradle.mjs`](./client/scripts/patch-capacitor-gradle.mjs), [`patch-capacitor-ios.mjs`](./client/scripts/patch-capacitor-ios.mjs)) fix third-party native modules:

- Android: a Kotlin Gradle plugin classpath, Java 17 targets and the microphone permission.
- iOS: a zlib linker flag, the privacy manifest and usage descriptions.

**PWA:** auto-updating service worker. The app shell is precached and the avatar is cached on first use. Run `npm run build:analyzer --prefix client` for a bundle report, and `npm run bundle:size --prefix client -- --strict` to enforce the size budget.

**Avatar:** `npm run models:draco` writes the Draco-compressed `client/public/models/avatar.draco.glb` (7.4 MB → 2.6 MB). Point `VITE_AVATAR_MODEL_URL` at it for faster loads. The avatar is scaled to the viewport and plays the model's idle animation, and the [avatar rig](./client/src/services/avatar/AvatarRig.ts) brings her to life on top of it:

| She… | How |
|---|---|
| Shows each reply's emotion | Smiles (a fang grin when happy), droops her eyes and head when sad, narrows her eyes and puts her hands on her hips when angry, widens her eyes with an "o" mouth when surprised, and rests a hand on her cheek when thinking. |
| Reacts when the emotion changes | Waves when she becomes happy, turns away with a "hmph" when angry, jumps when surprised, sighs when sad. She also waves hello when she first appears. |
| Follows the conversation | Leans in and tilts her head while you speak, takes the thinking pose while a reply is on its way, and moves her mouth, nods and gestures while she talks (also for text replies, for about as long as reading them takes). |
| Feels alive | Blinks (sometimes twice), breathes, sways, glances around when idle, and follows your pointer with her head and eyes. Tap her and she giggles. |

With *reduce motion* turned on in the operating system, she keeps her expressions but gestures and sway are toned down. The rig works with other rigged GLB files too. It finds face shapes by common blend-shape names (ARKit, VRM, Ready Player Me, or plain `smile` and `blink`) and body bones by common bone names (Mixamo, VRM, humanoid). Anything a model lacks is skipped. The bundled model's blend shapes were exported in the wrong units, which used to make its face disappear. They're repaired on load, and its painted mouth gets a small animated mouth for talking.

### CI and releases

[`.github/workflows/build.yml`](./.github/workflows/build.yml) runs on pull requests, pushes to `main`, `v*` tags and manual dispatch:

| Job | What it checks or builds |
| --- | --- |
| Security and test gates | `npm audit` (high and critical), Vitest, server tests, backend Pytest. |
| Browser end-to-end | Production build plus Playwright against a mocked API. |
| Web and PWA | Draco avatar, build, bundle-size budget; uploads `hannah-web-pwa`. |
| Electron (macOS, Windows, Ubuntu) | Generates the Electron project, audits it, packages it, and checks installer size. Unsigned unless signing secrets exist. |
| Android | SDK 36 and NDK 29; debug APK, or a signed APK and AAB for releases. |
| Red-team suite | Runs [`scripts/run_redteam.py`](./scripts/run_redteam.py) against a live server when `HANNAH_API_TOKEN` and `GROQ_API_KEY` secrets exist. |
| Publish release installers | On a `v*` tag or a manual release dispatch. |

[`.github/workflows/nightly.yml`](./.github/workflows/nightly.yml) repeats the audits and tests nightly and fails if code adds an approval bypass, such as a `skipConfirmation` flag or a `*_BYPASS` switch.

To release: `git tag vX.Y.Z && git push origin vX.Y.Z`, or run the workflow manually with **publish release** enabled. Signed iOS builds need the repository variable `IOS_SIGNING_ENABLED=true` and the secrets `IOS_CERTIFICATE_BASE64`, `IOS_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`, `APPSTORE_ISSUER_ID`, `APPSTORE_API_KEY_ID` and `APPSTORE_API_PRIVATE_KEY`.

---

## Deployment

### Vercel (recommended)

1. Import the repository into Vercel; the root [`vercel.json`](./vercel.json) defines the `client` and `server` services.
2. Nothing is required for bring-your-own-key visitors. To offer your own models or voice and desktop features, set `HANNAH_API_TOKEN` and provider keys such as `GROQ_API_KEY` in the server service. Leave `VITE_API_BASE_URL` empty.
3. Set `VITE_SITE_URL` to your production origin for SEO metadata.
4. Deploy, then check with `curl https://your-domain/api/health`.
5. **For accounts, workflows, chat apps and device pairing:** add the database, vault key and scheduler, from the app or by hand.
   - Signing the Android, iOS, macOS, Windows and Linux apps is covered there too.

Use `vercel dev` to test both services locally.

### Self-hosting

- **API:** Node 20+, `npm install --prefix server`, set `NODE_ENV=production` and your environment, then run `npm start --prefix server` behind HTTPS.
- **Client:** run `npm run build`, publish `client/dist` to any static host with SPA fallback, and set `VITE_API_BASE_URL` at build time if the API is on another origin.
- **Docker:** the [`Dockerfile`](./Dockerfile) builds the server and the web app into one image, and [`docker-compose.yml`](./docker-compose.yml) runs it with Postgres 16 ([setup](#10-docker-self-hosting)).

### Production checklist

- [ ] HTTPS everywhere: client, API, model downloads, token issuers.
- [ ] If you set `HANNAH_API_TOKEN`, make it strong and share it out of band with trusted users only. Without it, the server only forwards visitors' own Groq keys.
- [ ] `CLIENT_ORIGIN` set to exact production origins.
- [ ] Keys in the host's secret manager; nothing secret in `VITE_*` or committed files.
- [ ] Provider quotas, timeouts and billing alerts configured.
- [ ] Rate limits backed by a shared store if you run more than one instance (the built-in limiter is per process).
- [ ] Avatar, model and font licenses checked for your distribution.

See [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md).

---

## API reference

There are two ways to authenticate:

- **Your own Groq key:** send `X-Groq-API-Key: gsk_…` with no `Authorization` header. This works for `/api/agent`, `/api/chat`, `/api/models`, `/api/providers`, `/api/catalog`, `/api/orchestrate`, `/api/voice/*`, `/api/a2a`, `/api/route/preview`, `/v1/chat/completions`, `/v1/models` and `/v1/usage` only, and the key goes only to Groq's official API.
- **Operator token:** send `Authorization: Bearer <HANNAH_API_TOKEN>`. This works for every route.
- **Account:** a session (cookie, or `Authorization: Bearer hs_…` in native apps) or a developer key (`Authorization: Bearer hk_…`). This works for the model routes above plus `/api/orchestrate`, `/api/voice/*`, `/api/a2a` and the account's own `/api/account/*` routes. Developer keys can't manage the account.

`/api/health`, `/api/account/status`, `/api/db/status`, sign-in and the A2A agent card are public. Full examples are in [`docs/API-INTEGRATION.md`](./docs/API-INTEGRATION.md).

| Method and route | Purpose |
| --- | --- |
| `GET /api/health` | `{ status, provider, ready }`. Public. |
| `GET /api/health/agent` | Probes the optional Python fallback. |
| `GET /api/providers` | Providers configured on the server. |
| `GET /api/models?provider=` | Models available for a provider. |
| `GET /api/catalog` | Every provider's models with tool, vision and context flags and known list prices, for the model advisor. No credentials. |
| `POST /api/route/preview` | Which provider and model Auto would use for `messages` under `routing` (`{ mode, providers?, maxTier?, localOnly? }`), with the reason, limitations, alternatives and a cost estimate when a verified price exists. Calls no model. `409` with `no_private_route` or `no_route` when nothing fits. |
| `GET /v1/models` | OpenAI-compatible model list: `hannah-auto` plus `<provider>/<model>` for each usable model. |
| `POST /v1/chat/completions` | OpenAI-compatible chat completions with `"stream": true` over SSE, tool calls (returned for the caller to run), `hannah-auto` routing (add `"hannah": { "routing": { "mode": "private" } }` to choose a [routing mode](#model-routing)), normalized errors and the daily budget. Text content only. |
| `GET /v1/usage` | Today's estimated spend and budget for this credential. |
| `POST /api/agent` | One agent step: messages plus JSON-schema tools in; reply, tool calls, emotion, model, provider, latency and usage out. |
| `POST /api/chat` | Plain chat (user and assistant messages only); returns `{ reply, emotion }`. |
| `POST /api/orchestrate` | Agent team planning (`phase: "plan"`) and verification (`phase: "verify"`). |
| `GET /api/voice/providers` | Hosted voice engines this caller can use. |
| `POST /api/voice/speak` | Text → MP3 with an OpenAI voice. |
| `POST /api/voice/transcribe` | Raw audio body → text with Groq Whisper (`?language=en`). |
| `GET /api/account/status`, `GET /api/db/status` | Whether accounts are on, the database provider and schema version, and the signed-in user. Public. |
| `POST /api/account/register`, `/login`, `/logout`, `/logout-all` | Email and password accounts. |
| `GET`, `PUT`, `DELETE /api/account/credentials/:provider` | Provider keys in the encrypted vault. |
| `GET`, `POST`, `DELETE /api/account/api-keys` | Developer API keys (shown once). |
| `GET`, `PUT /api/account/data/:namespace` | Sync documents with optimistic versions (`memories`, `reminders`, `communitySkills`, `chatHistory`, `settings`, `automations`, `automationSchedules`, `projects`, `projectChats`). |
| `POST`, `GET /api/account/shares`, `DELETE /api/account/shares/:id` | Publish a chosen snapshot as a read-only link, list your links, delete one. Session only. |
| `GET /s/:id` | The public read-only page for a shared link (no scripts, strict CSP, noindex, `no-store`). |
| `GET`, `POST`, `DELETE /api/account/webhooks`, `POST …/:id/test`, `POST /api/account/events` | Signed webhooks. |
| `GET /api/account/audit`, `GET /api/account/export`, `DELETE /api/account` | Security log, export, deletion (needs the password). |
| `POST /api/db/test` | Operator only: try a database URL without saving it. |
| `GET /api/mcp/servers`, `POST /api/mcp/call` | Operator only: outside MCP servers' tools. |
| `GET /.well-known/agent-card.json`, `POST /api/a2a` | A2A agent card and JSON-RPC `message/send`. |
| `POST /api/tts` | Text plus `en`, `hi` or `mr` → WAV through Mithi. |
| `GET /api/pinecall/token` | Short-lived call credentials from your issuer (503 if not configured). |
| `POST /api/desktop/computer` | Anthropic computer-use step for the Electron bridge. |
| `POST /api/feedback` | In-app feedback to Discord or MongoDB (503 if neither is set). |
| `POST /api/report-content` | Metadata-only report of an AI reply (message id and reason). |
| `POST /api/events` | Allow-listed metadata events, written to the server log. |
| `POST /api/undo` | Logs an undo request for a recorded side effect. |
| `GET`/`POST /api/sync/memory` | Versioned store for end-to-end encrypted memory blobs. Kept in the database when `DATABASE_URL` is set; otherwise in memory only and lost on restart. |
| `GET /api/presence` | A short status line for the UI. |
| `POST /mcp` | MCP Streamable HTTP, with your developer key, the operator token or your Groq key. |
| `POST /api/research` | Research a question; streams each step, then the answer with sources. |
| `POST /api/documents/compose` | Write and build PPTX, PDF, DOCX or XLSX files from a request; streams its steps. |
| `POST /api/documents/create`, `/read`, `/convert` | Render a ready description, read an uploaded file, convert a file. |
| `GET /api/account/documents`, `/api/account/research` | An account's files and research history (list, download, keep, delete). |

Use the [JavaScript SDK](./sdk/js), or any OpenAI SDK pointed at `/v1`:

```bash
curl -s http://localhost:3001/v1/chat/completions \
  -H "X-Groq-API-Key: $GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"hannah-auto","stream":true,"messages":[{"role":"user","content":"Hello, HANNAH!"}]}'
```

The app's own chat route:

```bash
curl -s http://localhost:3001/api/chat \
  -H "Authorization: Bearer $HANNAH_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"cloud","messages":[{"role":"user","content":"Hello, HANNAH!"}]}'
# {"reply":"Hello! It's lovely to hear from you.","emotion":"happy"}
```

---

## Project structure

```text
.
├── client/                     # React + Vite app (web, PWA, Capacitor, Electron)
│   ├── src/
│   │   ├── components/         # Screens and UI (ChatUI, Dashboard, AppShell, …)
│   │   ├── services/           # Agent, safety, routing, stores, native, voice
│   │   ├── __tests__/          # Vitest unit tests
│   │   ├── App.tsx             # Routes and connection gate
│   │   └── index.css           # Design tokens (deck cards, tones, glass tiles)
│   ├── public/models/          # Avatar GLB files
│   ├── android/ · ios/         # Checked-in native projects
│   ├── native/macos-control/   # Swift helper: Accessibility API + mouse and keyboard (computer control)
│   ├── plugins/desktop-tools/  # Desktop rules in Electron's main process: files, commands, sandbox,
│   │                           #   screen, apps, browser, computer control, iMessage and Signal
│   ├── scripts/                # Avatar compression, native patches, size checks, macOS control build and check
│   └── playwright.config.ts
├── cli/                        # `hannah` command-line tool
├── examples/hannah-plugin/     # Example plugin (an MCP server) with tests
├── server/                     # Express API, providers, MCP, sync, feedback
│   ├── channels.js · channel-drivers.js  # Chat apps: Telegram, Slack, Discord, Google Chat, Teams, WhatsApp
│   ├── connectors.js · web.js  # Connector directory and sign-in, web search and page reading
│   ├── hosting-setup.js        # "Set up HANNAH on Vercel and Supabase"
│   ├── workflows/              # Workflow engine, runtime and router
│   ├── providers/              # Provider catalog and runtime adapters
│   ├── db/                     # Bring-your-own database: adapters and migrations
│   ├── accounts.js · vault.js  # Accounts, sessions, encrypted key vault, sync
│   ├── gateway.js · v1.js      # Model gateway and OpenAI-compatible /v1
│   ├── orchestrate.js          # Agent team planning and verification
│   ├── voice.js                # Hosted voice engines
│   ├── mcp-client.js · a2a.js  # MCP client and Agent2Agent endpoint
│   ├── webhooks.js             # Signed account webhooks
│   ├── scripts/                # db:check / db:migrate, skill signing, workflow and trigger proofs
│   └── *.test.js               # node:test suites
├── sdk/js/                     # Dependency-free JavaScript SDK
├── robotics/                   # Robot runtime (Python), simulators, worlds, profiles, robot SDK, ROS 2 package (not yet run)
├── robot-os/                   # HANNAH Robot OS (in progress): onboard services, image profiles, systemd units, tests; no image built or booted
├── hannah-os/                  # HANNAH Edge hub (Python), device profiles, simulated devices, SDK, image descriptions (not built), tracker and docs
├── shared/                     # Marketplace catalog, model profiles, trusted skill publishers
├── backend/                    # Optional FastAPI fallback, tools, audit log, tests
├── apps/                       # Alternate frontend and Python-enabled Electron shell
├── e2e/                        # Playwright end-to-end tests
├── scripts/                    # Red-team, evaluation and background runner scripts
├── redteam/                    # Red-team prompts
├── ebpf/                       # Opt-in Linux metadata sensor (sudo npm run dev:ebpf)
├── docs/                       # Product docs: integration, privacy, operations, store docs, and the Robot OS / HANNAH OS / robotics guides
├── agent_profiles.yaml         # Task profile overrides
├── vercel.json                 # Vercel services and rewrites
└── .github/workflows/          # build.yml and nightly.yml
```

---

## Development commands

| Where | Command | Does |
| --- | --- | --- |
| root | `npm run dev` | Server and client together. |
| root | `npm run dev:client` / `dev:server` | One of them. |
| root | `npm run dev:with-python-fallback` | Server, client and Python fallback. |
| root | `npm run build` | Install client dependencies and build. |
| root | `npm run mcp:stdio` | Run the MCP stdio server. |
| client | `npm run build` | `tsc -b && vite build` (strict, with no unused locals or parameters). |
| client | `npm run lint` | ESLint: bug rules only (hooks misuse, unreachable code, duplicate keys…); errors fail CI. |
| client | `npm test` / `test:watch` / `test:chaos` | Vitest. |
| client | `npm run test:e2e` | Playwright. |
| client | `npm run preview` | Serve the production build. |
| client | `npm run models:draco` | Compress the avatar. |
| server | `npm run lint` | ESLint for the server's plain JavaScript (no type checker there); errors fail CI. |
| server | `npm test` | `node --test`. |
| server | `npm start` | Run the API. |
| server | `node scripts/workflow-proof.mjs` | Workflows against real services (GitHub, httpbin), including a killed and restarted server. |
| server | `node scripts/triggers-proof.mjs` | Webhooks, HMAC, events, credentials and schedules, run the way Vercel runs them (about 2 minutes). |
| client | `node scripts/macos-control-check.mjs [--vscode]` | Computer control on a real Mac (needs Accessibility; takes the focus for about 20 seconds). |
| client | `node scripts/build-macos-control.mjs` | Build the macOS control helper (universal binary). |
| cli | `npm test` | The command-line tool against the real server. |
| examples/hannah-plugin | `npm test` | The example plugin through HANNAH's MCP client. |

**Adding a provider:** add a preset to [`catalog.js`](./server/providers/catalog.js), reuse or add an adapter in [`runtime.js`](./server/providers/runtime.js), document its variables in `server/.env.example`, and keep its key server-side.

**Adding a voice language:** extend `SpeechLanguage` in [`types.ts`](./client/src/types.ts), update the speech services and the language picker, then test on web and one native platform.

---

## Testing

```bash
npm run lint --prefix client             # ESLint (bug rules), also run by CI
npm run lint --prefix server
npm test --prefix client                 # Vitest: safety chain, router, guardrails, stores
npm test --prefix server                 # API auth, accounts (SQLite + Postgres), gateway, team, voice, MCP client, A2A, SDK
python3 -m pip install -r backend/requirements-test.txt
python3 -m pytest -q backend/tests       # Python fallback, approvals, audit chain
npm run test:e2e --prefix client         # Playwright against real local servers (AI is a local stand-in): every screen and every control, signed in and as a guest
npm run build --prefix client
(cd robotics/runtime && python3 -m unittest discover -s tests -t .)   # robot runtime and simulators; standard library only
(cd hannah-os/runtime && python3 -m unittest discover -s tests -t .)  # device hub, protocol stacks and simulated devices; standard library only
python3 -m pytest -q robot-os/tests      # Robot OS managers, shared Safety Gateway, updates, commands; simulation only
python3 robot-os/tools/validate_manifests.py  # static check of the five image-profile manifests
```

The suites cover:

- **Safety chain:** Guardian blocks before any prompt, decline and approve paths, Strict mode blocking deletes, and failing closed.
- **Agent loop:** the tool-result loop, iteration caps and prompt-injection flags.
- **Server:**
  - token checks and rate limits;
  - accounts, vault, sync, developer keys and webhooks on SQLite and on real Postgres (PGlite);
  - team planning and verification, voice routes, the MCP client against a real MCP server, A2A, and the SDK end to end;
  - connectors' OAuth flow, and calendar and email sign-ins with and without a session in the browser;
  - the AI workforce: teammates, computers, the terminal's limits, skills and Teach mode, approvals bound to the step a person saw, routines (no self-triggering, no double runs), the vault's teammate assignment, teams and artifacts, on SQLite and Postgres;
  - the outbound address check in every IPv6 spelling, the workforce browser's proxy, and webhook and connector redirects;
  - every chat app, using real signatures (HMAC, Ed25519, RS256 tokens) against stand-in platform APIs;
  - the hosting setup, and serving the web app in Docker.
- **Robots:** the contract, both Safety Gateways, signed commands, missions, plans, the camera, commissioning and the fleet, as unit tests, on the real server with a scripted stand-in robot (SQLite and Postgres), and with the real runtime driving the built-in simulators, also in a browser. None of it is a Gazebo or hardware test ([details](./docs/robotics/TESTS.md)).
- **Robot OS:** 62 unit/simulation/smoke tests for the motor controller, the Safety Gateway and the stop shared between service processes, the readiness gate, sensor health, signed-update verification, A/B rollback, the offline queue, signed commands, hardware-discovery abstraction, service runtime and CLI tools; the image manifests pass a static check. No image build or boot, no systemd startup, no ROS 2/Gazebo run and no hardware ([report](./docs/HANNAH_ROBOT_OS_TEST_REPORT.md)).
- **Devices:** the MQTT and Modbus TCP stacks against HANNAH's own test servers, the MQTT client also against an independent broker (aedes), the hub with simulated devices, profiles and the Device Safety Gateway as unit tests, read-only USB/serial/mDNS/MQTT discovery with worker isolation, QR handling that never opens a URL, the device SDK, a descriptive loopback benchmark, the manual reader on a real PDF, and the whole chain with three real processes (server, hub, simulated devices) on the server and in a browser. No physical device, network service or camera scan.
- **Desktop rules** (`node --test` in `client/plugins/desktop-tools`):
  - folders, commands and the sandbox;
  - the browser;
  - computer control: consent, stale and changed interfaces, verification, refusals, and the emergency stop during an approval;
  - iMessage and Signal.
- **End to end:** sending a message, avatar emotion, the approval card (declining changes nothing), a rejected token, navigation, Marketplace actions, mobile navigation, a full Team run shown on the Agents screen, account sign-in, voice settings and the database setup card.

If e2e tests time out on a slow machine, run them with `--workers=1`, because the avatar load is heavy under software WebGL.

Not covered automatically: physical-device permissions, speech, calls, app resume, offline model downloads and live provider calls.

---

## Project status

**Shipped in the app:**
- everything described above under [What you can do](#what-you-can-do), the safety chain, and all six inference modes;
- device tools, Marketplace (connectors, chat apps, agents and skills), MCP, web search and research, voice and the Pinecall integration;
- research and Document Studio: search with checked citations, PowerPoint/PDF/Word/Excel from a sentence, attachments and Library;
- desktop files and terminal (with the optional Docker sandbox), and HANNAH using your apps on macOS (beta);
- desktop computer use, only in a desktop app you build with the bridge set up;
- the native and desktop builds, the `hannah` command-line tool and Docker self-hosting;
- robots, as a beta, with the built-in simulators ([Robots](#robots)).

**In progress, not shipped:**

- **AI Workforce (beta):** teammates (typed or spoken), cloud computers with a sandboxed terminal and a live view you can take control of, jobs on your own desktop, tasks, skills, routines and routine webhooks, the Secure Vault, approvals, notifications in chat apps, teams, live meeting notes, proactive suggestions and artifacts are on `main` but not in a release. Tested with a scripted model stand-in, not yet with a live model across a whole task; see [AI Workforce](#ai-workforce).
- **HANNAH Robot OS** (Phase 0/1): onboard Linux services, the safety/motor-control boundaries, signed updates and an offline gateway exist and pass 62 unit/simulation/smoke tests, but no image has been built or booted, ROS 2/Gazebo/Nav2 has not been run, no hardware has been commissioned, and no safety certification is claimed. [Tracker](./docs/HANNAH_ROBOT_OS_IMPLEMENTATION_TRACKER.md), [blockers](./docs/HANNAH_ROBOT_OS_BLOCKERS.md). See [HANNAH Robot OS](#hannah-robot-os).
- **Devices (beta):** the hub, profiles, Safety Gateway, hub-run automations, read-only discovery, QR-code profile lookup and the device SDK are on `main` but not in a release, and are proven only with HANNAH's own simulators and fixtures.

**Library modules not on a screen yet.** [`client/src/services`](./client/src/services) also holds modules that no screen uses yet. In 1.5.0 the ones that faked their work were made to work for real, with tests (`RestoredModules.test.ts`):

- **Encrypted sync:** `SyncService` (AES-256-GCM under a passphrase, PBKDF2) and `CRDTSyncProvider` (vector-clock registers that converge, with tombstones).
- **Merged memory sync:** `memorySync` (last-write-wins with deletes kept).
- **Orchestration:** `AgentOrchestrator`, where each planned step is a real agent turn, with real skeptic and devil's-advocate reviews.
- **Delegated agents:** `ResearchAgent` (parallel web workers with sources) and `FreelanceAgent`.
- **Home server:** `AgentNativeHomeService`, which really checks the HANNAH server's health.
- **PAP:** `PAPAdapter`, with OAuth and PKCE and confirmed actions.
- **Agent card:** `AgentInteropService`, built from the real tool list and A2A card.
- **Hardware:** the HANNAH device protocol over WebSocket (`WebSocketHardwareAdapter`, `HardwareBridgeService`), with paired-device answers and acknowledged commands.

Others (`KillSwitch`, `PolicyEnforcementLayer`, `EgressPolicy`, `CredentialBroker`, `MemoryRouter`, `CastOrchestrator` and more) work as libraries with unit tests, but the app doesn't route through them. Account sync (see [Accounts and your own database](#accounts-and-your-own-database)) is the sync the app uses.

**Known gaps:**

- Automations run only while HANNAH is open (a missed run happens once when it reopens).
- On the web, reminders alert only while HANNAH is open. The Android and iOS apps hand each reminder to the phone as a notification.
  - **Android 14:** it doesn't allow exact alarms by default. HANNAH then schedules an inexact one, which may arrive a few minutes late, and the Reminders card offers **Allow exact alarms**.
  - **Not yet verified:** this fix hasn't been run on a phone yet.
- **Stop** takes effect before the next step; a model request already in flight finishes first.
- Without a database, spending budgets live in server memory and reset on restart.
- Accounts use email and password only. There's no OAuth sign-in to HANNAH itself or password-reset email yet (connecting Google or Microsoft for calendar and email is separate).
- Tasks across devices and the Phone Bridge work while HANNAH is open; there's no push notification to a closed app (use the `approval.requested` webhook). A scheduled phone step fails, without anything happening later, if HANNAH isn't open on the phone.
- **"Hey HANNAH" on Android** (native, background) is built but hasn't been compiled on a dev machine or run on a phone yet. **Siri "Talk to HANNAH"** typechecks, but the iOS app doesn't build with Xcode 27 yet ([KI-23](./docs/architecture/KNOWN_ISSUES.md)).
- Calendar and email need the operator's Google and Microsoft sign-in apps; Gmail for the public needs Google's verification.
- The Marketplace has no public registry. Plugins are remote MCP servers that you add yourself; code from the Marketplace never runs inside HANNAH.
- **Computer control:** macOS only, and not yet run with Accessibility switched on. Windows and Linux adapters aren't built.
- **New integrations not yet tried with real accounts:**
  - the chat apps (Slack, Discord, Google Chat, Teams, WhatsApp);
  - iMessage and Signal;
  - connectors' vendor sign-in;
  - Groq browser search;
  - the Vercel and Supabase setup;
  - the Docker image and the command sandbox (no Docker on the test machine);
  - mail needs-reply, reply drafts, archive and labels, and Google Chat as you;
  - the phone workflow steps on a physical phone.

  Each is tested against the platform's protocol, and its real endpoints were checked. [`KNOWN_ISSUES.md`](./docs/architecture/KNOWN_ISSUES.md) tracks each one.
- **Robots are simulation only.** The ROS 2 adapter, the Gazebo robot and its container have never been run; no physical robot, arm or camera has been connected; no live model has driven the robot agents; HANNAH is not safety-certified. [`robotics/PROGRESS.md`](./robotics/PROGRESS.md) lists every requirement and what blocks it.
- **Devices are simulation only.** No physical device, broker or PLC has been connected; the Modbus TCP client has been tested only against HANNAH's own test server, and the MQTT client against that and one independent broker; discovery (USB, serial, mDNS, MQTT) has been checked with simulators and fixtures only; no HANNAH OS image has been built or booted. See [`hannah-os/HANNAH_OS_BLOCKERS.md`](./hannah-os/HANNAH_OS_BLOCKERS.md).
- **HANNAH Robot OS is not installable.** No image build or boot, no Linux/systemd integration run, no ROS 2 runtime, no physical commissioning, no production signing keys and no independent safety review; live model-driven robot agent flows are not proven end to end. See [`docs/HANNAH_ROBOT_OS_BLOCKERS.md`](./docs/HANNAH_ROBOT_OS_BLOCKERS.md).
- Memory search matches words, not meaning (no vector search yet).
- What's verified on each platform: [`docs/CAPABILITY_MATRIX.md`](./docs/CAPABILITY_MATRIX.md).
- Webhooks are delivered once, with no retries.
- No price in `shared/model-prices.json` has a verification date yet, so the app shows no dollar estimates until an operator verifies them.
- The router's measured latency and provider health are per server process, and Fastest mode needs three real replies before it uses measurements.
- The Marketplace has no third-party listings.
- iOS needs Apple signing for an installable build.
- The 3D avatar still takes a few seconds of work on slow devices when it first loads (2.6 MB, compressed).
- **The bundled avatar model is a fan-made model of a commercial VTuber character** (`client/public/models`). Replace it with an original or properly licensed avatar before distributing HANNAH commercially.

The current plan, with each brief area marked done, partial or missing, is in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

---

## Troubleshooting and FAQ

**Chat requests fail with 401.** Groq rejected your key, the token is wrong, or the server's `HANNAH_API_TOKEN` changed. Open Settings → Connection, disconnect, and connect again with a valid key or token.

**Chat requests fail but `/api/health` works.** Check that a provider is configured (`ready: true` in health) or that you entered a Groq key. Also check that `CLIENT_ORIGIN` includes your exact origin.

**`localhost` fails on my phone.** On the phone, `localhost` is the phone. Use your computer's LAN IP with `HOST=0.0.0.0` on a trusted network, or an HTTPS API.

**"Guardian stopped … before it ran."** The Guardian blocked the action; the reason is on **Memory & trust**. Rephrase the request, or lower strictness if you trust it. Approval is still required either way.

**WebLLM won't load.** It needs WebGPU and time to download a model on first use. Check `chrome://gpu`.

**The avatar doesn't appear.** Check that `client/public/models/avatar.draco.glb` (or `avatar.glb`) exists and that the console shows no WebGL errors. Large models load slowly on phones.

**Speech is silent.** Enable voice replies, pick a supported language, and make sure a voice for it is installed on the device.

**Is HANNAH a medical or mental-health service?** No. HANNAH is software, not a substitute for emergency services, clinicians, or legal or financial advice.

**Can I monetize a fork?** Not under the default license. See [License](#license).

---

## Contributing

1. Fork the repository and create a focused branch (`git checkout -b feature/your-change`).
2. Make the smallest complete change. New tools **must** go through `SafetyGuard.screen` and, if they change anything, `SafetyGuard.confirm`.
3. Never add paid tiers, sample data presented as real, or a bypass around the Guardian or approvals (the nightly check enforces the last one).
4. Update the docs and `.env.example` files when behavior changes.
5. Run `npm run build`, `npm test --prefix client`, `npm test --prefix server`, `npm run test:e2e --prefix client` and `git diff --check`.
6. Open a pull request describing what changed, why, how you tested it, and any platform limits or new variables.

Don't commit secrets, `.env` files, downloaded models, build output or generated native web assets. Good starting points are in [`docs/GOOD_FIRST_ISSUE.md`](./docs/GOOD_FIRST_ISSUE.md), and project governance is in [`GOVERNANCE.md`](./docs/GOVERNANCE.md).

To report a security issue, use GitHub's private vulnerability reporting or contact the maintainer through the repository profile. Don't open a public issue with exploit details.

---

## Further documentation

| Topic | Document |
| --- | --- |
| Architecture, decisions and roadmap | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) |
| Robots: architecture, safety, security, tests, deploying the runtime | [`docs/robotics/`](./docs/robotics/ROBOTICS_ARCHITECTURE.md), [`robotics/PROGRESS.md`](./robotics/PROGRESS.md) |
| HANNAH Robot OS: [architecture](./docs/HANNAH_ROBOT_OS_ARCHITECTURE.md), [security](./docs/HANNAH_ROBOT_OS_SECURITY.md), [hardware compatibility](./docs/HANNAH_ROBOT_OS_HARDWARE_COMPATIBILITY.md), [build](./docs/HANNAH_ROBOT_OS_BUILD_GUIDE.md), [deployment](./docs/HANNAH_ROBOT_OS_DEPLOYMENT_GUIDE.md), [tests](./docs/HANNAH_ROBOT_OS_TEST_REPORT.md), [blockers](./docs/HANNAH_ROBOT_OS_BLOCKERS.md), [tracker](./docs/HANNAH_ROBOT_OS_IMPLEMENTATION_TRACKER.md) | All in [`docs/`](./docs/) |
| Devices and HANNAH OS: architecture, compatibility, security, deployment, tests, blockers, tracker | [`hannah-os/`](./hannah-os/HANNAH_OS_MASTER_ARCHITECTURE.md), [device JavaScript SDK](./hannah-os/sdk/devices/js/README.md) |
| API, MCP, the command-line tool and plugins | [`docs/API-INTEGRATION.md`](./docs/API-INTEGRATION.md) |
| Research and Document Studio: pipeline, guarantees, API, limits | [`docs/RESEARCH_AND_DOCUMENTS.md`](./docs/RESEARCH_AND_DOCUMENTS.md) |
| Desktop and phone features: screen, apps, computer control, browser, Phone Bridge | [`docs/DEVICE_INTELLIGENCE.md`](./docs/DEVICE_INTELLIGENCE.md) |
| Workflows | [`docs/WORKFLOWS.md`](./docs/WORKFLOWS.md) |
| Known issues and what's verified | [`docs/architecture/KNOWN_ISSUES.md`](./docs/architecture/KNOWN_ISSUES.md), [`docs/architecture/PLATFORM_COMPATIBILITY.md`](./docs/architecture/PLATFORM_COMPATIBILITY.md) |
| Safety governance and maturity | [`docs/SAFETY_GOVERNANCE.md`](./docs/SAFETY_GOVERNANCE.md), [`docs/SAFETY_MATURITY.md`](./docs/SAFETY_MATURITY.md), [`RESPONSIBLE_AI.md`](./docs/RESPONSIBLE_AI.md) |
| Regulatory notes | [`docs/REGULATORY_COMPLIANCE.md`](./docs/REGULATORY_COMPLIANCE.md), [`docs/COMPLIANCE_STATUS.md`](./docs/COMPLIANCE_STATUS.md) |
| Sync design (experimental) | [`docs/SYNC_PRIVACY.md`](./docs/SYNC_PRIVACY.md) |
| Capability matrix | [`docs/CAPABILITY_MATRIX.md`](./docs/CAPABILITY_MATRIX.md) |
| Observability | [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md) |
| Store data-safety form | [`docs/DATA_SAFETY_FORM.md`](./docs/DATA_SAFETY_FORM.md) |
| Legal | [`docs/PRIVACY_POLICY.md`](./docs/PRIVACY_POLICY.md), [`docs/TERMS_OF_SERVICE.md`](./docs/TERMS_OF_SERVICE.md) |

---

## License

HANNAH is released under the [HANNAH Source-Available Non-Commercial License 2.0](./LICENSE). Copyright © 2026 Harsh Tambade and HANNAH contributors.

You may use, modify and redistribute it **non-commercially**, with attribution. This is a source-available license, **not** an OSI-approved open-source license.

Monetizing a fork or derivative work (selling, hosting for profit, advertising and so on) requires a separate written commercial license. Unless that agreement says otherwise, it carries a **25% share of gross revenue**, attribution, and the reporting and audit terms in [`LICENSE`](./LICENSE). Get legal advice before relying on it commercially.

The app itself has no monetization. The license terms apply to forks, not to people using HANNAH.

## Acknowledgements

Built with React, Vite, TypeScript, Tailwind CSS, Three.js, React Three Fiber, React Flow, Capacitor, WebLLM, llama.cpp, Express, Ollama and Lucide. See the package manifests for every dependency and its license. Model files, including the avatar, carry their own licenses.
