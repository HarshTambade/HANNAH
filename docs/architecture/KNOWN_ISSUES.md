# HANNAH known issues

From the 2026-11-18 audit ([REPOSITORY_AUDIT.md](REPOSITORY_AUDIT.md)). Each entry gives the subsystem, evidence, severity, dependencies and the fix. **Fixed** means fixed in code with tests and, where possible, a real run. It isn't released until the next version ships.

## Summary

| ID | Subsystem | Issue | Severity | Status |
| --- | --- | --- | --- | --- |
| KI-1 | Workflow engine | AI steps failed on provider rate limits | P0 | Fixed |
| KI-2 | Production deployment | No account database, vault key or scheduler tick in production | P0 | Owner action |
| KI-3 | CI | Windows Electron job fails the audit gate on a path separator | P0 | Fixed; CI green (run 44250391204) |
| KI-4 | Workflow engine, run page | "Completed" runs that skipped most steps, with no explanation | P1 | Fixed |
| KI-5 | Workflow drafting | "Describe it" failed with a raw "HTTP 429" | P1 | Fixed |
| KI-6 | Gateway, production | Guests share the operator's free AI key | P1 | Owner decision |
| KI-7 | Website routing | `#features` / `#download` left in the address bar | P3 | Fixed |
| KI-8 | Releases | Tags without releases (the old "Shanaya v1.0.2" title is now "HANNAH v1.0.2") | P3 | Owner decision (tags) |
| KI-9 | Branding in installers | v1.4.0's macOS app has Electron's icon and its Android app Capacitor's | P1 | Fixed on main, not yet released |
| KI-10 | Repository structure | A second, unshipped app path in the root workspace | P2 | Owner decision |
| KI-11 | Workflow AI steps | Free-plan throughput: each AI step requests up to 1,200 output tokens | P1 | Open |
| KI-12 | Desktop, Windows/Linux | Desktop features unverified on Windows and Linux | P2 | Open (packaged app now launches in CI on both) |
| KI-13 | Mobile native | Phone Bridge and native plugins not run on physical devices | P2 | Open (needs devices) |
| KI-14 | Workflow run data | AI token counts shown as “[redacted]” | P3 | Fixed |
| KI-15 | Workflow recovery | Runs dead-lettered on their first crash after a few normal resumes, with a false message | P0 | Fixed (Milestone 1) |
| KI-16 | Workflow control | No way to pause a running execution | P1 | Fixed (Milestone 1) |
| KI-17 | Workflow loops | An HTTP step calling a webhook could re-trigger workflows without end | P1 | Fixed (Milestone 1) |
| KI-18 | Run page | Stopped updating while a run waited; no "now running" step or retry status | P2 | Fixed (Milestone 1) |
| KI-19 | Workflows on Vercel | Runs executed inside one request with no time budget: cut off mid-step at the function's limit, counted as crashes | P0 | Fixed (deployed 2026-11-18) |
| KI-20 | Branding, updater | Site, app, updater feed and downloads used the old repository name (worked only through GitHub's rename redirect) | P2 | Fixed (deployed; live site checked 2026-11-18) |
| KI-21 | Web and phone apps | No web search or page reading outside the desktop app; HANNAH said she couldn't browse | P1 | Fixed (deployed 2026-11-18) |
| KI-22 | New integrations | Connectors' OAuth with real vendors, Groq browser search, the Vercel + Supabase setup and the Telegram bot are tested against protocol fakes and read-only real endpoints, not yet end to end with real accounts | P1 | Needs a live run with the owner's accounts |
| KI-23 | iOS build, toolchain | With Xcode 27 the LanceDB plugin's Swift bindings can't find their Rust module, so the iOS app doesn't build; CI's current Xcode builds it | P2 | Open (breaks CI when GitHub's macOS runners move to Xcode 27) |

## Details

### KI-1: AI steps failed on provider rate limits (P0, fixed)

- **Subsystem:** server workflow engine (`server/workflows/engine.js`, `runtime.js`).
- **Evidence:**
  - **The failure:** six invoice-intake runs were started together against the real Groq API on the free key. 4 of 6 failed at "Extract invoice" with `Provider returned HTTP 429.`
  - **The cause:** AI steps have 0 retries by default (`settings.retries`), and the engine ignored the provider's `Retry-After`.
- **Fix:**
  - **Clear errors:** `explainProviderError` turns provider errors into messages people can act on: rate-limited (with `retryAfterMs`), key rejected, request too large, provider error.
  - **Other providers:** in Auto, `services.ai` tries every provider the account has a key for, and moves on when one is busy or failing.
  - **Waiting:** a rate-limited step waits for Retry-After (or 10 s doubling, with jitter). It keeps trying for up to 30 minutes and 12 tries, without using the step's own retries.
  - **In place or parked:** waits up to 20 s happen in place (5 s on serverless); longer ones park the run as a durable timed wait that the worker or tick resumes.
- **Tests:**
  - `engine.test.js` "AI provider rate limits": waits the Retry-After, parks and resumes, the 12-try limit, the 30-minute window, a rejected key fails at once.
  - `workflows.test.js` "AI rate limits…" on SQLite and Postgres, with the real worker: a short wait is waited out; a long wait parks with a message, then finishes when due; Auto uses an OpenAI key while Groq is busy.
- **Real runs after the fix:** the same key let through less than one request a minute during these runs, a quota used elsewhere (see KI-6).
  - **First version (6 tries), burst of 12:** no raw 429. 3 runs ran out of tries after about 20 minutes, each with the full explanation.
  - **Final version (30-minute window), burst of 6:** **5 of 6 completed**, after waiting up to about 25 minutes. 1 failed at 29.6 minutes with "kept trying for 29 minutes (11 tries)" and what to do.
  - **Before the fix:** 4 of 6 failed within seconds.
- **Dependencies:** none. On Vercel, parked runs resume only when the tick runs (KI-2).

### KI-2: production has no account database, vault key or tick (P0, owner action)

- **Subsystem:** deployment (Vercel), accounts, workflows, Phone Bridge, sync.
- **Evidence:** read-only requests to production on 2026-11-18, re-checked the same day with production serving `main` at adf9585 (its workflow page has strings first added in that commit):
  - `GET /api/account/status` → `{"accounts":{"enabled":false,"signup":false},"database":{"configured":false},"vault":false}`;
  - `POST /api/account/register` → 503 `database-unconfigured`;
  - `GET /api/workflows/tick` → 401 (no `CRON_SECRET`);
  - `vercel.json` has no `crons`; `.github/workflows/workflow-tick.yml` exists but hasn't run yet, and skips until the repository secrets `HANNAH_PRODUCTION_URL` and `CRON_SECRET` are set.
- **Code or configuration:** configuration. The same code runs end to end in the serverless setup (`workflows.serverless.test.js`) once a database, vault key and `CRON_SECRET` are set.
- **Effect:** no one can sign up, so nothing durable runs. That covers server workflows, schedules, webhooks, sync and Phone Bridge pairing. People get device routines only, which run while HANNAH is open.
- **Fix (needs the owner's secrets; not done by the agent):**
  1. In the Vercel project, open Storage and create or connect a Supabase database (Vercel Marketplace). It adds `POSTGRES_URL`, which HANNAH now reads, verified against Supabase's CA; nothing to copy. (Or set `DATABASE_URL` to any Postgres.) Migrations run on start.
  2. Nothing more is needed for the vault: without `HANNAH_VAULT_KEY`, HANNAH derives its key from the integration's `SUPABASE_JWT_SECRET`. Optionally set your own `HANNAH_VAULT_KEY` (64 hex characters; keep a copy). Integrations → Database generates one, and `CRON_SECRET`, in the browser.
  3. Set `CRON_SECRET` (16+ characters).
  4. Call `GET https://hannah.eliteforums.in/api/workflows/tick` with `Authorization: Bearer $CRON_SECRET` every few minutes. Vercel Hobby only allows daily crons. The repository's `workflow-tick.yml` does this every 5 minutes once the repository secrets `HANNAH_PRODUCTION_URL` (`https://hannah.eliteforums.in`) and `CRON_SECRET` (the same value as on Vercel) are set. GitHub's schedules are best-effort and can start late; cron-job.org is more punctual. On Pro, add `"crons": [{ "path": "/api/workflows/tick", "schedule": "*/5 * * * *" }]` to `vercel.json` instead.
  5. Check: `/api/account/status` shows `database.configured: true`; sign up; run a template.
- **In-app fix (new):** Settings → Account → “Set up HANNAH on Vercel and Supabase” does steps 1–3 and the redeploy from a Vercel token and a Supabase token (server/hosting-setup.js). Then add `CRON_SECRET` and `HANNAH_PRODUCTION_URL` as GitHub secrets for step 4.
- **Dependencies:** blocks every durable feature for real users.

### KI-3: Windows CI fails the audit gate (P0, fixed)

- **Subsystem:** CI (`scripts/audit-gate.mjs`).
- **Evidence:**
  - Runs 44241654445, 44235727167, 44232879284 and 44173446581 fail only in "Electron (windows-latest) → Dependency audit (Electron packaging tools)", with "9 finding(s) at or above high without an exception".
  - The exceptions exist for scope `client/electron`; on Windows, `path.relative` gave `client\electron`.
- **Fix:** the scope is normalised to forward slashes. Checked with `path.win32` (`client\electron` → `client/electron`), and the gate passes on macOS.
- **Confirmed:** CI run 44250391204 (commit `b83ed58`) passed every job. On Windows that includes the audit, packaging and the packaged-app launch, which hadn't run since 2026-11-17.

### KI-4: "completed" runs that did nothing (P1, fixed)

- **Subsystem:** workflow engine, run page (`ExecutionDetail.tsx`).
- **Evidence:** in the real run of the evening template on a day without reminders, the run was **Completed** with 3 of 5 steps skipped. The AI-drafted "every morning summarize my reminders and notify me" did the same, so no notification came.
- **Fix:**
  - **New option:** Aggregate has "When nothing arrives: Continue with an empty list". The engine runs it when the step before it produced nothing at all, but not on a branch If or Switch didn't take.
  - **Run page:** it names the step that returned nothing and how many steps that stopped (`emptyStops`).
  - **Drafting:** the drafter is told about the option.
  - **Template:** the morning mail template uses it.
- **Tests:** `engine.test.js` "Aggregate when nothing arrives" (default skip, continue, branch not taken); `WorkflowRunNotes.test.ts`.

### KI-5: AI drafting failed with a raw 429 (P1, fixed)

- **Subsystem:** `POST /api/workflows/from-text` (`router.js`).
- **Evidence:** a real call returned `429 {"error":"Provider returned HTTP 429."}`.
- **Fix:** `aiWithShortWaits` waits out two short limits (up to 15 s each). Otherwise it answers 429 with `reason: "rate-limited"`, `Retry-After` and "Try again in N seconds".
- **Test:** `workflows.test.js` "drafting from a description reports a rate limit clearly, with Retry-After".

### KI-6: guests share the operator's free AI key (P1, owner decision)

- **Subsystem:** gateway, production configuration.
- **Evidence:**
  - Production `/api/health` → `{"provider":"Groq","guestAccess":true}`.
  - In this audit the operator key let through less than one request a minute for 20 minutes, with Retry-After values of several minutes. That's consistent with its quota being used elsewhere, or a daily token limit.
- **Effect:** chat and AI steps for everyone without their own key are slow or refused at busy times.
- **Options:**
  1. Ask guests to add their own free key after a few messages.
  2. A paid plan for the operator key.
  3. Add a second provider key so Auto can fall over.
  4. Lower per-guest limits.
- **Dependencies:** per-account keys need KI-2.

### KI-7: hashes in the address bar (P3, fixed)

- **Subsystem:** website (`LandingPage.tsx`, `client/about/index.html`).
- **Evidence:** the About page's own section links and its links to `/#features` and `/#download` left the hash in the address bar.
- **Fix:**
  - **Landing page:** it scrolls to the section and replaces the URL without the hash.
  - **About page:** in-page links scroll without writing a hash, and still work without JavaScript.
- **Test:** `e2e/navigation.spec.ts` checks the URL has no hash in both cases (14 navigation and routing tests pass).

### KI-8: releases and tags disagree (P3, owner decision)

- **Evidence:**
  - `gh release list` shows v1.4.0, v1.3.0 and v1.0.2 (renamed from "Shanaya v1.0.2" to "HANNAH v1.0.2" on 2026-11-18).
  - `git tag` also has v1.0.3, v1.1.0 and v1.2.0, with no releases.
  - Version fields all say 1.4.0, matching the latest release.
- **Options:** publish notes for those tags, or delete the tags. Deleting tags is outward-facing and can't be undone for people who fetched them, so it's the owner's call. Rename the v1.0.2 release title if the old name matters.

### KI-9: v1.4.0 ships framework icons (P1, fixed on main, not released)

- **Subsystem:** desktop packaging (electron-builder), the Android app's resources, release process.
- **Evidence:** the v1.4.0 release files were downloaded from GitHub and opened.
  - **macOS:** `HANNAH-mac-arm64.zip` → `HANNAH.app/Contents/Resources/electron.icns`, the only icon, named in `CFBundleIconFile`. Rendered, it's **Electron's default atom logo**.
  - **Android:** `HANNAH-Android.apk` → `res/mipmap-xxxhdpi-v4/ic_launcher.png` and `ic_launcher_foreground.png`. Rendered, they're **Capacitor's default blue "X" on a grid**. The APK also still has the template's `drawable/ic_launcher_background.xml` and `drawable-v24/ic_launcher_foreground.xml`.
- **Cause:**
  - The icon wiring was added in commit `423ab5a` (2026-11-18), after `v1.4.0` was tagged (2026-11-17). That covers `mac.icon`, `win.icon` and `linux.icon` in `client/electron-builder.yml`, the copy into `build-resources/` in `client/scripts/prepare-electron-release.mjs`, and HANNAH's Android mipmaps.
  - `check-brand-assets.mjs` checks the source files only, so nothing looked at what was shipped.
- **Current state:**
  - A macOS app packaged from the current code has `icon.icns`, byte-identical to HANNAH's, and it renders as HANNAH's ring.
  - **Android:** the APK from the latest `main` CI run (44241654445, `apk/debug/app-debug.apk`) renders as HANNAH's ring. It has the monochrome layer and none of the template drawables.
- **Fix:**
  - **Release:** a new release built from `main` is needed. Until then, every download shows the wrong icons.
  - **New CI step, "Check the packaged app's icon":** it runs `scripts/check-packaged-icons.mjs` after packaging on macOS and Linux. It passes on the current macOS package and fails on the v1.4.0 app. It passed on both macOS and Linux in CI run 44250391204.
- **Not covered:** the icon embedded in the Windows `.exe` isn't parsed (the NSIS config is checked at source).

### KI-10: second app path (P2, owner decision)

- **Evidence:**
  - `apps/frontend`, `apps/desktop`, `apps/mobile` and `backend/` (Python) have their own routing and tool contracts.
  - They aren't built by the release jobs.
  - The root `package.json` makes them workspaces, which brings electron-builder (and the root audit exceptions) into the root.
- **Options:** archive them, or move them out of the root workspaces and label them experimental. Not changed here: it's a large deletion.

### KI-11: AI steps request more than they need (P1, open)

- **Evidence:** `services.ai` defaults to `maxTokens: 1200` for every AI step. That includes Classify, which answers with one word, although reasoning models also need room to think. Some providers may count the requested output against the per-minute budget (not confirmed for Groq).
- **Plan:** measure the tokens used per node type with the default model, then set per-node defaults with headroom for reasoning models. A smaller limit that truncates answers would be worse than slow runs, so measure first. KI-14 makes the usage visible.

### KI-12: desktop features on Windows and Linux (P2, open)

- **Evidence:**
  - CI packages and launches the app on all three systems.
  - Screen viewing, app opening, HANNAH's browser and PDF notes were run on macOS only.
  - Windows CI was also stopping before packaging (KI-3). Since run 44250391204, the packaged app launches in CI on Windows and Linux; the features themselves still need a run on those systems.
- **Plan:** after KI-3, run the desktop smoke test and the browser and PDF harness on a Windows and a Linux machine.

### KI-13: native mobile features not run on devices (P2, needs devices)

- **Evidence:**
  - The Phone Bridge (`PhoneBridge.ts`, `HannahPhonePlugin.swift`) and native plugins (`capacitor-lancedb`, `capacitor-mobile-claw`, `capacitor-mobilecron`) have unit tests and CI builds.
  - No run on a physical phone is recorded.
  - `scripts/phone-bridge-android-e2e.mjs` exists for an Android device.
- **Plan:** run it on an Android phone. For iOS, signed builds are needed first.

### KI-14: AI token counts hidden as secrets (P3, fixed)

- **Subsystem:** workflow run data (`engine.sanitize`).
- **Evidence:** the real runs' AI steps showed `usage: { promptTokens: "[redacted]", completionTokens: "[redacted]", totalTokens: "[redacted]" }`. Keys containing "token" were masked even when the value was a count, so people couldn't see what a step used. That information is needed for KI-11.
- **Fix:** count-style keys (`promptTokens`, `total_tokens`, `maxTokens` …) with a number value are shown. Tokens, string values and numeric passwords stay hidden.
- **Test:** `engine.test.js` "shows an AI step's token counts but still hides tokens and numeric passwords".

### KI-15: runs dead-lettered on their first crash (P0, fixed)

- **Subsystem:** workflow runtime (`runtime.js` tick, crash recovery).
- **Evidence:**
  - `attempts` went up on every claim of a run, including normal resumes after a Wait, an approval or a rate-limit pause.
  - Crash recovery dead-lettered a run once `attempts >= 3`. So a run that had waited three times was dead-lettered the first time its worker died, with the false message "the worker stopped N times".
  - In the real-Groq burst, runs reached 10+ claims.
- **Fix:** migration 10 adds `recoveries`, counted only when a stalled run is put back in the queue. Dead-lettering uses it, and the run page shows it.
- **Tests:**
  - `workflows.test.js`: a run with 9 claims and no recoveries is recovered, not dead-lettered; the fourth crash dead-letters with "stopped 4 times".
  - `workflows.restart.test.js`: the real server is killed with SIGKILL; the run shows `recoveries: 1`.

### KI-16: no pause for a running execution (P1, fixed)

- **Fix:** `POST /api/workflows/executions/:id/pause`.
  - **Queued run:** pauses at once.
  - **Running run:** stops before its next step, after the step in progress finishes. It parks as a `paused` wait and survives restarts.
  - **Resume** (`/resume`): continues from that step; finished steps never run again. Cancel works while paused.
  - **Run page:** Pause and Resume buttons, and a "Paused" status.
- **Tests:** `engine.test.js` "pause"; `workflows.test.js` "pause: …" (pausing during a 4-second HTTP call, no repeated call, queued pause, cancel while paused, another account refused); `e2e/workflows.spec.ts` "a live run shows the step in progress, pauses … and resumes".

### KI-17: webhook loops (P1, fixed)

- **Evidence:** event-triggered chains were capped (depth 3) but untested. Nothing stopped an HTTP step from calling its own workflow's webhook, or two workflows calling each other's.
- **Fix:**
  - Every HTTP step sends `X-Hannah-Hops` (the hops that led to its run, plus one), set last so a step's own headers can't override it.
  - Webhooks refuse with 508 past 5 hops, and a run records its `$hops`.
- **Tests:** `workflows.test.js` "loop guards": a self-calling workflow stops after the first call plus 5 hops, with the 508 explanation, and a spoofed hop count is refused. Two workflows triggered by each other's completion stop by themselves, and more ticks start nothing new.

### KI-18: run page during waits and retries (P2, fixed)

- **Fix:**
  - The run page keeps polling (every 5 s) while a run waits, so a run the worker continues later updates on screen.
  - A live status names the step running or retrying (with attempt, elapsed time and last error).
  - The header shows elapsed time while running, and the canvas highlights the running step.
  - A note appears when the server stopped during the run and it continued from a checkpoint.
- **Tests:** `WorkflowRunNotes.test.ts` "what a live run is doing now" (a finished run never shows as live); the e2e pause test sees "Running “Slow one”".

### KI-19: workflow runs on Vercel cut off mid-step (P0, fixed, not yet deployed)

- **Evidence:**
  - On serverless hosting, Run, webhooks, retries and the tick ran an execution inside the request. The time budget only limited which runs *started*: `tick` then awaited each run to the end (a workflow may run 15 minutes by default, up to 60), and Run answered only after the whole run.
  - A Vercel function is stopped at its time limit (at most 300 s on Hobby). A longer run was then stopped mid-step. Its lease expired and the next tick recovered it as a crash, and after 4 such stops it was dead-lettered although every pass made progress. Meanwhile the Run request hung or failed with a timeout.
  - `workflows.serverless.test.js` reproduces it: on the old code, Run returned only once the run had `completed`, instead of handing it back.
- **Fix:**
  - Serverless requests and ticks pass a deadline. Before each step that hasn't started, a run past the deadline hands itself back as `queued` with its checkpoint; the next poll or tick continues it. At least one step runs per call.
  - Handing back doesn't count as a recovery.
  - The workflow time limit now counts active time across calls (`state.activeMs`), so it isn't reset by handing back or recovering.
  - `WORKFLOW_REQUEST_BUDGET_MS` and `WORKFLOW_TICK_BUDGET_MS` set the budgets (defaults 20 s and 50 s).
- **Tests:**
  - `engine.test.js` "yielding": hand-back and continuation, progress with no budget, active time across calls.
  - `workflows.serverless.test.js` runs the real server as on Vercel (`VERCEL=1`, no worker):
    - a long run is handed back and finished by the tick, with no steps repeated and recoveries 0;
    - the tick refuses requests without the secret;
    - watching the run keeps it going;
    - webhook and scheduled runs work;
    - a failing step is retried and reported with its attempts;
    - a function killed mid-step is recovered by a later tick.

### KI-20: old repository name in the site, app and updater (P2, fixed, not yet deployed)

- **Evidence:** the repository was renamed to `HarshTambade/HANNAH`, but the website (source, licence, changelog, platform support, privacy policy and issue links), the About page, the desktop app, the server's release lookup, the README and the desktop auto-updater's feed (`electron-builder.yml`) still named `Shanaya-Your-AI-companion`. They worked only because GitHub redirects renamed repositories.
- **Fix:** all of them use `HarshTambade/HANNAH`; `HANNAH_RELEASES_REPOSITORY` still overrides the server's default. Installed v1.4.0 apps keep the old name in their update feed and rely on the redirect until they update.
- **Tests:** `e2e/routing.spec.ts` checks every GitHub link on the landing page.

### KI-21: no web search outside the desktop app (P1, fixed, not yet deployed)

- **Evidence:** the browser tools only exist in the desktop app (`getBrowserTools` returns nothing elsewhere), and the research specialist was told to say it couldn't browse. On the website and phones, "search for…" had no tool to use.
- **Fix:** `web_search` (Groq's browser search on the GPT-OSS models, with the request's own Groq key) and `web_read` (a public page through the SSRF-safe client) on every platform. `web_search` is a core tool, so trimming to 20 tools always keeps it. Search words bring the web family.
- **Tests:** `web.test.js` (request shape against a fake Groq, sources, errors, page text, blocked addresses), `ToolSelection.test.ts` (the web set), and page reading checked live on Wikipedia and BBC News. Groq's compound models were retired in September 2026, so they aren't used.

### KI-22: new integrations need a live run with real accounts (P1)

- **Tested so far:**
  - Connector sign-in, through a local server that follows the MCP authorization spec, with real discovery against Linear, Notion, Atlassian, Stripe and GitHub.
  - Real tool lists and a real tool call on six open servers.
  - The hosting setup against fake Vercel and Supabase APIs. A dummy token got "unauthorized" (not "not found") from every real endpoint used, so the paths are real.
  - Telegram, against a fake Bot API.
- **Not yet:**
  - signing in to a real vendor (each sign-in registers HANNAH with that vendor);
  - a real Groq browser search (no key was available here);
  - running the hosting setup on the owner's accounts;
  - a real Telegram bot.
- **Next:** the owner runs each once after deploying. Every failure shows the service's own message.

### KI-23: iOS doesn't build with Xcode 27 (P2, open)

- **Evidence:** on 2026-11-18, `xcodebuild … -destination generic/platform=iOS CODE_SIGNING_ALLOWED=NO build` with Xcode 27.2 (after `npm run cap:patch:ios`, as CI does) fails in `node_modules/capacitor-lancedb/ios/Sources/LanceDBPlugin/Generated/lancedb_ffi.swift` with "cannot find type 'RustBuffer' in scope": the `#if canImport(lancedb_ffiFFI)` guard doesn't find the module inside `LanceDBFFI.xcframework`. CI's `macos-latest` image still builds and archives the app.
- **Effect:** none today. When GitHub moves `macos-latest` to Xcode 27, the iOS job will fail.
- **Options:** pin the iOS job to an Xcode version that works, until the plugin ships bindings that build with Xcode 27, or patch the module map in `scripts/patch-capacitor-ios.mjs`.
