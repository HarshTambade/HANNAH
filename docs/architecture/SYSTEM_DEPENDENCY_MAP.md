# HANNAH system dependency map

How the subsystems connect, which exist, and what each one depends on. Paths are the real modules; "missing" means no code exists yet.

```
                    ┌───────────────────────── Web app / PWA ─────── Mobile apps (Capacitor) ───── Desktop app (Electron) ─┐
                    │  client/src (React)             client/android, client/ios           client/electron, plugins/desktop-tools │
                    └──────────────┬────────────────────────────┬─────────────────────────────────────┬──────────────────────┘
                                   │ chat, tools                │ Phone Bridge                        │ desktop tools, device jobs
                                   ▼                            ▼                                     ▼
 Agent Engine ─────────► Model Router ─────────► Model Gateway (server) ─────► providers (Groq, OpenAI, Anthropic, Gemini, Ollama …)
 AgentRuntime.ts          LLMRouter.ts,            gateway.js, providers/runtime.js,
 AgentRouter.ts           ModelRouting.ts,         router.js (routing, privacy, fallback)
 SpecialistAgents.ts      server router.js
        │                                                   ▲
        │ tools                                             │ AI steps (services.ai: Auto tries each provider with a key)
        ▼                                                   │
 DeviceTools.ts ── Desktop Runtime ── Vision & Action       │
  BrowserTools.ts   (Electron main:   (screen, apps,        │
  PhoneTools.ts      core.mjs,         browser, PDF)        │
                     plugin.mjs)                            │
                                                            │
 Automation Engine ─────────────────────────────────────────┘
  server/workflows (engine, runtime: queue, leases, schedules, triggers, waits, rate-limit parking)
  client AutomationService.ts (device routines: run while open)
        │ device jobs                       │ checkpoints, runs
        ▼                                   ▼
 Desktop app claims jobs        Task Manager: server/task-runs.js, device-tasks.js, client TaskRecords.ts
 (DesktopWorkflowJobs.ts)                   │
                                            ▼
                     Account database (Postgres or SQLite): accounts, vault, workflows, runs, Phone Bridge, sync
                                            ▲
 Memory Manager: MemoryService.ts, MemoryStore.ts (on device), sync via accounts; capacitor-lancedb (native, unverified)
 Integration Manager: server/connections.js (Google, Microsoft OAuth), MCP client/server, webhooks, workflow credentials (vault)
```

## Components

| Component | Exists in | Depends on | Status |
| --- | --- | --- | --- |
| Model Gateway | `server/gateway.js`, `server/providers/runtime.js`, `catalog.js` | Provider keys (operator's or the account's, from the vault) | Tested |
| Model Router | `server/router.js`, `client/src/services/LLMRouter.ts`, `ModelRouting.ts` | Gateway, provider catalog | Tested |
| Agent Engine | `client/src/services/AgentRuntime.ts`, `AgentRouter.ts`, `SpecialistAgents.ts` | Router, tools (at most 20 a request) | Tested |
| Task Manager | `server/task-runs.js`, `server/device-tasks.js`, `client/src/services/TaskRecords.ts` | Account database | Tested; **off in production** (no database) |
| Automation Engine | `server/workflows/*`; device routines in `AutomationService.ts` | Account database, vault, Gateway; a scheduler tick on serverless | Tested; rate limits now waited out; **off in production** |
| Vision & Action Engine | `client/plugins/desktop-tools` (screen, apps, browser, PDF), `DesktopAgent.ts` | Desktop runtime, vision models through the Gateway | Partial: no accessibility-tree app control yet |
| Desktop Runtime | `client/electron-main.ts`, `plugins/desktop-tools/electron/dist/*` | Electron; OS permissions | macOS tested; Windows and Linux CI-built only |
| Phone Bridge | `server/phone-bridge.js`, `client/src/services/PhoneBridge.ts`, `PhoneTools.ts`, `HannahPhonePlugin.swift` | Account database (pairing, relay), native plugins | Unverified on devices; off in production (no database) |
| Memory Manager | `MemoryService.ts`, `MemoryStore.ts`, `MemoryModel.ts`; `capacitor-lancedb` | Local storage; account sync | Partial |
| Integration Manager | `server/connections.js`, `mcp-client.js`, `mcp-http.mjs`, `webhooks.js`, workflow credentials | Vault key, OAuth client ids, account database | Tested with stand-ins |
| Mobile apps | `client/android`, `client/ios` | Capacitor plugins | CI-built; unverified on devices |
| Web app | `client/` (Vite) on Vercel | Server API | Tested |

## Dependencies that matter for the roadmap

1. **Everything durable needs the account database.** That covers accounts, sync, server workflows, the Phone Bridge, task runs and webhooks. Production has none, so getting the database set up (KI-2) comes before any cross-device work can be used by anyone.
2. **Server workflows on Vercel need a tick.** Waits (including the new rate-limit waits), schedules and recovery advance only when `/api/workflows/tick` is called. A long-running server runs its own worker; Vercel needs a cron or an external scheduler with `CRON_SECRET`.
3. **AI steps need a key with room.** A free key shared by every guest makes every AI subsystem slow. Rate limits are now waited out rather than failing runs, but throughput is still bounded by the key (KI-6, KI-11).
4. **Releases depend on a green CI.** The release job waits for every build, so the Windows failure (KI-3) also blocked shipping the icon fix (KI-9).
5. **Cross-device orchestration:** Agent Engine → Task Manager → device. It depends on Phone Bridge pairing (database) and verified native plugins.
6. **The Vision & Action Engine's next step needs a user grant:** accessibility-based app control needs macOS Accessibility permission (or Windows UI Automation, or Linux AT-SPI).

## Duplicates

- **App paths:** `apps/frontend`, `apps/desktop`, `apps/mobile` and `backend/` (Python) duplicate the client, desktop shell and model routing with different contracts. They're not shipped. See KI-10.
- **Automation engines:** device routines and server workflows. Intentional (no-account use), described in `docs/WORKFLOWS.md`.
