# HANNAH System Dependency Map

## Components

- Model Gateway (`server/gateway.js`, `server/providers/runtime.js`): provider calls, fallback, rate limits.
- Model Router (`client/src/services/LLMRouter.ts`, `server` cost-router): selects provider/model.
- Agent Engine (`client/src/services/AgentRuntime.ts`): multi-turn tool loop.
- Task Manager (`client/src/services/TaskSpineService.ts`, `server/task-runs.js`): durable task records.
- Automation Engine: client `AutomationService.ts` + server `workflows/engine.js`.
- Vision & Action Engine: desktop tools plugin + `DesktopAgent.ts`.
- Desktop Runtime: Electron/Capacitor desktop app + bridge.
- Phone Bridge: `PhoneBridge.ts` + native telephony.
- Memory Manager: `MemoryService`, LanceDB native.
- Integration Manager: MCP, accounts, cloud sync.
- Mobile Apps: Capacitor Android/iOS.
- Web App: `client/`.

## Data flow

1. User request -> Web/Mobile UI.
2. Agent Runtime -> LLM Router -> Model Gateway.
3. Tool calls -> DeviceTools/SafetyGuard -> (approval if needed).
4. Automations -> Task Manager -> durable runs -> devices.
5. Desktop/Phone bridges connect via account task runs and leases.
6. Memory Manager persists context.

## Existing vs missing

Existing: gateway, router, agent runtime, task runs, workflow engine, desktop tools, phone bridge, memory, mobile shells, web app.
Missing/partial: unified desktop vision agent default wiring, physical native verification, secondary path integration.