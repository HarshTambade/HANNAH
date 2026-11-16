# HANNAH architecture and roadmap

Status: living document · Last reviewed 2026-11-16

This document compares the HANNAH product brief ("One Companion. Unlimited Intelligence.") with what the repository does today, records the main architecture decisions, and sets out a phased plan. It covers code that runs in the shipped app. Experimental modules that no screen uses are listed separately, because counting them as features would overstate the product.

## 1. Where HANNAH is today

| Brief area | Status | What exists | Main gaps |
| --- | --- | --- | --- |
| §2 Universal model compatibility | **Partial, strong base** | 20 providers in [`server/providers/catalog.js`](../server/providers/catalog.js) on three wire protocols (OpenAI-compatible, Anthropic, Ollama) in [`runtime.js`](../server/providers/runtime.js): Groq, OpenAI, Anthropic, Gemini, OpenRouter, Together, Cerebras, DeepSeek, Mistral, xAI, Fireworks, NVIDIA NIM, SambaNova, Perplexity, Hyperbolic, Ollama, LM Studio, llama.cpp, vLLM and any custom OpenAI-compatible endpoint. Live model discovery, per-model tool, vision and context flags, model fallback chains, HTTPS enforcement, BYOK for Groq. | No streaming; no capability negotiation at call time (a non-tool model still gets tools); errors are not normalized across providers; Azure, Bedrock, Hugging Face and MLX have no adapters; no embeddings or audio endpoints. |
| §3 Model recommendation | **First milestone done** | **Models** screen ([`ModelsPage.tsx`](../client/src/components/ModelsPage.tsx), [`ModelAdvisor.ts`](../client/src/services/ModelAdvisor.ts)). It detects and lets you edit hardware, and estimates local fit from weights + KV cache at your context + runtime overhead, after memory reserved for other apps (VRAM, split GPU/RAM, Apple unified memory or CPU). It covers all six budget modes from the brief, the eight "best for" choices, monthly cost estimates, the brief's comparison attributes, hybrid local + cloud pairing, and "Use in chat". Curated profiles live in [`shared/model-profiles.json`](../shared/model-profiles.json); the server catalog is `GET /api/catalog`. | Automatic per-message routing by complexity; measured latency; live pricing; budget limits enforced at request time; installed-model detection from Ollama. |
| §4 Autonomous agent engine | **Partial** | Bounded tool loop ([`AgentRuntime.ts`](../client/src/services/AgentRuntime.ts)), task profiles ([`AgentRouter.ts`](../client/src/services/AgentRouter.ts)), every tool reviewed by GuardianAgent and then the user, a circuit breaker and a side-effect ledger. | Planning and decomposition, persistent task state across restarts, browser automation, terminal access, verification step, emergency stop wired into the UI. |
| §5 Multi-agent system | **Mostly missing** | Profiles route tasks to tool subsets. `CastOrchestrator`, `AgentOrchestrator` and others exist but no screen uses them. | Orchestrator, specialist agents with their own models and permissions, parallel execution, an Agent Activity view. |
| §6 Companion | **Partial** | Persona prompt, emotion-aware replies driving a 3D avatar, English, Hindi and Marathi, user-controlled memory (view, edit, delete, export). | Memory categories, relevance-ranked retrieval (all memories are sent today, capped at 12), and a per-category memory off switch. |
| §7 Voice | **Partial** | Push-to-talk recognition, system TTS, optional Mithi TTS, Pinecall calls. | Provider-agnostic voice layer (ElevenLabs, OpenAI, Cartesia, Deepgram), streaming barge-in, an original licensed HANNAH voice, wake word. |
| §8 Personal assistant | **Missing** | Device tools: app-private files, open app, battery, SMS and call drafts. | Calendar, reminders, email and OAuth connectors, notifications, proactive briefings. |
| §9 Developer platform | **Partial** | REST API, an MCP server with three tools, bearer and BYOK auth, per-key rate limits. | Versioned `/v1`, SSE/WebSocket streaming, an OpenAI-compatible endpoint, an MCP client, A2A, webhooks, SDKs, developer accounts and keys. |
| §10 Skills marketplace | **Partial** | First-party, instruction-only agents and skills; install and enable state on the device. | Manifest standard, publishing, signing, sandboxed executable skills, reviews. |
| §11 Memory and sync | **Partial** | On-device stores (chat, memory, usage, Guardian log). | Database, cross-device sync (the server sync endpoint is in-memory only), vector search. |
| §12 Cross-platform | **Done for builds** | One React codebase builds to web/PWA, Android, iOS (unsigned), macOS, Windows and Linux (Capacitor Electron). | Signed iOS, a desktop local runtime with authorized filesystem and terminal, background jobs. |
| §14 Security and privacy | **Partial, strong defaults** | Guardian → HITL on every tool, prompt-injection guardrails, secret redaction, HTTPS-only providers, local-only model modes, no telemetry unless configured. | Accounts and encrypted credential vault, audit log export, strict-privacy mode enforced server-side, sandboxing. |

### Experimental modules (not in the app)

