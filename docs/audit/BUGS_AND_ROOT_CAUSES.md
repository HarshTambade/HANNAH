# Bugs and root causes

Found by using HANNAH with a real model on 2026-11-19. Numbers match [REPAIR_TRACKER.md](./REPAIR_TRACKER.md).

## 1. Auto failed on every request

- **Seen:** "hi" with Auto answered `Groq doesn't offer that model` (agent route) or `Groq could not respond using its configured model fallback chain` (chat route).
- **Chain break:** UI → `/api/agent` → `router.route()` → `llama-3.1-8b-instant` → Groq 404.
- **Root cause:** `shared/model-profiles.json` and the provider catalog describe models as of an earlier date. Groq has since retired seven of them. Nothing compared the curated list with what the provider serves. `/api/chat` also forwarded the literal string `auto`.
- **Fix:** `server/providers/served.js` keeps each hosted provider's live list for 30 minutes (filled by any model discovery, and by `ensureServed` before a pick). `router.collectCandidates`, `gateway.pickAutoModel`, the catalog, `/api/models`, `/v1/models`, the workflow runtime and the fallback chain all skip a model the list doesn't have. Unknown stays permissive, so an outage of the model-list call can't block chat.
- **Files:** `server/providers/{served,runtime,catalog}.js`, `server/{router,gateway,index,v1,a2a,orchestrate}.js`, `server/workflows/runtime.js`, `client/src/services/ModelAdvisor.ts`, `client/src/components/workflows/ParamField.tsx`.

## 2. Non-chat models in pickers

- **Root cause:** provider `/models` responses include speech, TTS, guard and embedding models; HANNAH listed them all.
- **Fix:** `isChatModel` (name-based) in `server/providers/runtime.js`, applied where lists are shown.
- **Limit:** it's a name filter. A provider that names a non-chat model unusually would slip through.

## 3. Raw tool output in chat

- **Root cause:** `AgentRuntime` emitted the same text to the UI that it sends to the model.
- **Fix:** `client/src/services/ToolResultSummary.ts`; the model's copy is unchanged.

## 4. Asking instead of doing

- **Root cause:** one prompt sentence ("…require confirmation") made the model ask in chat, duplicating the app's approval card.
- **Fix:** prompt reworded in `server/index.js`. Approval is still enforced in code (`SafetyGuard.confirm`), not by the prompt.

## 5 and 6. Documents and tools missing from requests

- **Root cause:** two successive keyword filters (`selectToolsForRequest`, then `selectRelevantTools`) chose tools by words in the message. The second kept only device-status tools as a core set.
- **Fix:** core tools always kept; matching Knowledge passages travel with the request (`knowledge` field, at most 3 × 1,200 characters, labelled untrusted in the system prompt).

## 7. Interrupted reply

- **Root cause:** the conversation is saved when the user's message is added; a reload before the reply left it dangling with no marker.
- **Fix:** `interruptedMessageId` in `ChatHistory.ts`; "Ask again" replaces the dangling message.

## 8. Web search

- **Root cause:** a single Groq call with a 60 s timeout inside a 75 s client wait; 429 and 5xx failed the step; waits weren't shown.
- **Fix:** `searchWeb` in `server/web.js` (two models, 30 s each, immediate 429 with `Retry-After`); client waits out one short 429; rate-limit waits are shown in chat and in Team.
- **Note:** during the audit Team mode looked hung. It wasn't: the run was waiting out Groq's per-minute limit on the free key, silently. The visible wait message is the fix for that.

## 9. Export training examples / memory consolidation

- **Root cause:** dummy logic. `OnDeviceLoRAService.prepare` polled an "idle" detector for up to two minutes, then ran `DreamingConsolidator`, which kept short notes with probability 0.3, then reported "no idle window" when there were fewer than three examples.
- **Fix:** export is immediate and has no side effects; the consolidator's rule is deterministic.

## 10. Sync relay

- **Root cause:** the relay (`server/sync-relay.js`) and the client were written against different protocols and never run together.
- **Fix:** rewritten relay with per-device storage and limits; client posts `{ deviceId, envelope }` to `/sync` and reads `/sync/<deviceId>`.

## 11. Workflow drafts that can't run

