# HANNAH architecture and roadmap

Status: living document · Last reviewed 2026-11-17

This document compares the HANNAH product briefs with what the repository does today, records the main architecture decisions, and sets out a phased plan. The first brief was "One Companion. Unlimited Intelligence." The current one is "Your Personal AI. Your Intelligence. Your World.", with Phases 0–13. The document covers code that runs in the shipped app. Experimental modules that no screen uses are listed separately, because counting them as features would overstate the product.

## 0. The current brief, phase by phase

Each phase is marked against its acceptance criteria (brief §20), not by whether a screen exists.

| Phase | Status | What exists | What's left |
| --- | --- | --- | --- |
| 0 · Audit and architecture | **Done** | This document; audits on 2026-11-16 (tests green, `npm audit --omit=dev` clean for server, client and root; no env files tracked). | Keep current. An old commit (976a2ef) once tracked `vercel-env.txt`, so rotate any keys it held. |
| 1 · Core platform | **Mostly** | Accounts on your own database (Postgres or SQLite), hashed sessions, envelope-encrypted key vault, per-user security log, export and deletion, settings sync, app shell. | Workspaces and roles; device management; OAuth or passkey sign-in. |
| 2 · Universal model gateway | **Mostly** | 20 providers on three wire protocols, live discovery, capability flags, SSE streaming, prompt-format tools when native tools are missing, normalized errors, retry and fallback, usage and spend. | Azure OpenAI, Bedrock (SigV4), Hugging Face and MLX adapters; embeddings; image and audio inputs. |
| 3 · Model router | **Done (this increment)** | [`server/router.js`](../server/router.js): request classification; Best quality, Balanced, Budget, Fastest, Private, Offline and Custom modes across every provider the caller may use; Private enforced on the server (routed, fallback and pinned requests); measured latency and provider health; cross-provider fallback within the policy; `POST /api/route/preview`; the chat route chip with reason, limitations and pinnable alternatives; a cost confirmation; dollar estimates only from verified, dated prices ([`shared/model-prices.json`](../shared/model-prices.json)). The same routing is available on `/v1` through `hannah.routing`. | Verify prices against provider pages and record dates; persist latency and health across restarts; route by modality (images, audio). |
| 4 · Agent orchestration | **Mostly** | Bounded tool loop, Guardian → HITL on every tool, Team plan → execute → verify with specialists. Durable task runs in the account database ([`server/task-runs.js`](../server/task-runs.js), [`TaskRecords.ts`](../client/src/services/TaskRecords.ts)): owner-scoped records with the brief's states, a checkpoint after every step, a one-device lease with heartbeats, versioned and idempotent writes, cancel from any device, and resume on another device from the last checkpoint. Approvals reach every signed-in device, and a step waiting for one marks the run `waiting-approval`. | A server-side queue for runs started while no device is online; Security and Data Analyst agents. |
| 5 · Desktop runtime | **Partial** | Capacitor Electron builds; Anthropic computer use through the desktop bridge, with approval for each action. | A runtime process separate from the UI, with approved workspace folders, a scoped filesystem, terminal allowlists, a Playwright browser agent, accessibility adapters and an emergency stop. See D10. |
| 6 · Coding and computer use | **Mostly (1.7.0)** | The coding service ([`server/coding`](../server/coding)): GitHub and local repositories, index and search, static checks and advisories, model review with checked evidence, planned edits as a reviewed diff, the project's tests in a separate worktree, publish to a branch and pull request through the Action Engine, CI results, durable tasks. See [`engineering/CODING_AGENT_CAPABILITIES.md`](./engineering/CODING_AGENT_CAPABILITIES.md). | Real-GitHub verification with the owner's token; GitLab and Bitbucket; type-aware analysis; dependency installs; container isolation. |
| 7 · User-owned memory | **Partial** | On-device memories with account sync (three-way merge). [`MemoryModel.ts`](../client/src/services/MemoryModel.ts): six categories, provenance, sensitivity, secret refusal, near-duplicate merging, and relevance-ranked retrieval (word match weighted by rarity, plus preferences), so a message carries only related memories. Sensitive memories go only to self-hosted models. A memory center with search, filters, editing, export, per-category switches and an off switch. Knowledge ([`Knowledge.ts`](../client/src/services/Knowledge.ts)): your own documents chunked and ranked with BM25 on the device, searched by the agent with citation tags. | Project scoping (needs a project concept in chat), semantic (embedding) retrieval with pgvector, a knowledge graph, contradiction detection beyond near-duplicates, and syncing memory settings across devices. |
| 8 · Voice and wake word | **Partial** | Voice layer (device or OpenAI TTS, device or Whisper STT, barge-in). | On-device "Hey HANNAH" in native code (Porcupine or openWakeWord). Not inside the WebView. Also streaming TTS. |
| 9 · Capacitor mobile | **Partial** | Android and iOS builds, on-device llama.cpp, background reminder notifications. | Secure storage plugin, offline queues, App Intents and Siri shortcuts, an Android foreground service for voice. |
| 10 · Proactive and workflows | **Mostly** | Reminders, webhooks, device routines (Automations → On this device), and a **server workflow engine** ([`docs/WORKFLOWS.md`](WORKFLOWS.md), `server/workflows/`): visual editor (React Flow), 42 node types including new-email and file-upload triggers, a Code step sandboxed in QuickJS/WebAssembly, and desktop steps (beta) that the signed-in desktop app runs after asking, durable queue with leases and recovery, retries, schedules in time zones, token and HMAC webhooks with replay protection, encrypted credentials, permission review before activation, runs center with per-step data, natural-language drafting. Tested on SQLite and Postgres and in a browser against a real server. n8n was evaluated and not embedded (Sustainable Use License). | Computer use as a workflow step; push-based mail triggers (it polls); npm packages in the Code step; OAuth for Slack, GitHub and Notion; workspace sharing. |
| 11 · Visual context | **Partial** | Vision flags per model; screenshots in the desktop agent. | Explicit screen and camera sharing with indicators; redaction. |
| 12 · Marketplace and developer platform | **Partial** | `/v1`, MCP server and client, A2A, signed webhooks, JS SDK, signed instruction skills. | Python SDK, skill sandbox (D7), registry. |
| 13 · Productionization | **Partial** | CI with unit, API (now in CI), browser and red-team tests; one version across web, desktop, Android and iOS, checked in CI; a release job that waits for every test and build, stages packages under stable names with checksums, writes notes with each package's signing status, and verifies the upload ([`docs/PLATFORM_SUPPORT.md`](./PLATFORM_SUPPORT.md)). Path-based routes, per-platform navigation, and a desktop menu and security policy. | Signing credentials (Apple, Android, Windows, GPG); runs of the packaged apps on each OS; load tests, agent evaluations, backup and restore runbook. |

