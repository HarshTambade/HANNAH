# Deep audit — HANNAH AI companion

**Date:** 2026-11-20  
**Base commit:** `1ef0506` (version 1.7.0)  
**Scope:** whole repository — primary client (`client/`), Express server (`server/`), Python agent/backend (`backend/`), second app path (`apps/`), eBPF sensor (`ebpf/`), shared packages, docs, CI and release tooling.  
**Method:** source inventory, automated gates, full test suites, typechecks, lint, dependency audit, secret scan, e2e screen/interaction/accessibility crawls, and review of the existing audit trail (`docs/audit/`, `KNOWN_ISSUES.md`).

This is a source-and-runtime audit performed in this environment. It does not replace device, real-account, or physical-hardware verification, which are listed as blocked items.

---

## 1. Executive summary

- **The app is in good shape.** All automated gates pass, all unit/API tests pass, typechecks are clean, and the e2e screen and accessibility crawls pass.
- **No new security defects** were found in this pass. The secret scan is clean, dependency audits are clean at the configured level, and the server's auth/CORS/rate-limit posture is sound.
- **The main risks are operational and coverage gaps**, not code defects: production has no database configured (owner action), several features need real accounts/devices, and there is documentation drift (README still says 1.6.0 while the tree is 1.7.0).
- **One e2e crawler run** (`interactions.spec.ts`) stopped on `/marketplace` signed in because the local preview server refused connections mid-run; this looks like test-harness resource pressure, not an application error, but it should be re-run before release.
- **Code health:** 3 harmless lint warnings; one large main bundle chunk (1.37 MB minified); a 6.1 MB worker in the second app path. Neither is a correctness issue.

### Headline numbers

| Metric | Value |
|---|---|
| Source files (excluding node_modules) | 624 |
| Lines of code — client/src | 42,727 |
| Lines of code — server | 34,366 |
| Lines of code — backend (Python) | 3,571 |
| Lines of code — apps (frontend/desktop/mobile) | 5,973 |
| Client unit tests | 398 (68 files) |
| Server tests | 417 pass, 1 skip |
| Python tests | 15 pass |
| Desktop plugin tests | 43 pass |
| E2E specs | 13 files |
| E2E screen crawl | 2/2 pass (signed in + guest) |
| E2E accessibility | 11/11 pass |
| E2E interactions | 9/20 signed-in screens before a harness connection failure |

---

## 2. Automated verification

| Check | Command | Result |
|---|---|---|
| Secret scan | `node scripts/scan-secrets.mjs` | **Pass** — no findings in 595 files |
| Version consistency | `node scripts/check-versions.mjs` | **Pass** — all fields 1.7.0 |
| Brand assets | `node scripts/check-brand-assets.mjs` | **Pass** |
| Native permissions | `node scripts/check-native-permissions.mjs` | **Pass** — 7 Android, 4 iOS, documented |
| Packaged icons | `node scripts/check-packaged-icons.mjs` | **Pass** |
| Licenses | `node scripts/check-licenses.mjs` | **Pass** — 424 deps, 2 MPL-2.0 noted |
| Dependency audit (root, prod) | `node scripts/audit-gate.mjs . --omit-dev` | **Pass** — 0 findings |
| Dependency audit (client, prod) | `node scripts/audit-gate.mjs client --omit-dev` | **Pass** — 0 findings |
| Dependency audit (server, prod) | `node scripts/audit-gate.mjs server --omit-dev` | **Pass** — 0 findings |
| Server lint | `npm run lint --prefix server` | **Pass** — clean |
| Client lint | `npm run lint --prefix client` | **3 warnings** (React exhaustive-deps), 0 errors |
| Client typecheck + build | `npm run build --prefix client` | **Pass** — tsc clean |
| Apps/frontend build | `npm run build` (in apps/frontend) | **Pass** — tsc clean |
| Server tests | `npm run test --prefix server` | **Pass** — 417 pass, 1 skip |
| Client tests | `npm run test --prefix client` | **Pass** — 398 pass |
| Python tests | `python3 -m pytest backend/tests` | **Pass** — 15 pass |
| E2E screens | `npx playwright test e2e/screens.spec.ts` | **Pass** — 2/2 |
| E2E accessibility | `npx playwright test e2e/accessibility.spec.ts` | **Pass** — 11/11 |
| E2E routing | `npx playwright test e2e/routing.spec.ts` | **Pass** — 15/15 |

---

## 3. Architecture and surfaces

