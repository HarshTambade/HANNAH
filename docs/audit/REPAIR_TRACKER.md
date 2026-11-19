# Repair tracker

Audit of 2026-11-19, on top of v1.5.0. Statuses: **PASS** (worked, verified), **FIXED** (repaired, tests pass), **PARTIAL**, **BLOCKED** (needs something outside this environment), **FAIL**, **NOT TESTED**.

"Live" means the feature was used in a real browser against a real server and Groq's real API. "Tests" names the automated test that now covers it.

## Repaired

| # | Feature | Original status | Root cause | Priority | Fix | Evidence | Status |
|---|---|---|---|---|---|---|---|
| 1 | Auto model choice (chat, agents, Team, `/v1`, A2A, route preview) | Every Auto request failed: "Groq doesn't offer that model" | Model profiles list Groq models Groq has retired; Auto picked them, and the plain chat route sent the word "auto" as a model name | P3 core | Each hosted provider's live model list is recorded (`server/providers/served.js`) and consulted before any pick; retired models are skipped; a rate-limited model hands over to another served model | Live: Auto answers on all routes. Tests: `server/models-live.test.js` (10) | FIXED |
| 2 | Model pickers | Listed Whisper, Orpheus and prompt-guard models; choosing one broke the agent | `/api/models` and `/v1/models` passed the provider's raw list through | P8 | `isChatModel` filter; catalog marks each model `available`; Models page skips unavailable ones | Live: list is 4 chat models. Tests: `models-live.test.js` | FIXED |
| 3 | Tool results in chat | Raw JSON and whole web pages shown as chat bubbles | The runtime sent the model-facing result to the UI | P9 | `ToolResultSummary.ts`: one readable line per tool | Live. Tests: `AuditFixes.test.ts` | FIXED |
| 4 | Reminders and other direct requests | HANNAH asked "Should I set a reminder?" instead of acting | The system prompt told the model every action needs confirmation; the app already asks where needed | P3 | Prompt now says to call the tool and leave approval to the app | Live: "Reminder set: Stretch · 9:42 PM" | FIXED |
| 5 | Knowledge (your documents) | "I don't have those details" for facts in an added document | `knowledge_search` was offered only when the message said "document" or "notes"; the model also didn't think to search | P4 | Matching passages are sent with the request (server labels them untrusted); the tool is always offered | Live: answered with `[Trip notes §1]` | FIXED |
| 6 | Tool availability | Memory, reminder and web tools vanished from some requests | A second keyword filter dropped tools whose description shared no word with the message | P3 | Core tools always kept | Tests: `AuditFixes.test.ts` | FIXED |
| 7 | Reply interrupted by reload | Message left unanswered; next reply could answer the wrong question | Nothing detected a conversation ending on a user message | P9 | Chat marks it and offers "Ask again" | Tests: `AuditFixes.test.ts`; e2e crawl | FIXED |
| 8 | Web search reliability | Failed on any Groq 5xx; a rate limit looked like a hang | One model, one try; waits were silent | P8 | Second search model, 30 s cap per try, one short client retry on 429, visible "busy · trying again in N s" | Tests: `web.test.js` (7), `WebToolsRetry.test.ts` (3). Live | FIXED |
| 9 | "Export training examples" | Waited up to 2 minutes, wrong message, wrote random notes into long-term memory | It was wired to an "idle window" loop and a consolidator that kept 30% of notes by `Math.random()` | P4 dummy | Export is immediate and read-only; consolidator keeps a note only when it repeats | Tests: `PhaseServices.test.ts` | FIXED |
| 10 | Self-hosted sync relay | Could never sync | App and relay used different addresses and payloads; relay ids were guessable; no limits | P4 dummy | One protocol, limits, CORS (docs/SYNC_PRIVACY.md) | Tests: `server/sync-relay.test.js` (4); two devices through the real relay in `RestoredModules.test.ts` | FIXED |
| 11 | Workflow drafting from a description | Draft fetched `https://example.com/…` and failed; day names and invented model ids made it invalid | No web-search step existed, and the draft wasn't normalized | P6 | New **Search the web** step (`web.search`); drafts can't invent addresses; days, models and placeholder URLs are corrected | Live: drafted workflow ran end to end in 7.2 s. Tests: `workflows.websearch.test.js` (3), `workflows.draft.test.js` (3) | FIXED |
| 12 | Workflows saved with a retired model | Would fail at the AI step | Model stored by name | P6 | Runtime substitutes the provider's default when the model is no longer served | Code path covered by `models-live.test.js` registry tests | FIXED |
| 13 | A2A reply | Could return an empty message | A small model sometimes returns nothing | P8 | One retry on the default model, then an explicit error | Live. Tests: `a2a.test.js` | FIXED |
| 14 | Cross-site requests with a session cookie | Accepted (201) when sent with a foreign `Origin` | Only `SameSite=Lax` protected it | P1 security | Origin check for cookie-authenticated changes | Tests: `accounts.test.js`. Live: 403 | FIXED |
| 15 | Persona "update" | Method threw "not implemented in scaffold" | Leftover stub; nothing called it | P4 | Removed; persona is read-only by design | Typecheck | FIXED |
| 16 | Rate-limit error text | Second error about a Python fallback on 127.0.0.1:8000 | Fallback attempted when nothing runs there | P9 | Original error shown | Live | FIXED |
| 17 | Android app | Service worker failed to install inside the app | The app shell answers `/favicon.ico` with an empty response | P3 | Native and desktop apps don't register the website's worker | Android 16 emulator; `AppShell.test.ts` | FIXED (in 1.5.0) |
| 18 | CI macOS desktop build | Cancelled twice | GitHub had no `macos-latest` runners | P3 | Runs on `macos-15` | CI green | FIXED (in 1.5.0) |
| 19 | Connectors for visitors | Every Connect button answered "Add your Groq API key or a HANNAH access token" unless you were signed in | The connector routes sat behind the AI-key check, although they use no model | P2 | Directory connectors open to visitors; custom addresses still need a sign-in; lower visitor limit | Live browser run as guest, account and operator. Tests: `connectors.test.js` | FIXED |
| 20 | Connector directory | Figma listed, but its server refuses registration (403) | Listed from an earlier check; Figma only accepts approved apps | P4 | Removed. The other 31 sign-in and no-sign-in connectors were probed against the vendors' servers: discovery and registration (or tool listing) all succeed | Probe output, 2026-11-19 | FIXED |
| 21 | Marketplace agents and skills | Looked inert: 3 agents and 3 skills of one short paragraph each; "Install" did nothing until a second "Activate"; chat never showed what was on | Packages were guidance text only, with a two-step flow and no trace in chat | P4 dummy | 10 agents and 12 skills with full instructions, starter prompts and per-agent tools; one click turns a package on; chat bar shows and switches the agent; "Try it with" opens chat with the prompt | Live with the real model: Research analyst searched the web and read a page; Summary first opened the reply with "In short:". Tests: `Marketplace.test.ts`, e2e `navigation.spec.ts` | FIXED |
| 22 | Long tool results | Reading a long page ended the reply with "exceeded the configured output limit" | The reply-length guard was applied to tool output and threw | P3 | Tool output is shortened with a note, or withheld if the safety screen objects | Tests: `Marketplace.test.ts` | FIXED |
| 23 | Next question after a failed reply | HANNAH answered the earlier question again | Two user messages in a row reached the model | P3 | The request marks the unanswered one | Tests: `Marketplace.test.ts` | FIXED |
| 24 | Rate-limited web search | Retried three more times within one reply | The error text said "try again in a moment" | P8 | Tool says not to retry now | Tests: `WebToolsRetry.test.ts` | FIXED |
| 25 | Remote MCP endpoint | 404 on the hosted site; one operator token only | Mounted at process start (never on serverless) | P7 | Mounted with the app; takes a developer key, operator token, Groq key or signed-in session; tool calls carry the caller's credential | Live with a real MCP client incl. a chat call and a new `hk_` key. Tests: `mcp-client.test.js` | FIXED |
| 26 | `/v1` finish reason | `"stop"` with empty content when `max_tokens` ran out | Provider's finish reason was dropped | P7 | `"length"` is passed through | Tests: `models-live.test.js` | FIXED |
| 27 | Integrations page | Documentation only; no way to tell whether anything worked | Never built | P7 | "Test this server now": seven live checks and developer-key creation | Live as guest, account and operator | FIXED |
| 28 | First step for a new visitor | "Paste your Groq API key" before anything else, and sign-up called the key "optional" on a server that needs it | Connect dialog didn't use what the server reports | P9 | Dialog and home page follow `/api/account/status`: free account first when the server's models are included; honest wording otherwise | Live: home → Try this → create account → chat with agent on and message ready. e2e `navigation.spec.ts` | FIXED |