`client/src/services` contains about 60 research modules with unit tests that no screen uses, for example `SyncService`, `KillSwitch`, `PolicyEnforcementLayer`, `HardwareBridgeService`, `CastOrchestrator` and `PAPAdapter`. Treat them as prototypes. Each one is either wired in with a real end-to-end path and tests, or deleted. None is counted as a feature above.

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

Only the device knows its hardware, so the advisor runs in the client and takes the server catalog as input. Profiles are a dated, editable JSON file, and their tiers are labelled as curated, not benchmarks. Models a provider reports that aren't profiled show up as "unrated" instead of being hidden. Prices come from the server's table with a "verify with provider" note, because prices change.

### D5 · Credentials: tab-scoped today, vault after accounts

The brief says keys must never live in browser storage. Today a visitor's Groq key sits in `sessionStorage`: it's scoped to the tab, cleared on close, and sent only to Groq. That's the best available option without accounts. Meeting the brief requires user accounts (Phase 1) and a server-side encrypted vault (envelope encryption with a KMS-held key). The client would then hold only a session cookie. Until then, this trade-off is documented in the app and the README.

### D6 · No paid tiers or billing

An earlier product directive rules out premium tiers and dummy data. The brief's billing, paid skills and creator revenue-sharing contradict that, so they are **not planned**. Usage tracking shows users their own costs; it doesn't charge them. Reversing this needs an explicit product decision.

### D7 · Executable skills run sandboxed and out of process

Instruction-only skills are safe in process. Executable skills (code or MCP servers) will run in a separate sandbox with no network by default, resource limits, declared permissions and signed manifests. The Python service already runs code in a network-disabled Docker container, and the same isolation model will be used. Nothing executable ships before signing and sandboxing.

### D8 · Persistence needs a managed Postgres

Accounts, persistent tasks, sync and developer keys need durable storage. Vercel functions are stateless, and today's in-memory sync proves it: data is lost on restart. The recommendation is managed Postgres (for example Neon or Supabase) with `pgvector` for memory retrieval. **This needs your decision**, because it adds a paid service and stores user data.

## 3. Roadmap

Each milestone ends with the tests from brief §18 passing, docs updated, and the README's status section changed. Nothing is presented as working before its end-to-end path runs.

| # | Milestone | Brief | Acceptance |
| --- | --- | --- | --- |
| **M1 ✅** | Model advisor and catalog | §3 | Hardware fit with KV cache, six budget modes, eight "best for" choices, cost estimates, hybrid pairing, "Use in chat". 14 unit tests and 2 API tests. |
| **M2 ✅** | Gateway: streaming and capability negotiation | §2 | [`server/gateway.js`](../server/gateway.js): SSE streaming (OpenAI-compatible providers; others deliver one delta), prompt-format tools when a model lacks native tool calling or rejects tools, normalized error codes, cross-provider fallback for `hannah-auto`. Tested against a fake provider. |
| **M3 ✅** | Automatic routing and budgets | §3 | **Auto** model in chat and `hannah-auto` in `/v1` classify each request and pick a tier; a daily cap (server and user) is enforced and downgrades near the limit; a pinned model is never swapped. |
| M4 | Accounts, database, vault | §§1, 11, 14 | Sign-in, Postgres schema and migrations, encrypted provider keys stored server-side, sessions instead of tab storage. *Needs D8.* |
| M5 · partial | Persistent tasks and planner | §4 | **Done:** persistent execution log of every run and tool step, with interrupted runs marked; Stop button. **Left:** a plan → execute → verify loop, and resuming a run after a restart. |
| M6 | Orchestrator and specialist agents | §5 | Research, Coding, Memory and Verification agents with their own models and permissions; parallel steps; Agent Activity view. |
| M7 · partial | Reminders, calendar, notifications | §8 | **Done:** reminders by chat (tools) or Dashboard, browser notifications and in-app alerts. **Left:** native background notifications and an OAuth calendar connector (needs M4). |
| M8 · partial | Developer platform v1 | §9 | **Done:** [`server/v1.js`](../server/v1.js) with `/v1/models`, `/v1/chat/completions` (SSE, tools, auto) and `/v1/usage`. **Left:** per-developer API keys and webhooks (need M4), MCP client, A2A, SDKs. |
| M9 | Voice layer | §7 | Provider-agnostic TTS/STT with one hosted and one local engine, barge-in, voice selection. |
| M10 · partial | Marketplace v2 | §10 | **Done:** manifest v1 for instruction skills, with validation, integrity hash, injection screening on client and server, a permission and privacy display, install, enable and uninstall. **Left:** publisher signing, a public registry and reviews, and sandboxed executable plugins. |

## 4. Decisions needed from the product owner

1. **Database and hosting (D8):** which managed Postgres to use, and whether user data may be stored server-side at all. This blocks M4–M8.
2. **Monetization (D6):** confirm that billing, paid skills and revenue sharing stay out.
3. **Accounts:** email magic links, OAuth (Google or GitHub), or both.

## 5. Conventions

- New tools go through `SafetyGuard.screen`, and through `SafetyGuard.confirm` when they change anything. The nightly check fails on bypass flags.
- Model facts (tiers, architectures, prices) live in data files with a review date, never hard-coded in UI.
- Every screen shows real data or an honest empty state.