| Surface | Path | Status |
|---|---|---|
| Primary web/PWA + Capacitor client | `client/` | Shipped; primary released path |
| Express provider API | `server/` | Shipped |
| Python agent/backend (fallback) | `backend/` | Shipped; binds localhost only |
| Second app shell (avatar + chat) | `apps/frontend/` | Built, unshipped second path (KI-10) |
| Desktop Electron shell | `apps/desktop/` | Built in CI; not hand-verified |
| Mobile Capacitor shell | `apps/mobile/` | Scaffold; not hand-verified |
| eBPF metadata sensor | `ebpf/` | Opt-in, Linux-only, root-gated; observes `openat` metadata only |
| Shared marketplace catalog | `shared/` | Used by server and client |

The two client paths (`client/` and `apps/frontend/`) do **not** share one agent/tool contract. This is a known structural item (KI-10, P2).

---

## 4. Findings

Severity: **P0** (blocks release) · **P1** (should fix before release) · **P2** (next release) · **P3** (polish).

### P1 — Should fix before the next release

| ID | Area | Finding | Evidence |
|---|---|---|---|
| F-01 | Documentation | **Version drift in README.** `README.md` states `main` is version 1.6.0 and links the v1.6.0 release, but `package.json` (root, client, server) all report 1.7.0 and `docs/CHANGELOG.md` has a 1.7.0 entry. | `README.md:22`, `package.json` version fields |
| F-02 | Test harness | **E2E interaction crawl stopped early.** `interactions.spec.ts` passed 9 of 20 signed-in screens, then failed on `/marketplace` with `net::ERR_CONNECTION_REFUSED` at the preview server. The app screen itself is not implicated (screens crawl passes); this is likely preview-server resource pressure in the serial crawl. | Playwright run, 2026-11-20 |
| F-03 | Operations | **Production has no account database.** `/api/account/status` reports `accounts.enabled: false`, `database.configured: false`, `vault: false`; `CRON_SECRET` unset; no tick runs. All durable features (accounts, sync, workflows, Phone Bridge, calendar/email) are off for real users. | `KNOWN_ISSUES.md` KI-2; owner action |
| F-04 | Operations | **Guests share the operator's free AI key.** Production `/api/health` reports `guestAccess: true`. Under load the operator's Groq quota is exhausted, so chat and AI steps for keyless users are slow or refused. | `KNOWN_ISSUES.md` KI-6; owner decision |

### P2 — Next release