**Order of the next increments** (each depends only on finished work): Phase 5 desktop runtime as a separate process → Phase 8 native wake word on Android → Phase 10 natural-language workflow builder → Phase 7 semantic retrieval (embeddings; needs Phase 2 embeddings).

### Commercial readiness requirements (additional brief, 2026-11-17)

| Area | Status | What exists | What's left |
| --- | --- | --- | --- |
| 1 · Updates and releases | **Mostly** | GitHub Releases from CI with checksums, GPG for Linux when a key exists, SBOMs and build provenance attestations on every package, release notes with each package's signing status; desktop auto-update with Stable and Beta channels (`electron-main.ts`), an on-demand check, update history and a "what's new" link in the update toast; PWA update prompt; Android live web updates. | A dev channel (needs nightly builds); signature checks in the desktop updater before install (needs the signing credentials first); rollback (electron-updater has no downgrade path; the previous installer stays on GitHub). |
| 2 · Health and diagnostics | **Mostly** | `Diagnostics.ts`: crashes, uncaught errors, a start that didn't finish, freezes, failed connections, agent, automation and sync failures, redacted; Settings → Diagnostics with search, levels, export; feedback attaches a report with consent. | Native plugin failures on Android and iOS; CPU and battery; a server-side view of health for operators (`/api/health` exists). |
| 3 · Backup, restore, migration | **Done** | `Backup.ts`: nine sections, credentials never included, SHA-256 checksum, optional AES-256-GCM with PBKDF2, format version check, merge or replace. 7 unit tests and a browser test that backs up, deletes, restores. | Scheduled backups to a folder (desktop); restoring to the account in one step. |
| 4 · Accessibility and i18n | **Mostly** | axe (WCAG 2.1 AA) on eight screens at two widths in CI, failing on serious and critical findings (`e2e/accessibility.spec.ts`); the findings it raised are fixed; a text-size setting; reduced motion; responsive layouts; locale-aware dates and numbers (`toLocale*` throughout); English, Hindi and Marathi voice. | A dark theme (the interface is built from light utility classes; it needs design tokens first, then a `dark:` pass over ~60 components); interface translations. |
| 5 · OS integration | **Mostly** | Native notifications (Android, iOS), desktop menu with shortcuts, system browser for links, native file access through the HannahDesktop plugin; tray or menu-bar item, the Ctrl/⌘+Shift+H global shortcut, `hannah://` links to a fixed set of screens (single instance; unknown links ignored), all verified by driving the real app. | Share sheet, drag-and-drop, file associations (no file type of HANNAH's own yet), Android and iOS deep links. |
| 6 · Security and supply chain | **Mostly** | In CI and nightly: a secret scan of every tracked file (`scripts/scan-secrets.mjs`, allowlist for test fixtures), a licence check of all production dependencies (`scripts/check-licenses.mjs`, copyleft refused), a native-permission audit against `docs/NATIVE_PERMISSIONS.json`, CycloneDX SBOMs for client and server (`npm sbom`, published with each release), inspection of staged packages before publishing (`scripts/inspect-release-assets.sh`: checksums, no signing material inside archives, release notes scanned), and build provenance attestations for every package. `npm audit` at high level; HTTPS-only providers; red-team suite. | Signed artifacts on macOS, Windows, Android and iOS (credentials); git-history scanning (gitleaks) rather than tracked files only. |
| 7 · Performance | **Partial** | Bundle budget in CI (3.38 of 5 MiB), long-task and heap warnings in Diagnostics. | Cold-start, memory and voice-latency budgets per platform, measured in CI. |
| 8 · Onboarding | **Partial** | Privacy, credentials and approval steps; apps open on a welcome screen. | OS-aware steps: capabilities, permissions, local models, voice, memory destination. |
| 9 · Feedback and support | **Done (this increment)** | In-app feedback with category, version and platform; optional diagnostic report with consent; server keeps an allow-listed shape only. | A support page with the FAQ and the diagnostics guide. |
| 10 · Release gates and compatibility | **Done** | CI release job waits for every test and build; version consistency, secret, licence, permission, accessibility and artifact gates; `docs/PLATFORM_SUPPORT.md` maps every capability to the five classes (implemented and verified, implemented but partially verified, unsupported by the platform, blocked by external requirements, not implemented). | Keep the matrix current with each release. |

### Branding (2026-11-18)

The desktop installers shipped Electron's icon (electron-builder had no icon configured) and the Android and iOS apps shipped Capacitor's default icons. All platform icons are now generated from `client/public/icon.svg` by `client/scripts/generate-brand-assets.mjs` (macOS ICNS on Apple's grid, Windows ICO, Linux PNGs, Android legacy, round, adaptive and monochrome, iOS 1024 opaque, favicon, maskable PWA icon). `scripts/check-brand-assets.mjs` runs in CI and refuses any file identical to a known framework default. Verified: the packaged macOS app's bundle icon is the generated ICNS and its launch check confirms the window icon; the Android icon resources compile and link with aapt2 (adaptive icon with background, foreground and monochrome). Not verifiable here: the Windows and Linux installers and the Android and iOS builds themselves, which CI builds.

### OpenJarvis parity (2026-11-17)

[OpenJarvis](https://github.com/open-jarvis/openjarvis) (Stanford, Python and Rust) was reviewed feature by feature against HANNAH. Already covered here: agents with tools and approvals, scheduled routines, memory, MCP, calendar and email, voice, skills, model routing with cost, cross-device tasks. Adopted in this increment, in HANNAH's own stack: the **morning digest** (Daily briefing: step, chat tool, settings, preview), **deep research over indexed local documents** (Knowledge with BM25 and citations) and **`jarvis doctor`** (Setup check). Not adopted, with reasons: messaging channels (Slack, Telegram, WhatsApp and 20 more) need bot credentials and a server process per channel; the evaluation harness, energy telemetry and the trace-based learning loop are research tooling that assumes local GPUs and Python; dense or ColBERT retrieval would add a model download for a small gain over BM25 at this document size; PDF reading needs a parser (pdf.js) and is the next Knowledge increment.

**Next readiness increments:** a dark theme behind design tokens (4); platform performance budgets measured in CI (7); OS-aware onboarding (8); share sheet and drag-and-drop on desktop (5); signed packages once the credentials exist (1, 6).

## 1. Where HANNAH is today (first brief)

| Brief area | Status | What exists | Main gaps |
| --- | --- | --- | --- |
| §2 Universal model compatibility | **Strong base** | 20 providers in [`server/providers/catalog.js`](../server/providers/catalog.js) on three wire protocols (OpenAI-compatible, Anthropic, Ollama) in [`runtime.js`](../server/providers/runtime.js): Groq, OpenAI, Anthropic, Gemini, OpenRouter, Together, Cerebras, DeepSeek, Mistral, xAI, Fireworks, NVIDIA NIM, SambaNova, Perplexity, Hyperbolic, Ollama, LM Studio, llama.cpp, vLLM and any custom OpenAI-compatible endpoint. Live model discovery, per-model tool, vision and context flags, model fallback chains, HTTPS enforcement, BYOK for Groq. | Streaming, capability negotiation and normalized errors are done (M2). Left: Azure, Bedrock, Hugging Face and MLX adapters; embeddings. |
| §3 Model recommendation | **First milestone done** | **Models** screen ([`ModelsPage.tsx`](../client/src/components/ModelsPage.tsx), [`ModelAdvisor.ts`](../client/src/services/ModelAdvisor.ts)). It detects and lets you edit hardware, and estimates local fit from weights + KV cache at your context + runtime overhead, after memory reserved for other apps (VRAM, split GPU/RAM, Apple unified memory or CPU). It covers all six budget modes from the brief, the eight "best for" choices, monthly cost estimates, the brief's comparison attributes, hybrid local + cloud pairing, and "Use in chat". Curated profiles live in [`shared/model-profiles.json`](../shared/model-profiles.json); the server catalog is `GET /api/catalog`. | Done since: per-message routing with seven modes, measured latency, budgets at request time (M3, M11). Monthly estimates now appear only for verified prices. Left: verified price dates; installed-model detection from Ollama. |
| §4 Autonomous agent engine | **Partial, core done** | Bounded tool loop, task profiles, Guardian then the user on every tool, circuit breaker, side-effect ledger, Stop, a persistent run log, and plan → execute → verify with resumable runs (Team mode). | Browser automation and terminal access (need sandboxing). |
| §5 Multi-agent system | **Done (first version)** | **Team** mode: server planning and verification ([`orchestrate.js`](../server/orchestrate.js)), client orchestrator ([`Orchestrator.ts`](../client/src/services/Orchestrator.ts)) running Research, Coding, Memory and Tasks specialists in parallel with their own tools and models, a revision round, persistent and resumable runs, and the **Agents** screen. | Specialists that browse the web or run code; agents that hand work to each other mid-step. |
| §6 Companion | **Partial** | Persona prompt, emotion-aware replies driving a 3D avatar, English, Hindi and Marathi, user-controlled memory with categories, provenance, sensitivity, relevance-ranked retrieval and per-category switches (M13). | Semantic retrieval, project scoping. |
| §7 Voice | **Partial, layer done** | Voice layer ([`VoiceEngines.ts`](../client/src/services/VoiceEngines.ts), [`voice.js`](../server/voice.js)): device or OpenAI TTS with voice choice, Mithi, device or Groq Whisper STT, barge-in with on-device voice detection, Pinecall calls. | ElevenLabs, Cartesia and Deepgram adapters, streaming TTS, an original licensed HANNAH voice, wake word. |
| §8 Personal assistant | **Partial** | Device tools, reminders by chat or Dashboard with in-app, browser and native background notifications, memory search and save, webhooks for events. | Calendar and email OAuth connectors, proactive briefings. |
| §9 Developer platform | **Done (first version)** | OpenAI-compatible `/v1` with SSE, an MCP server and an MCP client, A2A agent card and `message/send`, per-account developer keys, signed webhooks, and a JavaScript SDK ([`sdk/js`](../sdk/js)). | WebSocket transport, a Python SDK, OAuth for MCP. |
| §10 Skills marketplace | **Partial** | First-party agents and skills, plus community instruction skills from a manifest with validation, integrity hash and Ed25519 publisher signatures (trusted-publisher list). | A public registry, reviews, sandboxed executable skills. |
| §11 Memory and sync | **Partial** | On-device stores, plus bring-your-own-database accounts (Postgres or SQLite) with a three-way-merge sync of memories, reminders, skills, chat and preferences. | Vector search and relevance-ranked memory retrieval. |
| §12 Cross-platform | **Done for builds** | One React codebase builds to web/PWA, Android, iOS (unsigned), macOS, Windows and Linux (Capacitor Electron). | Signed iOS, a desktop local runtime with authorized filesystem and terminal, background jobs. |
| §14 Security and privacy | **Partial, strong defaults** | Guardian → HITL on every tool (including outside MCP tools), prompt-injection guardrails, secret redaction, HTTPS-only providers, local-only model modes, no telemetry unless configured, accounts with scrypt and hashed sessions, an envelope-encrypted key vault with rotation, a per-user security log with export, SSRF-guarded webhooks, and Private routing enforced on the server (D9). | Privacy rules for memory and documents (which memories may go to which provider), sandboxing, OAuth or passkey sign-in. |

### Experimental modules (not in the app)

`client/src` holds about 85 modules that no screen loads yet: CRDT sync, a hardware bridge, a kill switch, a policy layer, a credential broker, multi-agent prototypes and others. In 1.5.0 the ones that simulated their work were rebuilt to do it for real (`RestoredModules.test.ts`): encrypted sync and CRDT merge, real orchestration and research agents, a real server check, PAP with PKCE, and the HANNAH device protocol. None is counted as an app feature above until a screen uses it.

## 2. Architecture decisions

### D1 · Keep React + Capacitor; don't rewrite in Flutter

The brief suggests evaluating Flutter. The app already ships one React 19 + Vite codebase to all six targets, with tested safety, chat, avatar (Three.js), dashboard and native plugins. A Flutter rewrite would throw that away and re-implement WebGL, WebLLM and WebGPU support, which Flutter has no equivalent for, before adding any capability from the brief. **Decision:** keep React + Capacitor, and use native plugins where a platform needs them. Revisit only if a required capability is impossible in Capacitor.

### D2 · Modular monolith, not microservices

One Express API, plus the optional Python fallback, is enough for current traffic and keeps deployment to one Vercel project. Inside it, keep clear module boundaries that match the brief's services (model gateway, tool execution, memory, MCP), so one can be split out when load or isolation requires it. Executable marketplace code is the exception: it must run out of process (see D7).

### D3 · The model gateway lives on the server

Provider credentials, wire protocols and fallbacks stay server-side behind one request and response shape (`/api/agent`). The next steps are, in order:

1. Streaming (SSE).
2. Normalized errors and retry classes.
3. Capability negotiation: skip tools for models without native tool calling and fall back to prompt-format tools, as local models already do.
4. Embeddings.

Provider-specific options pass through an allow-listed `extensions` field instead of being dropped.

### D4 · Recommendations run on the device

Only the device knows its hardware, so the advisor runs in the client and takes the server catalog as input. Profiles are a dated, editable JSON file, and their tiers are labelled as curated, not benchmarks. Models a provider reports that aren't profiled show up as "unrated" instead of being hidden. Prices come from [`shared/model-prices.json`](../shared/model-prices.json). Monthly estimates are shown only for prices with a recent verification date. Others are labelled "not verified" (see D9).

### D5 · Credentials: tab-scoped today, vault after accounts

The brief says keys must never live in browser storage. Today a visitor's Groq key sits in `sessionStorage`: it's scoped to the tab, cleared on close, and sent only to Groq. That's the best available option without accounts. Meeting the brief requires user accounts (Phase 1) and a server-side encrypted vault (envelope encryption with a KMS-held key). The client would then hold only a session cookie. Until then, this trade-off is documented in the app and the README.

### D6 · No paid tiers or billing

An earlier product directive rules out premium tiers and dummy data. The brief's billing, paid skills and creator revenue-sharing contradict that, so they are **not planned**. Usage tracking shows users their own costs; it doesn't charge them. Reversing this needs an explicit product decision.

### D7 · Executable skills run sandboxed and out of process

Instruction-only skills are safe in process. Executable skills (code or MCP servers) will run in a separate sandbox with no network by default, resource limits, declared permissions and signed manifests. The Python service already runs code in a network-disabled Docker container, and the same isolation model will be used. Nothing executable ships before signing and sandboxing.

### D8 · Persistence: bring your own database (decided)

**Decision (product owner, 2026-11-16):** the operator connects any database they like through one `DATABASE_URL`. HANNAH runs a portable SQL subset on any Postgres (Supabase, Neon, RDS and others) and on SQLite for single self-hosted servers. Without a database, everything stays on the device, as before. Migrations run automatically. The tests run the same suite on SQLite and on real Postgres (PGlite). Accounts use email and password for now, because that needs no third-party service. OAuth or magic links can be added later. `pgvector` memory retrieval is still open.

### D9 · The router decides; the gateway transports; privacy is enforced in code

Model choice lives in [`server/router.js`](../server/router.js), separate from wire protocols in `gateway.js`. That keeps routing testable without network calls and lets `/api/agent`, `/api/route/preview` and `/v1` share one policy. Rules:

- **Privacy is a filter, not a preference.** Private and Offline remove hosted providers from candidates, alternatives and fallbacks, and block a pinned hosted model with `403 privacy_blocked`. "Self-hosted" means a local runtime, a loopback or private-network endpoint, or a provider the operator lists in `HANNAH_SELF_HOSTED_PROVIDERS`. A local runtime only counts when it's explicitly configured.
- **Prices are data with provenance.** [`shared/model-prices.json`](../shared/model-prices.json) records a source page per provider and an optional `verified` date per price. Budgets use every price, to stay conservative. People only see dollar estimates from prices verified in the last 120 days. On 2026-11-16 the official prices couldn't be confirmed (third-party sources disagreed), so no entry is marked verified.
- **Health and latency come from real outcomes only.** They're kept per process. Persisting them is future work.
- **Compatibility:** Auto without a `routing` field keeps the older single-provider behavior, so older clients and integrations don't change.

### D10 · Desktop runtime: keep Electron, add a separate runtime process (proposed)

The brief asks to evaluate Tauri first. The desktop app is already a Capacitor Electron build that shares the web codebase and has a working computer-use bridge. Moving to Tauri would mean rebuilding the shell, IPC and packaging before adding any capability. **Proposal:** keep Electron for the UI, and put the execution runtime (filesystem, terminal, browser automation, OS adapters) in a separate least-privilege process. That process exposes a narrow, typed IPC with workspace scoping, command allowlists, risk classes and an audit log. Rust can be used inside that process later without changing the UI. This needs confirmation before Phase 5 starts.

### Research and documents are platform services (1.6.0)

Decision: search-and-research and document-making are each implemented once, on the server (`server/research`, `server/documents`), behind one HTTP API (`server/studio.js`). They are not features of an agent.

- **Why:** before this, the single-agent loop, the research specialist and workflows each had their own web lookup, and nothing produced files. Separate copies drift: one cites, another doesn't; one checks a formula, another ships it broken. One service means one set of guarantees (checked citations, validated files, honest failure) for every caller.
- **How callers reach them:** chat and voice through `client/src/services/Studio.ts`; the agent loop, Team specialists and marketplace agents through four shared tools from `getStudioTools()` (`research`, `create_document`, `read_attached_files`, `convert_file`), which are in every agent's core tool set; workflows through the runtime's `research` and `document` services (steps `research.run`, `document.create`); MCP hosts through `hannah_research` and `hannah_create_document`.
- **A model plans; code is exact.** A model returns a description (a document model, a workbook plan, an answer with citations). Rendering, formula construction, validation and citation checks are code. A model never writes file bytes, cell references or the source list.
- **Rule for new agents:** an agent that needs the web or a file uses these tools. It does not add its own fetch, search or export code.

Details: [`RESEARCH_AND_DOCUMENTS.md`](./RESEARCH_AND_DOCUMENTS.md).

### One Action Engine under every agent (1.7.0)

Decision: anything HANNAH does outside this server for an account (a calendar event, an email, a message, a commit, a pull request) is an action asked of one engine, `server/actions`. No agent, workflow or tool sends, writes or publishes by its own code.

- **Why:** before this, each tool confirmed and executed in its own way, on the client. There was no place to set how much HANNAH may do, no shared history, and nothing that checked an action had really happened. Fourteen specialist agents with their own execution would have made fourteen copies of that problem.
- **What the engine guarantees:** the permission manager is asked every time, with the account's current policy; an action that must ask waits for a signed-in person; it runs at most once; it is read back from the destination service; "done" means confirmed; the whole record is kept.
- **Who may widen it:** only a person signed in to the app. A developer key, an MCP host and a workflow can ask for actions and can't approve one, raise a level, add a standing permission or lift the emergency stop.
- **The coding service is a caller, not an exception:** `server/coding` reads and analyses freely; running a project's script and publishing a change are the engine's `code.run` and `code.publish`.
- **Rule for new capabilities:** add an action definition (preview, execute, verify) to `server/actions/catalog`. Don't add a route that changes something outside the server on its own.

Details: [`architecture/AUTONOMOUS_OPERATOR_ARCHITECTURE.md`](./architecture/AUTONOMOUS_OPERATOR_ARCHITECTURE.md), [`security/PERMISSION_AND_TRUST_MODEL.md`](./security/PERMISSION_AND_TRUST_MODEL.md), [`engineering/CODING_AGENT_CAPABILITIES.md`](./engineering/CODING_AGENT_CAPABILITIES.md).

## 3. Roadmap

Each milestone ends with the tests from brief §18 passing, docs updated, and the README's status section changed. Nothing is presented as working before its end-to-end path runs.

| # | Milestone | Brief | Acceptance |
| --- | --- | --- | --- |
| **M1 ✅** | Model advisor and catalog | §3 | Hardware fit with KV cache, six budget modes, eight "best for" choices, cost estimates, hybrid pairing, "Use in chat". 14 unit tests and 2 API tests. |
| **M2 ✅** | Gateway: streaming and capability negotiation | §2 | [`server/gateway.js`](../server/gateway.js): SSE streaming (OpenAI-compatible providers; others deliver one delta), prompt-format tools when a model lacks native tool calling or rejects tools, normalized error codes, cross-provider fallback for `hannah-auto`. Tested against a fake provider. |
| **M3 ✅** | Automatic routing and budgets | §3 | **Auto** model in chat and `hannah-auto` in `/v1` classify each request and pick a tier; a daily cap (server and user) is enforced and downgrades near the limit; a pinned model is never swapped. |
| **M4 ✅** | Accounts, database, vault | §§1, 11, 14 | Bring-your-own database (Postgres or SQLite), automatic migrations, email and password sign-in, HttpOnly sessions, an envelope-encrypted provider-key vault with rotation, three-way sync, persistent budgets, a security log, export and deletion. |
| **M5 ✅** | Persistent tasks and planner | §4 | Persistent run log and Stop; plan → execute → verify in Team mode; runs saved after every change and resumable after a restart. |
| **M6 ✅** | Orchestrator and specialist agents | §5 | Research, Coding, Memory and Tasks specialists, each with its own tools and model, plus a tool-less verification agent; up to three parallel steps; a revision round; the Agents screen with live Team activity. |
| M7 · mostly done | Reminders, calendar, notifications | §8 | **Done:** reminders by chat or Dashboard; in-app, browser and native background notifications (Android and iOS); reminder webhooks. **Left:** OAuth calendar and email connectors. |
| **M8 ✅** | Developer platform v1 | §9 | `/v1` (SSE, tools, auto, usage), per-account developer keys, signed webhooks with an SSRF guard, an MCP client, an A2A agent card with `message/send`, and a JavaScript SDK. |
| **M9 ✅** | Voice layer | §7 | One interface over engines: device TTS (local) and OpenAI TTS (hosted) with voice selection, Mithi, device recognition (local) and Groq Whisper (hosted), and barge-in. |
| M10 · mostly done | Marketplace v2 | §10 | **Done:** manifest v1 for instruction skills with validation, integrity hash, Ed25519 publisher signatures and a trusted-publisher list, injection screening on client and server, and install, enable and uninstall. **Left:** a public registry and reviews, and sandboxed executable plugins. |
| **M11 ✅** | Routing modes and privacy-aware routing (Phase 3) | current §3, §15.3 | Seven modes across all usable providers; Private enforced on the server for routed, fallback and pinned requests; route preview with reason, limitations and alternatives; cost confirmation; estimates only from verified prices; fallback to the next allowed provider. 11 server tests (unit and API against fake providers), 5 client unit tests, and 1 browser test. |
| **M12 ✅** | Durable server tasks (Phase 4) | current §4.2 | Migration 5 adds `hannah_task_runs`, keyed by (user, id). `PUT/GET/DELETE /api/account/runs/:id`, `POST …/claim`, `…/heartbeat` and `…/cancel`. Only the device holding the 90-second lease writes; writes name the version they build on and carry a write id, so stale writes are refused and retries apply once. Team runs checkpoint every change, confirm the last checkpoint before starting more steps (so a cancel stops them), and resume from the account on another device without re-running finished steps. 8 server tests on SQLite and the same 8 on Postgres (PGlite), and 3 client tests that drive two simulated devices against the real server: resume on the phone, cancel from the phone, and offline checkpoints. |
| **M13 ✅** | Memory model and relevance retrieval (Phase 7) | current §7 | Categories, provenance and sensitivity on every memory (older ones are filled in when read); secrets refused at every entry point (panel, chat, `save_memory`, automations, background modules); near-duplicates merged; ranked retrieval sends only related memories plus up to 3 preferences; sensitive memories only for Ollama or Auto in Private routing; `search_memories` never returns sensitive ones; memory off and per-category switches. 13 unit tests (rules, ranking, service, and what the runtime actually sends) and 1 browser test from adding memories to the request body. Project scope was left out: chat has no project concept yet, so it would have been a label with no effect. |
| **M14 ✅** | Automations on durable task runs (Phase 10) | current §8.4, §9.2 | Two sync namespaces (`automations`, `automationSchedules`; plain tasks in the same list stay local). A scheduled slot's run id is `auto-<slot>-<workflow>`, created with the task-run API before any work, so one device runs it and the others skip it; offline, a scheduled slot waits and a manual run happens locally. A checkpoint per step; a device confirms its last checkpoint before the next step, so a cancel stops it there. `takeOver` claims a run from a device that went quiet; `decide` on a run held elsewhere forwards the answer through the approval mirror instead. 5 client tests drive two simulated devices against the real server (sync, one-of-two runs a slot, approve after the laptop goes quiet, continue a cut-off run, cancel, offline). |
| M15 · next | Desktop runtime as a separate process (Phase 5, D10) | current §5 | Move file, command and computer-use execution out of the Electron renderer into a least-privilege runtime process with a typed IPC, workspace scoping, command allowlists, risk classes, an audit log and an emergency stop. |

## 4. Decisions needed from the product owner

1. ~~Database and hosting (D8)~~: decided. Bring your own database.
2. **Monetization (D6):** confirm that billing, paid skills and revenue sharing stay out.
3. **More sign-in methods:** email and password ships now. Should OAuth (Google or GitHub) or magic links be added? Magic links need an email-sending service.
4. **Executable plugins:** whether to build the sandbox (D7) at all, given the security cost.
5. **Desktop runtime (D10):** confirm keeping Electron with a separate runtime process, instead of moving to Tauri.
6. **Price verification:** who checks provider pricing pages and records `verified` dates in `shared/model-prices.json`. Until someone does, the app shows no dollar estimates.

## 5. Conventions

- New tools go through `SafetyGuard.screen`, and through `SafetyGuard.confirm` when they change anything. The nightly check fails on bypass flags.
- Model facts (tiers, architectures, prices) live in data files with a review date, never hard-coded in UI.
- Every screen shows real data or an honest empty state.
