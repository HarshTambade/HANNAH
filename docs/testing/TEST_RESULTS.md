# Test results

Run on 2026-11-19 on macOS (Apple silicon), Node 25, against the 1.5.1 working tree. Only tests that were actually executed are listed.

## Automated suites

| Suite | Command | Result |
|---|---|---|
| Server unit and API tests | `cd server && node --test` | 331 tests: **330 pass**, 0 fail, 1 skipped |
| Client unit tests | `cd client && npx vitest run` | **373 pass** in 66 files |
| Browser end-to-end (Chromium) | `cd client && npx playwright test` | **85 pass** on the final full run. Earlier full runs in this round: 80 of 83 (three expectations my changes made out of date, plus one real defect: the marketplace page no longer pre-rendered; all fixed), then 84 of 85 (a harness failure, below) |
| Client typecheck | `npx tsc --noEmit -p .` | Clean |
| Client lint | `npm run lint` | 0 errors, 3 warnings |
| Server lint | `npm run lint` | 0 errors |
| Secret scan | `node scripts/scan-secrets.mjs` | No findings in 548 files |
| Dependency audit | `npm audit --omit=dev` in root, client, server | 0 vulnerabilities |
| Audit gate, native permissions, brand assets, version fields | `scripts/*.mjs` | Pass |
| Desktop plugin tests | `desktop` suite | 43 pass (last run for 1.5.0; desktop code unchanged since) |
| CI on `3bf275c` | GitHub Actions "Build HANNAH" | All jobs green: gates, web, e2e, red-team, Electron ×3, Android, iOS |

## End-to-end harness failures found and fixed

`e2e/screens.spec.ts` failed about one run in four, in two ways, neither in the app:

- `route.fetch: read ECONNRESET`: the spec's proxy to its own test server picked up a keep-alive connection the server had just closed. The proxy now sends such a request again, once.
- `The HANNAH server didn't start`: the spec chose a random port and sometimes hit one in use. It now asks the operating system for a free port.

After both changes the spec passed 8 runs out of 8, and the full suite passed. A failed request's address is now printed, so a future failure names the request.

## New tests in this round

| File | Covers |
|---|---|
| `server/connectors.test.js` (+1) | A visitor with no credential can use directory connectors; any other address and every other route are refused |
| `server/mcp-client.test.js` (+1) | `/mcp` with the caller's own credential; none or a wrong one refused; the standalone mount still needs its token |
| `client/src/__tests__/Marketplace.test.ts` (9) | Catalog completeness; every agent tool exists; one click turns a package on; five-skill limit; chat hand-off; agent tools survive both filters; long tool output shortened; unanswered message marked |
| `e2e/features.spec.ts` (+1), `e2e/connectors.spec.ts` (+1), `e2e/navigation.spec.ts` (+1) | Integration checks pass and fail visibly; a visitor connects a connector; home page prompts lead into chat |
| `server/models-live.test.js` (11) | Chat-model filter; served-model registry; `/api/models`, `/api/catalog`, `/v1/models`; Auto on `/api/agent`, `/api/chat`, `/v1`, A2A and route preview never asks for a retired model; rate-limited model hands over; retired fallback skipped |
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
| Every connector in the directory, against the vendors' own servers | 31 of 32 checked: 5 list their tools with no sign-in; 26 accept HANNAH's registration and return their sign-in address. GitHub takes a pasted token and wasn't checked. Figma refused (403) and was removed |
| Connect as a visitor, an account and the operator (browser) | Before: visitor got 401 on every connector. After: Hugging Face connects (4 tools) and Notion goes to its own sign-in page, in all three modes |
| Research analyst agent | Searched the web (10 sources), stopped when the search was rate-limited instead of retrying, answered with named sources |
| Summary first skill | Both replies opened with "In short:" |
| A question after a failed reply | Before: answered the earlier question. After: answered the new one |
| Integrations page checks | Operator: 6 pass, webhooks skipped (needs an account). Account: all 7 pass. Visitor: public checks pass, the rest say "connect first" |
| Remote MCP with a real MCP client | Lists 3 tools; `hannah_status`, `hannah_models` and a real `hannah_chat` ("ready"); a new `hk_` key works; no or wrong credential gets 401 |
| New visitor on the home page | Try this → create an account with no API key → chat with Research analyst on and the message in the box |
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

Signing in to a connector with a real vendor account (only registration and the redirect were checked); the live site after these changes (not deployed yet); real Gmail/Outlook/Calendar/Chat/WhatsApp accounts; providers other than Groq with real keys; calls and SMS on a phone; wake word with a microphone; Siri; the packaged desktop apps by hand; iOS at runtime; Windows and Linux installers by hand (CI builds and launch-checks them).
