# HANNAH Codebase Audit

**Audit date:** 2026-11-15
**Reviewed revision:** b81a527
**Scope:** 189 tracked paths inventoried; repository source and configuration reviewed. Binary artwork, GLB models, generated platform resources, and dependency internals are identified below but are not individually behaviorally audited. This is a source audit, not a fresh build, test, security scan, or physical-device verification. No implementation files were changed for this deliverable.

## Executive summary

### M1.5 security hotfix follow-up

After the b81a527 baseline below, M1.5 added Express bearer authentication for every /api route except /api/health, production startup validation, and configurable per-token fixed-window limits on chat, agent, and desktop-computer requests. The primary client collects the bearer from the user in page memory; it is not compiled into the Vite bundle or stored in browser storage. See server/api-security.js:15-40,49-90; server/index.js:114-120; client/src/services/api.ts:1-21; and MILESTONE_1.5.md. The limits are process-local, so multi-instance deployments need a shared or upstream limiter.

HANNAH is an existing multi-surface assistant with a primary React/Capacitor client, an Express provider API, a separate Python agent/backend, native memory and voice dependencies, a small eBPF metadata sensor, and two additional app shells. Several capabilities are real, but the repository does not yet behave as one unified autonomous system.

The primary released path appears to be client/ (web/PWA, Capacitor native apps, and the client-generated Electron package in CI). apps/frontend/ plus apps/desktop/ form a second Python-backed app path with separate routing, approvals, prompts, and desktop packaging. The two paths do not share one agent/tool contract.

Important corrections to assumptions in the brief:

- The Python model-step fallback does not call Express. The primary client calls Express first, then can call Python /api/agent/step directly for an eligible Groq failure (client/src/services/LLMRouter.ts:133-160; backend/main.py:507-548).
- HANNAH does not have general kernel-level control. ebpf/main.bpf.c:13-23 observes only openat metadata; it does not capture paths or execute actions. The loader is opt-in, Linux-only, and root-gated (ebpf/loader.py:75-105).
- The server exposes HANNAH as an MCP server, but the client does not consume external MCP servers. The exposed server tools are chat, status, and model listing; they do not control the host (server/mcp-core.mjs:33-38,40-129).
- A native LanceDB plugin is declared and included in Android/iOS project wiring, and the installed dependency contains native implementations. The app calls it, but this audit cannot establish that it works on physical devices or in supported release builds.
- There is no CLI/headless agent, shared policy file, shared tool schema, common permission broker, client/server trace chain, or kernel_trace tool in the tracked source.

No implementation work should start until you review this audit and answer the questions at the end, as required by the delivery plan.

## 1. File and responsibility map

This maps tracked paths by file and actual role. Generated resources are grouped where their behavior is data-only.

### Repository root and delivery

