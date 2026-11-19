# Test results

Run on 2026-11-19 on macOS (Apple silicon), Node 25, against the 1.5.1 working tree. Only tests that were actually executed are listed.

## Automated suites

| Suite | Command | Result |
|---|---|---|
| Server unit and API tests | `cd server && node --test` | 328 tests: **327 pass**, 0 fail, 1 skipped |
| Client unit tests | `cd client && npx vitest run` | **364 pass** in 65 files |
| Browser end-to-end (Chromium) | `cd client && npx playwright test` | **82 pass**. Of three full runs after the last change, two passed; one failed once with a connection reset from the test's own server and was not reproduced |
| Client typecheck | `npx tsc --noEmit -p .` | Clean |
| Client lint | `npm run lint` | 0 errors, 3 warnings |
| Server lint | `npm run lint` | 0 errors |
| Secret scan | `node scripts/scan-secrets.mjs` | No findings in 542 files |
| Dependency audit | `npm audit --omit=dev` in root, client, server | 0 vulnerabilities |
| Audit gate, native permissions, brand assets, version fields | `scripts/*.mjs` | Pass |
| Desktop plugin tests | `desktop` suite | 43 pass (last run for 1.5.0; desktop code unchanged since) |
| CI on `3bf275c` | GitHub Actions "Build HANNAH" | All jobs green: gates, web, e2e, red-team, Electron ×3, Android, iOS |

## New tests in this round

| File | Covers |
|---|---|
| `server/models-live.test.js` (10) | Chat-model filter; served-model registry; `/api/models`, `/api/catalog`, `/v1/models`; Auto on `/api/agent`, `/api/chat`, `/v1`, A2A and route preview never asks for a retired model; rate-limited model hands over; retired fallback skipped |
| `server/web.test.js` (+3) | Search falls back to the second model; 429 answers at once; last error reported |
| `server/workflows.websearch.test.js` (3) | Search-the-web step on the real engine and database |
| `server/workflows.draft.test.js` (3) | Draft normalization and drafting rules |
| `server/sync-relay.test.js` (4) | Relay protocol, validation, limits, CORS |
| `server/accounts.test.js` (+1) | Cross-site change refused, same-site allowed |
| `client/src/__tests__/AuditFixes.test.ts` (5) | Tool summaries, interrupted reply, tool selection |
| `client/src/__tests__/WebToolsRetry.test.ts` (3) | One wait on a short 429 |
| `client/src/__tests__/PhaseServices.test.ts` (+2) | Deterministic consolidation; export has no side effects |
| `client/src/__tests__/RestoredModules.test.ts` (+1) | Two devices sync through the real relay |

## Live checks (real server, real Groq key, real browser)

| Check | Result |
|---|---|
| Chat answer | "17 times 23 equals 391." |
| Save two memories with approval, recall in a new chat | Both saved and recalled |
| Reminder from chat | Set without a confirmation question |
| Knowledge question | Answered from the document with its citation |
| Auto on preview, agent, chat, `/v1` (plain and streaming, 17 chunks), A2A | All answer with served models |
| Team mode with web search | Completes; under Groq's free per-minute limit it waits and says so |
| Device automation "Morning plan" | Saved, ran, "Done", output in run history |
| Draft a workflow from text, test-run it | Schedule → Search the web → AI summary → Notify, completed in 7.2 s |
| Sign up through the dialog, chat signed in | Works |
| Connect the Hugging Face connector | Connected, 4 tools |
| Speak, Call | Listening starts; call timer runs |
| API smoke (29 checks) | 26 pass. The 3 others are the smoke script sending invalid feedback/report fields and a webhook check not applicable to plain-http targets; those routes are covered by their own suites and by e2e |
| Android debug APK on an Android 16 emulator | Installs, launches, first screen, no crash |
| Live site (v1.5.0) | Accounts on, Neon schema 15; register/sign in/delete; all six download links resolve to v1.5.0 assets |

## Not executed

Real Gmail/Outlook/Calendar/Chat/WhatsApp accounts; providers other than Groq with real keys; calls and SMS on a phone; wake word with a microphone; Siri; the packaged desktop apps by hand; iOS at runtime; Windows and Linux installers by hand (CI builds and launch-checks them).