- **Root cause:** the step catalog had no way to get current information, so the model invented an HTTP address; draft output wasn't validated against each parameter's type.
- **Fix:** `web.search` node; drafting rules; `normalizeDays`, model and placeholder-URL normalization in `draftFromText`.

## 13. Empty A2A reply

- **Root cause:** the small model Auto picks for short messages occasionally returns empty content.
- **Fix:** retry once on the provider default, else a JSON-RPC error.

## 14. Cross-site request with a session cookie

- **Root cause:** state-changing routes trusted the cookie without checking `Origin`. Current browsers withhold a `SameSite=Lax` cookie from cross-site POSTs, so this was defense in depth, not an open hole.
- **Fix:** `accountAuth({ originAllowed })`: allowed origins, the server's own host, and local development hosts outside production.

## 19 and 20. Connectors

- **Seen:** on the live site, Connect on any connector answered `Add your Groq API key or a HANNAH access token.` (HTTP 401) for a visitor who hadn't signed in.
- **Chain break:** Connect → `POST /api/connectors/rpc` or `/register` → `requireApiToken` → 401. The routes were in the bring-your-own-key list, so they needed an AI key although they call no model.
- **Fix:** `GUEST_PATHS` in `server/api-security.js` lets a request with no credential reach the four connector routes as a guest; `server/connectors.js` refuses a guest any address outside its catalog (`sign-in-required`) and gives guests 40 requests a minute instead of 120.
- **Also:** Figma's registration endpoint answers 403 to unapproved apps; removed from the catalog. The other 31 were probed against the vendors' servers.

## 21. Marketplace agents and skills

- **Root cause:** each package was a paragraph of prompt text, sent correctly, but (a) "Install" only recorded the package and a separate "Activate" was needed, (b) nothing in chat showed that a package was on, (c) there were six in total. A person who installed one saw no change.
- **Fix:** catalog of 22 with `starters` and, for agents, `tools`; `MarketplaceService.turnOn`; `ActiveAgentBar` in chat; agent tools kept through both tool filters; the server accepts one agent and five skills and tells the model to work as the agent describes.
- **What an agent is, plainly:** instructions, tools kept to hand and suggested prompts. It does not run code or add permissions; tools still ask for approval.

## 22. Long tool results ended the turn

- **Root cause:** `screenOutgoingText`, the guard for HANNAH's own replies (8,000 characters), was also applied to tool output, where it threw.
- **Fix:** `screenToolOutput` shortens with a note, or withholds the output if the safety screen objects.

## 23. The question after a failed reply was ignored

- **Root cause:** a failed turn leaves the user's message with no reply after it; the next request then carried two user messages in a row and the model answered the first.
- **Fix:** `withUnansweredMarked` in `AgentRuntime.ts` puts a note between them.

## 25. Remote MCP endpoint

- **Root cause:** `/mcp` was mounted inside `startServer()`, which serverless hosting never calls, and only when `MCP_ENABLED=true` with a single `MCP_API_TOKEN`.
- **Fix:** mounted with the app, loaded on first use, behind the same credential checks as `/api/chat`; `createHANNAHMcpServer` takes the caller's credential for its API calls.

## 26. `/v1` finish reason

- **Root cause:** `callProviderMeasured` discarded the provider's `finish_reason`; `/v1` always said `"stop"`.
- **Seen through:** the new Integrations check, whose 24-token test request came back empty from a reasoning model.

## 28. A new visitor's first step

- **Root cause:** the connect dialog always opened on "paste your Groq API key", whatever the server offered.
- **Fix:** `ConnectPanel` and the home page read `accounts.serverKeys` from `/api/account/status`.
- **Limit:** the live server has `serverKeys: false`. Until the owner turns on `HANNAH_ACCOUNTS_USE_SERVER_KEYS`, visitors there still need a Groq key; the page says so.

## Test infrastructure issues met on the way

- `e2e/workflows.spec.ts` matched `/Valid/`, which also matched the "Validate" step. Now exact.
- One full e2e run failed once with `ECONNRESET` from the test's own server during the signed-in crawl; it passed alone and on the next two full runs. Treated as a flake; not reproduced.
- Running the server test suite while a development server holds port 3001 hangs one test file. Stop the development server first.
- One research turn failed once with a network error from the provider after a long page read (logged as `TypeError`, a failed `fetch`). Replaying the same request succeeded; not reproduced.