## Verified working (no change needed)

| Feature | Evidence | Status |
|---|---|---|
| Chat with a real model, memory save with approval, recall in a new chat | Live | PASS |
| Team mode: plan → specialist steps with real tool calls → verification | Live (request trace) and against a deterministic model | PASS |
| Device automations: save, schedule, run, run history with output | Live | PASS |
| Server workflows: editor, test run, publish, activate, webhook trigger, retry from failed step, pause and resume, file trigger | e2e `workflows.spec.ts` (5), server workflow suites | PASS |
| Accounts: register, sign in, wrong password, developer keys (create, use, revoke), export, audit log, delete | Live API smoke (26 checks) | PASS |
| OpenAI-compatible API incl. streaming; usage | Live | PASS |
| Private-network (SSRF) refusal on page reads | Live: 169.254.169.254 refused | PASS |
| Operator-only routes refused to accounts (desktop control, MCP servers) | Live: 403 | PASS |
| Connectors marketplace: connect a real MCP server (Hugging Face, 4 tools); Notion redirects to its own sign-in | Live | PASS |
| Voice: Speak and hands-free Call start and listen | Live with a fake microphone | PASS |
| Phone Bridge server side: pairing code, command validation, signed requests | Live + `phone-bridge.test.js` | PASS |
| Download links for all six installers | Live site redirects to v1.5.0 assets | PASS |
| Dashboard figures | Computed from real activity (checked against the session's 3 replies) | PASS |

## Not complete

| Feature | State | What it needs | Status |
|---|---|---|---|
| Gmail, Outlook, Google Calendar, Google Chat | Real OAuth and API code, tested against recorded stand-ins | Your Google/Microsoft OAuth client id and secret on the server, then a real account | BLOCKED |
| WhatsApp, Telegram and other chat channels | Real drivers, tested with stand-ins | Each platform's bot token or business account | BLOCKED |
| Phone calls and SMS from the desktop | Server and app code tested; never run on a phone | A paired physical Android phone or iPhone | BLOCKED |
| Wake word on Android, Siri on iOS | Compiles (CI); app launches on an emulator | A physical phone and microphone | BLOCKED |
| Desktop computer control, terminal, coding agent in shared folders | Unit tests (43 desktop tests) and CI launch check | Hands-on run of the packaged desktop app | NOT TESTED |
| iOS app | Builds in CI | A simulator runtime or device | NOT TESTED |
| OpenAI, Anthropic, Gemini and other providers | Same code path as Groq, tested with stand-ins | A key for each | NOT TESTED |
| Signed installers | Unsigned (your choice) | Apple and Windows certificates, Android keystore | BLOCKED |
| Free accounts without an API key on the live site | Works locally (`HANNAH_ACCOUNTS_USE_SERVER_KEYS=true`); the live server has it off, so visitors still need a Groq key | Owner decision: it spends the operator's Groq quota, within the per-account limits and daily budget | BLOCKED |
| Connector sign-in completed with a real vendor account | Registration and the redirect to each vendor's sign-in page are verified; no vendor account was signed in here | A real Notion, Linear or similar account | NOT TESTED |
| Scheduled server workflows on the live site | Tick endpoint works when called | GitHub secrets `CRON_SECRET` and `HANNAH_PRODUCTION_URL` | BLOCKED |
| 13 panels not shown anywhere (Collective, Digital twin, Spatial context, Presence feed, Memory evolution, Memory router, Oversight, Personalization health, Perception consent, Intervention log, Cast, PAP settings) | Backed by services, no invented data found, but no screen mounts them | A product decision: surface or leave | NOT TESTED |
| Billing | Not implemented; HANNAH has no paid tiers | Nothing | n/a |
| Default avatar | Fan-made model of a Hololive character | Your decision (you chose to keep it) | PARTIAL |
