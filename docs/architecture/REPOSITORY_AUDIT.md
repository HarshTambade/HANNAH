# HANNAH Repository Audit

Date: 2026-11-18
Scope: full repository (primary client, Express server, Python backend, native apps, workflows, docs, CI).

## Executive summary

HANNAH is a multi-surface AI companion. The primary, tested product path is `client/` (web/PWA, Capacitor Android/iOS, Electron via Capacitor) backed by `server/` (Express provider gateway, accounts, durable task runs, workflow engine). A secondary path exists in `apps/frontend`, `apps/desktop`, `apps/mobile` and `backend/` (Python), with separate routing and tool contracts. The repository is large, heavily documented, and currently has passing automated tests on the primary path, but several capabilities are experimental, duplicated, or only partially wired.

## Subsystem classification

| Subsystem | Status | Evidence |
|---|---|---|
| Web app (client) | Implemented, tested | `client/src`, vitest 290 tests pass |
| Express gateway/server | Implemented, tested | `server/*.test.js`, 204 tests pass |
| Workflow engine (server) | Implemented, tested | `server/workflows/*.js`, workflows tests pass |
| Client automations | Implemented, tested | `client/src/services/AutomationService.ts`, AutomationService tests pass |
| Model routing/gateway | Implemented, tested | `server/gateway.js`, `client/src/services/LLMRouter.ts`, gateway tests |
| Agent runtime (client) | Implemented, tested | `client/src/services/AgentRuntime.ts`, AgentRuntime tests |
| Desktop bridge/tools | Implemented, partially native | `client/plugins/desktop-tools`, desktop tools tests |
| Android app | Implemented, not device-verified | `client/android`, brand/native permission checks pass |
| iOS app | Implemented, not device-verified | `client/ios`, brand/native permission checks pass |
| Phone bridge | Implemented, experimental | `client/src/services/PhoneBridge.ts` |
| Memory (LanceDB) | Implemented, device-unverified | native plugin wiring |
| CI/CD | Implemented | `.github/workflows/build.yml`, audit scripts pass |
| Python backend | Secondary, limited | `backend/`, 15 tests pass |
| eBPF sensor | Observational only | `ebpf/` |

## Known problems investigated

1. Automation workflows fail during execution: historical cause was server rejecting empty tool lists; now fixed and covered by `server/gateway.test.js` "accepts a turn with no tools". Regression verified passing.
2. Automation execution may be incomplete or simulated: client `AutomationService` and server workflow engine both have checkpointing and status reporting; remaining risk is cross-device lease timing and device availability.
3. Navigation hash fragments: routes are path-based (`client/src/routes.ts`); legacy `#/` hashes redirect. Plain anchors remain on landing page by design.
4. Downloaded app icons: brand check passes (`scripts/check-brand-assets.mjs`).
5. Platform-specific native functionality: native plugins present but physical-device verification not established.
6. Dependency/security checks: audit gate passes with recorded exceptions; no unaccepted high findings.
7. Version consistency: all version fields 1.4.0 (`scripts/check-versions.mjs` passes).
8. Landing page: content and UX flagged for redesign (see docs).

## Architectural problems

- Duplicate application paths: `client/` vs `apps/*` + `backend/`.
- Dead/secondary code: `apps/frontend` not built in main CI.
- Missing API connections: Python fallback is single-step only.
- Unverified native plugins: LanceDB/MobileClaw/MobileCron.
- Incomplete platform verification: no physical device tests.
- Large bundle and many dependencies.

## Recommendations

- Standardize on primary path; document secondary path as experimental.
- Add physical-device smoke tests for native plugins.
- Continue workflow engine as durable execution backbone.
- Keep audit exceptions reviewed before expiry.
- Improve landing page content and accessibility.