- .env.example — top-level sample environment settings; contains older/general provider variables.
- .gitignore — excludes local build and secret artifacts.
- LICENSE — project license text.
- README.md — user/developer guide, architecture diagrams, integrations, security/privacy notes, and build instructions; its claims are documentation, not proof of runtime behavior.
- package.json — root workspace/scripts. Root build builds only client; build:agent-frontend separately builds apps/frontend; dev:with-python-fallback starts Node, client, and Python; dev:ebpf starts the privileged opt-in loader.
- package-lock.json — root dependency lock.
- vercel.json — defines separate client and Express services and rewrites /api/* and /mcp.
- .github/workflows/build.yml — builds web/PWA on Ubuntu, client-generated Electron on macOS/Windows/Linux, Android on Ubuntu, and iOS archive on macOS; includes packaging/release jobs. It has no test, lint, or format job and does not build apps/frontend.
- docs/API-INTEGRATION.md — REST/MCP integration guide.
- docs/QA-AUDIT-2026-11-11.md — prior QA report. It records a successful primary build/release pipeline, a then-failing secondary frontend TypeScript build, no API authentication/rate limiting, and client production dependency advisories. Those results are dated and have not been re-run for this audit.

### Primary client: client/

- client/package.json, client/package-lock.json — primary Vite/React and Capacitor dependencies/scripts, including device APIs, llama.cpp, LanceDB, MobileClaw, MobileCron, TalkMode, Pinecall, and the Electron Capacitor plugin.
- client/.env.example, client/.npmrc, client/vite.config.ts, client/tsconfig.json, client/tsconfig.tsbuildinfo, client/postcss.config.js, client/tailwind.config.js, client/capacitor.config.ts, client/index.html, client/about/index.html, client/src/vite-env.d.ts — client environment, build/type configuration, native app config, web entry documents, and Vite types.
- client/scripts/compress-avatar.mjs — creates the compressed avatar asset.
- client/scripts/patch-capacitor-gradle.mjs, client/scripts/patch-capacitor-ios.mjs — patch generated native project configuration.
- client/scripts/seoPlugin.ts — Vite SEO/static-page plugin.
- client/src/main.tsx — React bootstrap.
- client/src/App.tsx — landing, companion, and integrations screen navigation; holds the visitor Groq key in React state and passes emotion to the avatar.
- client/src/types.ts — primary emotion and inference-mode types.
- client/src/index.css — primary app styling.
- client/src/components/ChatUI.tsx — primary chat, provider/model settings, voice and agent interaction UI; invokes the client agent runtime.
- client/src/components/AvatarScene.tsx — Three.js GLB scene, Draco loader, emotion-to-morph/light/pose behavior and fallback model.
- client/src/components/LandingPage.tsx — landing page and visitor-supplied Groq key flow.
- client/src/components/IntegrationsPage.tsx — documentation/UI for REST and outbound MCP connections.
- client/src/components/PlatformDownloads.tsx — download links for platform artifacts.
- client/src/services/AIService.ts — web/native offline model discovery, download, llama.cpp context, and local generation.
- client/src/services/AgentRuntime.ts — client multi-turn tool loop, prompt parsing, message trimming, sequential tool execution; capped at 8 rounds.
- client/src/services/LLMRouter.ts — network-aware mode choice and Node API request, with a conditional Python single-step fallback.
- client/src/services/DeviceTools.ts — primary client/device tool definitions and execution, including app-private files and device actions.
- client/src/services/SafetyGuard.ts — client confirmation dialogs and desktop token-bridge calls for a list of sensitive action names.
- client/src/services/DesktopAgent.ts, client/src/services/DesktopBridge.ts — optional Anthropic computer-use agent loop and the expected Electron bridge interface.
- client/src/services/MobileAgent.ts — native MobileClaw/LanceDB/MobileCron initialization, memory tools, and separate Anthropic agent session.
- client/src/services/SpeechService.ts, client/src/services/VoiceService.ts, client/src/services/callPermissions.ts, client/src/services/callClient.ts — optional Mithi TTS with OS/browser fallback, browser/native speech recognition, microphone permission, and Pinecall client.
- client/src/services/api.ts, client/src/services/connectivity.ts — API URL helper and network connectivity handling.
- client/electron-agent-config.example.ts, client/electron-agent-main.example.cjs, client/electron-agent-preload.example.cjs — example-only tokenized computer-use Electron bridge. These examples are not the default apps/desktop preload and are not generated as part of the checked-in client app source.
- client/public/icon.svg, client/public/social-card.svg, client/public/avatar-circuit-bg.svg — static brand assets.
- client/public/models/avatar.glb, client/public/models/avatar.draco.glb, client/public/models/uruha_rushia_-_hololive_vtuber.glb — avatar model assets.
- client/public/draco/README.md, client/public/draco/draco_decoder.js, client/public/draco/draco_decoder.wasm, client/public/draco/draco_encoder.js, client/public/draco/draco_wasm_wrapper.js, and the same four decoder/encoder files under client/public/draco/gltf/ — Draco runtime assets.
- client/android/ — checked-in Capacitor Android project: Gradle wrapper/config (build.gradle, settings.gradle, variables.gradle, gradle.properties, capacitor.settings.gradle, wrapper scripts/properties/JAR), app Gradle/proguard config, MainActivity.java, manifest, file-provider paths, and launcher/splash/layout/value XML/PNG resources. capacitor.settings.gradle includes the native LanceDB, MobileClaw, and MobileCron plugin projects at lines 41-48.
- client/ios/ — checked-in Capacitor iOS project: Xcode project/workspace metadata, AppDelegate/SceneDelegate, storyboards, Info.plist/privacy manifests, app icon/splash assets, debug xcconfig, and the Swift Package Manager wrapper. CapApp-SPM/Package.swift:26-27 includes LanceDB and MobileCron packages.
- client/config/PrivacyInfo.xcprivacy and client/ios/App/App/PrivacyInfo.xcprivacy — privacy manifest files.
- client/ios/App/CapApp-SPM/README.md, client/ios/App/CapApp-SPM/Sources/CapApp-SPM/CapApp-SPM.swift — generated SPM project notes and app target shim.

### Alternate frontend and desktop shell

- apps/frontend/package.json, apps/frontend/index.html, apps/frontend/vite.config.ts, apps/frontend/tsconfig.json, apps/frontend/postcss.config.js, apps/frontend/tailwind.config.js, apps/frontend/src/vite-env.d.ts — independent frontend workspace/build and Python API proxy configuration.
- apps/frontend/src/main.tsx, apps/frontend/src/App.tsx, apps/frontend/src/index.css — separate React app shell and styling.
- apps/frontend/src/components/ChatUI.tsx — separate chat/approval UX for the Python agent.
- apps/frontend/src/components/Avatar.tsx — separate R3F avatar implementation.
- apps/frontend/src/services/LLMRouter.ts — Python model catalog/agent/WebSocket approval client; its message, emotion, and response types differ from the primary client.
- apps/frontend/src/services/NativeLLM.ts — another local model integration and context.
- apps/frontend/src/services/VoiceService.ts — separate voice integration.
- apps/frontend/public/models/avatar.glb, apps/frontend/public/draco — alternate frontend model and Draco asset.
- apps/desktop/package.json — separate Electron packaging config; packages apps/frontend/dist and the Python backend, not the primary client UI.
- apps/desktop/main.js — restricted Electron shell; starts Python fallback, serves static frontend files, opens a BrowserWindow with context isolation/sandbox, and exposes a confirmation IPC.
- apps/desktop/preload.js — exposes only confirmAction; it does not implement screenshot or computer-action methods expected by DesktopBridge.
- apps/mobile/package.json, apps/mobile/capacitor.config.ts — additional standalone mobile package/config; primary release workflows instead build client/android and client/ios.

### Express provider/API service

- server/package.json, server/package-lock.json, server/.env.example — server runtime/dependencies/config samples.
- server/index.js — Express API routes for health/providers/models, chat, agent model steps, TTS, Pinecall token issuance, desktop computer proxy, and optional MCP mount during direct server startup. It binds to 127.0.0.1 by default. Since M1.5, all /api routes except health require a bearer token; chat, agent, and desktop-computer routes have per-token process-local rate limits.
- server/api-security.js — validates the production token, performs constant-time bearer comparison, and implements configurable fixed-window rate limiting.
- server/api-security.test.js — Node built-in integration tests for authentication, the health exemption, rate limits, and production startup validation.
- server/providers/catalog.js — canonical Node provider list, per-provider model defaults/overrides, default Groq ID, custom-base URL validation.
- server/providers/runtime.js — request adapters for OpenAI-compatible APIs, Anthropic Messages/tool blocks, and Ollama; model fallback loop; provider model discovery.
- server/mcp-core.mjs — HANNAH MCP tool definitions and bridge to the Express chat/model APIs. Exposes hannah_chat, hannah_status, hannah_models.
- server/mcp-http.mjs — optional bearer-authenticated Streamable HTTP MCP mount; uses equal-length check and timingSafeEqual.
- server/mcp-stdio.mjs — local stdio MCP server entry point; exposes the same MCP tools.
- server/mithi_tts_service.py, server/mithi-service-requirements.txt — separate optional FastAPI wrapper for Mithi speech synthesis.

### Python backend and tools

- backend/__init__.py — Python package marker.
- backend/run.py — Python service launcher.
- backend/main.py — FastAPI service, standalone approval-gated agent, model-only /api/agent/step fallback, audit-logged tool registry, TTS proxy, and loopback eBPF event buffer/API. It defaults to and enforces loopback binding.
- backend/llm_router.py — independent provider/model router (Groq, Anthropic, OpenAI-compatible hosted APIs, custom gateway, llama.cpp, and local OpenAI-compatible model). It has separate defaults and fallback ordering from the Node catalog.
- backend/audit_logger.py — redacting append-only JSONL hash-chain; validates existing records on startup and refuses to append if a record is malformed, partial, or hash-invalid.
- backend/requirements.txt — Python backend dependencies.
- backend/tools/__init__.py — tool package marker.
- backend/tools/security.py — per-execution tool authority/context and canonical-argument helpers.
- backend/tools/system_control.py — workspace-scoped file/status/allow-listed shell operations.
- backend/tools/code_executor.py — Docker-based restricted code execution.
- backend/tools/gui_control.py — approved screenshot and GUI actions.
- backend/tools/web_agent.py — Playwright public web navigation/form tools with network guards.
- ebpf/main.bpf.c — sys_enter_openat sensor collecting PID, UID, flags, and process name only.
- ebpf/loader.py — opt-in Linux BCC loader/forwarder; posts metadata to a loopback Python API and treats delivery as best effort.

## 2. Architecture tensions and recommended decisions

These are proposed M2-M3 decisions, not implemented changes.

### 2.1 Routing ownership — choose Option B

Keep the client authoritative only for local/offline execution (WebLLM or native llama.cpp). For connected cloud and Ollama inference, make the Node provider catalog/runtime authoritative. Publish one versioned capability manifest from a shared source and have the client use it for provider/model choices and offline capability display. Python should not independently make primary client routing decisions.

This preserves offline support without leaving cloud provider selection duplicated. Add the requested routing matrix test in M2. Current responsibilities are split: the client resolves network/inference mode (client/src/services/LLMRouter.ts:126-163, client/src/services/AIService.ts:59-62), Node resolves provider/model (server/providers/catalog.js:346-425), and Python owns another provider/model set (backend/llm_router.py:18-47,82-131).

### 2.2 Python model-step fallback — brief premise is inaccurate

backend/main.py does not callback into Express. The primary client conditionally falls back from Node to Python's model-only /api/agent/step (client/src/services/LLMRouter.ts:142-160). That endpoint never executes tools; returned tool calls are executed by the client (backend/main.py:507-548). Python also has a separate full agent endpoint with its own approval WebSocket (backend/main.py:381-458,551-559).

Recommendation: retire the primary client's Python model-step fallback unless you specifically require Python-only embedded llama.cpp or another Python-only provider as a recoverable secondary model path. If retained, document that exact reason, the independent credentials/configuration, maximum added wait (currently 45 seconds), and which provider/model preferences are honored. Keep or remove the standalone Python tool agent as a separate product decision; it is not the implementation of the client fallback.

### 2.3 Canonical tools — currently forked

Create one JSON Schema/OpenAI function-call contract for client DeviceTools, Python tools, and MCP tool adapters. Add adapter-specific execution and approval metadata outside provider-facing parameter schemas. Include MobileClaw and desktop computer actions in the same contract or explicitly mark them as separate platform capability extensions. At present, client schemas are inline in DeviceTools.ts, Python ToolSpec schemas are inline in backend/main.py:192-211, and MCP schemas are independently authored in server/mcp-core.mjs:40-129.

### 2.4 Permission policy — currently three separate behaviors

Create one safe/moderate/dangerous classification and one policy representation, then adapt its decisions to browser/native dialogs, the Python approval WebSocket, desktop token bridge, and future headless mode. Today the client gates selected sensitive tool names (client/src/services/SafetyGuard.ts:5-62), Python requires approval for every tool (backend/main.py:108-114,192-211), and MobileClaw has an allow-list plus separate memory deletion wrapper (client/src/services/MobileAgent.ts:12-21,40-53). There is no shared policy file or audit chain across these runtimes.

## 3. Requirement status

Statuses describe tracked source/configuration, not successful runtime verification.

### 4.1 Provider abstraction — PARTIAL

- Canonical internal message/tool-call shape exists in Node and client, with an Anthropic tool-block translator and OpenAI-compatible/Ollama handling (server/providers/runtime.js:100-174,197-276).
- Groq uses the OpenAI-compatible request path; many hosted providers and custom gateways are listed in server/providers/catalog.js:1-344. Gemini is configured as an OpenAI-compatible endpoint, not a native Gemini functionDeclarations adapter. No Gemini-native adapter was found.
- Anthropic uses tool_choice implicitly through its request shape, while OpenAI-compatible requests set tool_choice to auto (server/providers/runtime.js:219-276). No explicit provider-independent tool-choice control is present.
- Non-streaming exists; SSE streaming is missing (server/providers/runtime.js:197-276).
- Ollama sends tools and validates the response, but has no ReAct text-parse fallback; invalid/no tool call returns an error (server/providers/runtime.js:199-216).
- Model fallback exists, but retries immediately through configured model IDs; no Retry-After, exponential delay, or jitter is applied (server/providers/runtime.js:286-300).
- The client executes calls sequentially (client/src/services/AgentRuntime.ts:173-190). Python explicitly rejects batches with more than one call (backend/main.py:402-415). Parallel tool execution is missing.
- Context-size metadata exists in provider catalog, but no request token count, per-provider cost estimate, or per-session spend is surfaced by the router.

### 4.2 Agent core — PARTIAL

- The primary client loop supports up to eight tool rounds (client/src/services/AgentRuntime.ts:7,106-188); Python also has eight rounds (backend/main.py:52,381-458). There is no explicit Plan → Act → Observe → Reflect state machine.
- Client history is trimmed to 24 messages and local prompts to about 7,000 characters (client/src/services/AgentRuntime.ts:84-104); this is not budgeting against the active model window. Node catalog context metadata is not used as an enforced budget.
- There is no configurable aggregate wall-clock, token, or cost ceiling for a client agent session. Individual network/local paths have timeouts, but they do not form a session budget.
- Python writes a redacted hash-chained tool audit log (backend/audit_logger.py:1-7,50-123). There is no client/server per-session append-only JSONL inference trace using the same chain.
- No headless agent CLI/SIGINT cancellation protocol or child-agent/session spawning was found.

### 4.3 Permission broker — PARTIAL

- Client selected sensitive actions prompt before execution (client/src/services/SafetyGuard.ts:5-55; writes/deletes/actions call it from DeviceTools.ts).
- Python uses explicit approval for every backend tool and keeps the pending approval bound to a WebSocket session (backend/main.py:108-114,192-211,381-458,562-662).
- There is no shared safe/moderate/dangerous classification, policy file, path/command/network policy common to all runtimes, or moderate-action allow-and-log path.
- No --dry-run, UI dry-run, common kill switch, or termination of child processes is implemented in the primary agent runtime.
- The Python audit chain is not written by Express or the client; there is no unified chain reader for the app's complete tool history.

### 4.4 eBPF — PARTIAL

- The sensor is metadata-only and monitors sys_enter_openat; the fields are PID, UID, flags, process name, not path/content (ebpf/main.bpf.c:4-23).
- It requires explicit --enable-kernel-senses, Linux, BCC, and root (ebpf/loader.py:75-105). It does not explicitly test CAP_BPF; missing BCC/privilege returns an error without disabling the rest of HANNAH.
- Events are forwarded to a loopback-only Python endpoint and kept in a bounded in-memory deque (ebpf/loader.py:21,28-39,47-60; backend/main.py:701-736).
- There is no registered read-only kernel_trace model tool. The data is not retained across Python process restart. No dedicated privacy document was found that describes exactly what this sensor does and does not collect.

### 4.5 Memory — PARTIAL

- The primary app initializes LanceDB with auto-recall/auto-capture and adds memory tools to native runs (client/src/services/MobileAgent.ts:24-40,70-73). client/package.json:42, Android Gradle wiring (client/android/capacitor.settings.gradle:41-48), and iOS SPM wiring (client/ios/App/CapApp-SPM/Package.swift:26-27) show a native plugin dependency rather than a JS-only stub.
- The source requests a database named hannah-agent-memory; it does not establish a .hannah/ project workspace or project-specific namespace (client/src/services/MobileAgent.ts:28-33).
- No session-end summarization/write-back flow is present. The app-level integration does not demonstrate a configured embedding and hybrid/FTS recall workflow; the installed native package's API alone is not proof that HANNAH uses hybrid recall.
- No physical iOS or Android device test was run. Therefore native bridge existence is supported by dependency/project wiring, but “works on iOS + Android app-private storage” remains unverified.

### 4.6 Voice and avatar — PARTIAL

- Browser speech recognition and native TalkMode are implemented; native microphone permission fails closed when the plugin errors (client/src/services/VoiceService.ts:31-106,109-168; client/src/services/callPermissions.ts:4-17).
- Speech synthesis tries optional /api/tts and falls back to installed native/browser speech (client/src/services/SpeechService.ts:54-119). The server returns 503 when Mithi is unconfigured (server/index.js:340-366).
- Pinecall token issuance is server-side and returns 503 without PINECALL_TOKEN_URL (server/index.js:152-170). No actual call-token issuer is in this repository.
- Avatar GLB loading and emotion morph/light/pose maps are wired (client/src/components/AvatarScene.tsx:8-40,65-78,315-350; client/src/App.tsx:63-66). Emotion source is preserved in the primary client.
- No native voice/avatar end-to-end verification was performed. Optionality is configuration/code-path based, not governed by one shared feature-flag system.

### 4.7 MCP both directions — PARTIAL

- HANNAH exposes MCP over stdio (server/mcp-stdio.mjs:1-9) and optional HTTP. HTTP requires a 32+ character bearer token and compares equal-length values with timingSafeEqual (server/mcp-http.mjs:6-25).
- Exposed tools are only chat/status/models (server/mcp-core.mjs:33-129). The primary app's integration screen configures external hosts to connect to HANNAH; no MCP client/remote server tool adapter was found.
- Vercel rewrites /mcp to the Express service (vercel.json:17-23), but the route is mounted only inside startServer() (server/index.js:456-461), while serverless adapters receive the exported app without calling startServer() (server/index.js:478-487). As written, the Vercel /mcp route is likely absent even when rewrites are active. This needs deployment verification.
- Status: server-side transport/auth is implemented in source, but outbound MCP and Vercel HTTP MCP are incomplete/unverified.

### 4.8 Interfaces — PARTIAL

- Primary web/PWA, Capacitor Android/iOS, and client-generated Electron build paths exist (client/package.json:6-20; .github/workflows/build.yml:31-260).
- apps/frontend and apps/desktop are separate applications with a different Python agent contract. The separate desktop preload only offers confirmation, whereas DesktopAgent expects confirmation, screenshot, and perform methods (apps/desktop/preload.js:3-6; client/src/services/DesktopBridge.ts:3-16). The example preload implements the richer bridge but is not wired as the default shell.
- Local Python binds only to loopback and does not use bearer-token authentication (backend/main.py:62-78). Express defaults to loopback (server/index.js:29-32) and since M1.5 requires a bearer token on all /api routes except health. CORS remains a browser-origin control, not authentication. The remote MCP route also has its separate bearer token.
- No hannah CLI, --yes, policy-file headless mode, or JSON CLI output was found. External MCP client support is missing.

### 4.9 Quality — PARTIAL

- CI packages primary web/PWA, client-generated Electron for macOS/Windows/Linux, Android, and iOS archive (.github/workflows/build.yml:30-260). It does not build the alternate frontend or separate apps/desktop package.
- No tracked unit, provider integration, golden-loop, or cassette test suite was found. No CI lint/formatter enforcement exists.
- The root build script only builds the primary client (package.json:10-20). The README quickstart has multiple dependency-install/configuration steps (README.md:325-400); it is not a demonstrated under-60-second first turn from clone.
- The prior QA document records 75 client production dependency advisories (6 critical, 27 high, 42 moderate) and a secondary frontend TypeScript error, but both findings are dated 2026-11-11 and need a fresh check before acting on them (docs/QA-AUDIT-2026-11-11.md:24-25,40-50).

## 4. Duplicated or conflicting responsibilities

1. **Routing and provider catalogs:** primary client mode router, Node cloud provider catalog/runtime, Python provider router, and alternate frontend Python router make separate decisions. The catalogs differ in providers, model IDs/defaults, fallback order, and model metadata (client/src/services/LLMRouter.ts:126-160; server/providers/catalog.js:346-425; backend/llm_router.py:18-47,82-131; apps/frontend/src/services/LLMRouter.ts:86-132).
2. **Agent loops:** primary TypeScript 8-round tool loop, Python approval-gated 8-round loop, MobileClaw agent (10 turns), and desktop computer agent (10 turns/16 actions) have different histories, budgets, tool contracts, and approvals (client/src/services/AgentRuntime.ts:106-188; backend/main.py:381-458; client/src/services/MobileAgent.ts:86-134; client/src/services/DesktopAgent.ts:16-82).
3. **Tool definitions:** primary DeviceTools, Python ToolSpec, MCP Zod schemas, MobileClaw adapter, and Anthropic desktop computer actions are independently defined. There is no canonical schema source.
4. **Permission decisions:** client SafetyGuard, Python per-tool WebSocket approvals, MobileClaw allow-list/memory wrapper, desktop token bridge, and server endpoints do not share policy classification or rules.
5. **Prompts and output formats:** system prompts live in Node, primary client, Python full agent/fallback, alternate frontend, mobile agent, and desktop server route. They vary between “warm companion” and “bounded assistant,” and emotion/JSON protocols differ. For example, Python uses cute in its allowed emotions (backend/llm_router.py:18, backend/main.py:33-50), while the primary client uses angry and surprised (client/src/types.ts:1-10).
6. **Desktop packaging/control:** CI packages the primary client via Capacitor Electron; apps/desktop packages the alternate frontend/Python runtime. The desktop computer-use bridge in client expects methods absent from apps/desktop/preload.js; richer bridge files under client/ are explicitly examples.
7. **Voice and model integrations:** primary client uses Express for providers and TTS, while Python and alternate frontend have separate provider/TTS code; mobile agent directly uses Anthropic and a separate model default. This creates additional credentials, model selection, and failure behavior to maintain.

## 5. Ranked high-risk defects and gaps

1. **Shared API token and process-local quotas need deployment controls.** M1.5 protects /api routes (except health) with a 32–512 character bearer token and adds configurable per-token limits. The token is shared with trusted users and can be extracted by anyone who receives it; rotate it to revoke all clients. Rate-limit counters are in process memory and do not coordinate across Vercel/server replicas (server/api-security.js:3-40,49-90). Use HTTPS and a shared/upstream limiter for a multi-instance public deployment.
2. **Computer-use endpoint still depends on caller-side approval and deployment trust.** The endpoint uses server-side ANTHROPIC_API_KEY (server/index.js:368-392). M1.5 adds the same bearer gate and rate limit as other API routes, but authorized token holders can invoke it; the API token is not a per-user identity or desktop-action approval.
3. **App surface and contract mismatch can make advertised desktop capabilities unavailable.** apps/desktop/preload.js exposes only confirmation, while DesktopAgent needs screenshot and perform methods; the primary desktop release path is a different Capacitor-generated Electron app. This is a correctness gap and makes support status unclear.
4. **Vercel remote MCP may be routed to an app without an MCP handler.** /mcp is mounted only when startServer() executes, but serverless export returns the unmounted Express app (server/index.js:456-487). The deployment rewrite alone does not prove route initialization.
5. **Provider/runtime divergence can ignore user intent or fail inconsistently.** Node is primary but Python maintains a separate catalog and is only conditionally called for Groq failures; mobile selects Anthropic directly. Model defaults, fallback and adapter behavior are not shared.
6. **No session-level limits or unified trace leave cost and cancellation unbounded.** Eight tool rounds are bounded, but total wall time, spend, and tokens are not. There is no shared client/server trace or agent kill switch.
7. **Audit logger integrity failure can stop Python startup.** The logger verifies on import/initialization and refuses to append if the log is partial or invalid (backend/audit_logger.py:50-95,126). This is intentional fail-closed behavior, but startup recovery/repair procedure is not documented.
8. **Native capabilities lack current device verification.** LanceDB, voice, offline llama.cpp, permissions, and app lifecycle rely on native plugins; source wiring exists, but no physical iOS/Android validation was performed here. The historical QA explicitly says those checks were not performed (docs/QA-AUDIT-2026-11-11.md:60-65).
9. **Historical dependency/build findings need revalidation.** The prior QA reported critical/high client dependency advisories and a failing alternate frontend build. No current package audit or build was run for this audit.

## 6. Clarifying questions for the milestone plan

1. **Which app surface is supported?** Keep both the primary client + client-generated Electron path and the separate apps/frontend + apps/desktop Python path, or standardize on one release surface? Recommendation: make client the supported web/mobile/desktop UI and retain Python only as a separately documented backend/tool runtime unless you need the second UI.
2. **Should the client-to-Python /api/agent/step fallback remain?** Its specific extra capability is Python's independent provider set and embedded llama.cpp path when the Node request fails. Recommendation: retire it from the main client unless you rely on that Python-only model path; preserve the standalone Python approval-gated agent only if you explicitly need that separate workflow.
3. **What does “kernel-level” mean for HANNAH?** The supplied brief constrains kernel integration to opt-in, read-only, metadata-only eBPF openat observation and explicitly excludes a loadable kernel module. Confirm that this is the intended boundary for §4.4; host operations should otherwise use allow-listed tools and the permission broker.
4. **For external MCP servers, where should connections live?** A browser cannot launch stdio processes, so full coverage requires HTTP MCP in web clients and stdio/HTTP adapters in trusted desktop/native runtimes. Recommendation: define server connections and secrets in a local trusted runtime, with returned tools passed through the shared permission broker; should that be the model?

## 7. Proposed sequence after approval

M1.5 is implemented and recorded in MILESTONE_1.5.md. Proceed with the brief's milestone order after review checkpoint M2: document that Python fallback is client→Python (not Python→Express); settle supported app surfaces and routing authority; include MobileClaw/desktop capability adapters in M3; verify both outbound and inbound MCP and the Vercel mount in M7; expose only metadata retained by the bounded event buffer and document its privacy boundary in M8.