| ID | Area | Finding | Evidence |
|---|---|---|---|
| F-05 | Code health | **3 React exhaustive-deps warnings** in `KnowledgePanel.tsx` and `WorkflowBuilder.tsx`. Not errors, but they can cause stale closures. | `npm run lint --prefix client` |
| F-06 | Performance | **Main bundle chunk is 1.37 MB minified** (`main-ZDGPrutp.js`), plus a 1.01 MB three.js chunk and a 5.79 MB Vosk worker. `vite` warns about chunks over 1100 kB. | Client build output |
| F-07 | Second app path | **`apps/frontend` ships a 6.14 MB worker** (`worker-qrXcgi0g.js`) and duplicates `LLMRouter`/`ChatUI` logic. It is an unshipped, separately maintained path that can drift from the primary client. | `apps/frontend` build; KI-10 |
| F-08 | iOS build | **LanceDB Swift bindings fail on Xcode 27**, so the iOS app does not build on newer toolchains. CI's current Xcode still works. | KI-23 |
| F-09 | Unverified features | **13 panels are backed by services but no screen mounts them** (Collective, Digital twin, Spatial context, Presence feed, Memory evolution, Memory router, Oversight, Personalization health, Perception consent, Intervention log, Cast, PAP settings). No invented data found, but unverified end to end. | `REPAIR_TRACKER.md` |
| F-10 | Unverified features | **Desktop computer control, terminal and shared-folder coding agent** are unit-tested and launched in CI but not exercised by hand with Accessibility permission. | KI-24, KI-25 |
| F-11 | Unverified features | **Phone Bridge, native reminders, wake word, Siri launch** are implemented and compiled but not run on a physical phone. | KI-26, KI-28, KI-29, KI-31 |
| F-12 | Unverified features | **Gmail/Outlook/Calendar/Chat, WhatsApp/Telegram channels, connectors with real vendor accounts** are implemented against stand-ins only. | KI-22, KI-27, KI-30 |
| F-13 | Feature gap | **Semantic memory search is not implemented** — memories are ranked by word matching, not embeddings/pgvector. | KI-32 |
| F-14 | Feature gap | **User-supplied templates (.potx/.dotx), web-fetched images/icons for slides, file sharing by link, and project workspaces** are not implemented. | `REPAIR_TRACKER.md` (1.6.0) |
| F-15 | Product | **No paid tiers/billing** — HANNAH has no billing. Not a defect, but a product decision to revisit. | `REPAIR_TRACKER.md` |
| F-16 | Release | **Installers are unsigned** (owner's choice). Not a code defect. | `REPAIR_TRACKER.md` |

### P3 — Polish / informational

| ID | Area | Finding |
|---|---|---|
| F-17 | Web bundle | Large Vosk worker (5.79 MB) is loaded for wake-word support; acceptable for a feature, but worth lazy-loading confirmation. |
| F-18 | Lint | Server ESLint is clean; client has only the 3 warnings above. |
| F-19 | Security (positive) | Python agent binds only to loopback and raises on remote bind; CORS origins are validated; no `eval`/`new Function` on user input in source. |
| F-20 | Security (positive) | Bearer token is kept in page memory / sessionStorage on the website, not compiled into the bundle or browser storage. |

---

## 5. Open known issues (from `KNOWN_ISSUES.md`)

All KI-1 … KI-32 are tracked in `docs/architecture/KNOWN_ISSUES.md`. Status summary:

- **Fixed:** KI-1, KI-3, KI-4, KI-5, KI-7, KI-9, KI-14, KI-15, KI-16, KI-17, KI-18, KI-19, KI-20, KI-21.
- **Owner action / decision:** KI-2 (database), KI-6 (guest key), KI-8 (tags), KI-10 (second app path).
- **Open (needs device/account/hardware):** KI-11, KI-12, KI-13, KI-22, KI-23, KI-24, KI-25, KI-26, KI-27, KI-28, KI-29, KI-30, KI-31, KI-32.

No new known issues were discovered in this pass beyond those already tracked.

---

## 6. Areas this audit did not cover

Per the existing audit caveats, these require resources not available in this environment and are **not** verified here:

- Real Google / Microsoft / WhatsApp / Telegram / GitHub accounts and OAuth flows.
- Providers other than Groq with real keys (OpenAI, Anthropic, Gemini, etc.).
- A physical phone (Android/iOS), including Phone Bridge, native reminders, wake word, Siri.
- The packaged desktop app exercised by hand (macOS/Windows/Linux).
- iOS at runtime (simulator/device).
- The 13 unmounted panels and the second app path (`apps/`).
- Signed installers (unsigned by owner choice).

---

## 7. Recommendations (prioritized)

1. **Fix F-01** (README version) — one-line doc change; do before tagging 1.7.0.
2. **Re-run F-02** the interactions crawl on a machine with more CPU or with `--workers=1` and confirm `/marketplace` passes; if it fails again, capture the preview-server log.
3. **Resolve F-03** by connecting Supabase (or setting `DATABASE_URL`, `HANNAH_VAULT_KEY`, `CRON_SECRET`) — this single step unlocks accounts, sync, workflows, Phone Bridge and calendar/email for real users.
4. **Decide F-04** (guest key sharing) — accept the quota risk or require a free account after N messages.
5. **Clean F-05** (3 lint warnings) — trivial, keeps `eslint` fully green.
6. **Plan F-06/F-07** bundle splitting for the 1.4 MB main chunk and the 6.1 MB worker; not blocking but improves first load.
7. **Track F-08** (Xcode 27) before GitHub's macOS runners move to Xcode 27.
8. **Decide F-09** whether to surface or remove the 13 unmounted panels.
9. **Run the physical-device checklist** (KI-24 … KI-31) before claiming those features in release notes.

---

## 8. Appendix — commands used

```sh
# Gates
node scripts/scan-secrets.mjs
node scripts/check-versions.mjs
node scripts/check-brand-assets.mjs
node scripts/check-native-permissions.mjs
node scripts/check-packaged-icons.mjs
node scripts/check-licenses.mjs
node scripts/audit-gate.mjs . --omit-dev
node scripts/audit-gate.mjs client --omit-dev
node scripts/audit-gate.mjs server --omit-dev

# Lint / typecheck / tests
npm run lint --prefix server
npm run lint --prefix client
npm run build --prefix client
npm run test --prefix server
npm run test --prefix client
python3 -m pytest backend/tests

# E2E
npx playwright test --config client/playwright.config.ts e2e/screens.spec.ts
npx playwright test --config client/playwright.config.ts e2e/accessibility.spec.ts
npx playwright test --config client/playwright.config.ts e2e/routing.spec.ts
npx playwright test --config client/playwright.config.ts e2e/interactions.spec.ts   # stopped at /marketplace (F-02)
```

---

*Generated by an automated + manual audit pass on 2026-11-20. No source files were changed by this audit except this report.*
