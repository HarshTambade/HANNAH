# Changelog

All notable changes to HANNAH. Versions follow [Semantic Versioning](https://semver.org/). Android `versionCode` and the iOS build number are `MAJOR×10000 + MINOR×100 + PATCH`.

## 1.4.0 — Unreleased

### New

- **Automations that run.** Saved routines now run daily, on weekdays or every few hours while HANNAH is open in a tab or the desktop app; a run that was due while HANNAH was closed happens once when it reopens. Each step passes its result to the next. Actions (save to memory, create a reminder) pause until you approve or deny them, and every run is kept in a run history with its steps and result. You can run any automation on demand, edit it, and turn its schedule on or off.
- **Files and terminal on desktop.** Share folders in Settings → Desktop access, and HANNAH and the Coding agent can read them, change files in read-write folders, and run commands such as your tests. The desktop app enforces the limits in its main process, outside the AI model: paths can't leave a shared folder (symlinks included), and every write and every command waits for your yes in a system dialog. Commands run without a shell, with a time limit.
- **Tasks across devices.** Signed in on more than one device, you can follow agent team tasks and automations from any of them (Dashboard → Across your devices) and approve or deny the next step from whichever device is in your hand. Every approval chat or an automation asks for is mirrored to your other devices; the first answer wins, decided once on the server, and requests expire. A new `approval.requested` webhook lets you forward requests to a phone push service.
- **Agent team tasks you can continue on another device.** Signed in, a Team run saves a checkpoint to your account after every step: the plan, each step's result and its status (running, paused, failed, completed or cancelled). One device works on a run at a time. Pause it on your laptop, or close the laptop, and resume it from your phone: the phone carries on from the last checkpoint and finished steps don't run again. The Agents screen shows which device is working on each run and can cancel it there; that device stops before its next step. Checkpoints made offline go out when the device reconnects, and a retried save is applied once. Runs are part of the account export, and you only ever see your own.
- **Memory you can see and steer.** Each memory now has a category (preferences, about you, people, work and projects, routines, other), a record of where it came from (added by you, "Remember this" in chat, saved by HANNAH or an automation after your approval, an insight, an import), when it was last used, and a sensitivity flag. Chat no longer sends your 12 newest memories with every message. It sends the ones that relate to what you're asking (ranked by matching words, rarer words counting more, in any language), plus a few preferences. Memories about health, money, beliefs or contact details are marked sensitive and go only to Ollama or to Auto in Private routing. Passwords, PINs, API keys, tokens, card and ID numbers are refused, wherever a save comes from. Saving something that says nearly the same as an existing memory updates it instead of adding a duplicate. The Memory screen adds search, category filters, editing, an export, a switch for each kind of memory, and an off switch for memory as a whole.
- **Backup and restore.** Settings → Backup and restore makes one file with your conversation, memories, reminders, automations, agent settings, skills, personalization, preferences, and which providers and models you chose. It never holds keys, your access token, sign-in or device identity, so moving to a new device means restoring the file and signing in again there. A passphrase encrypts the file (AES-256-GCM, PBKDF2); every file carries a checksum, so one that was changed is refused, and a file from a newer HANNAH is refused with a clear message instead of a half restore. Restore merges by default (adds what's missing, keeps the newer copy of anything both sides have) or replaces a section. The old one-way "Export my data" is replaced by this.
- **Diagnostics.** Settings → Diagnostics keeps what went wrong on this device: crashes, uncaught errors, a start that didn't finish, interface freezes, failed or slow server connections, agent, automation and sync failures (the last 300). Keys, tokens, URL query strings and file paths are removed before anything is recorded, repeats fold into one entry, and the list is searchable by words and level. "Export diagnostics" downloads a report with these entries, the app version, platform and memory use; never your conversation, memories, keys or account. The feedback form can attach that report, only when you tick the box; the server keeps only its allow-listed shape.
- **Automations that follow you across devices.** Signed in, your automations and their schedules sync to your account, so a routine due while the laptop is closed runs on the phone if HANNAH is open there, and a routine saved on one device appears on the others. Each scheduled slot runs once: when two devices are open at the same time, the first to claim it runs it and the other skips it. Every run is saved to your account step by step, so you can approve an action from any device (while the device that started the run is awake, your answer is sent there; once it has gone quiet, the run continues on the device you answer from), continue a run that was cut off when its device closed, or cancel a run from another device (it stops before its next step). Signed out, or offline, automations run on this device only, as before.
- **Agent team steps show when they're waiting for you.** While a step waits for your approval (including the desktop app's file and command dialogs), the run shows "Waiting for you", here and on your other signed-in devices, and its saved status is `waiting-approval`.
- **Calendar and email.** Connect Google (Calendar, Gmail) or Microsoft (Outlook) with the provider's own sign-in (OAuth with PKCE; tokens encrypted in your account). HANNAH lists events, searches and reads mail when you ask, and adds events, saves drafts or sends mail only after you approve exactly what will happen. Needs the operator's Google and Microsoft sign-in apps: see `docs/CALENDAR_AND_EMAIL.md`.
- **“Hey HANNAH” wake word.** Turn it on in Settings → Voice to start talking hands-free in the desktop app, on Android or in a desktop browser. Detection runs on the device (Vosk in WebAssembly, listening only for its name); the ~41 MB model downloads once from the website.

### Improved

- **Apps open like apps.** The desktop, Android and iOS apps show a HANNAH splash screen (Android 12+ system splash, iOS launch screen, desktop splash window, then the same splash while the app starts) and open on their own welcome-and-connect screen instead of the website's landing page. Once connected they open straight on chat, and they remember your key in the app's private storage until you disconnect, instead of asking again on every launch.
- **Search and sharing.** The home, Integrations and Marketplace pages are rendered to HTML at build time, so search engines and link previews get the real headings and text; Integrations and Marketplace are now indexed too. Every public page has its own title, description and canonical address on hannah.eliteforums.in, a PNG social card (SVG cards don't show on most social sites), schema.org data (app, organization, FAQ matching the visible FAQ, breadcrumbs), a sitemap, robots.txt and an `llms.txt` summary for AI search tools. Footer and menu links to Marketplace and Integrations are real links. Four new FAQ answers (what HANNAH is, which models it works with, hands-free use, its license). PNG app icons for iOS and Android home screens.
- **App tour on the website.** The screenshots section is now a tour of five real screens (Chat, Models, Automations, Agents, Integrations) in a browser frame with the screen's address and what it does.

### Fixed

- A Team run cancelled from another device was listed as still running under Across your devices.
- **The desktop, Android and iOS apps couldn't connect.** The server only accepted browser requests from the origins in `CLIENT_ORIGIN`, which in production listed just the website, so every request from the apps was blocked and entering a key failed. The apps' own origins are now always allowed.
- **The app could fall to its crash screen after connecting.** Leaving the landing page unmounted the 3D avatar while its loading overlay was still inside the scene, React failed to remove it, and the app showed "A moment of stillness". The avatar's loading and error overlays are now ordinary page elements.
- The on-device model library tried to reach its native plugin on every start, which failed (uncaught) on the web and desktop. It now loads only on Android and iOS when it's used.
- **Download buttons pointed at the old domain** (shanaya.eliteforums.in), as did every other request from the website, because the website build carried an old `VITE_API_BASE_URL`. On Vercel the website now always calls its own domain, download buttons are links on the same site, and the desktop and mobile apps use https://hannah.eliteforums.in unless a build sets another server. The server also accepts the desktop app's origin by default.
- The desktop app's launch check in CI gave up after 60 seconds, but CI's macOS machines take about two minutes to start an unsigned app. It now waits up to four minutes there (the app itself starts in seconds).
- Links that open a new window in the desktop app now open in the system browser.
- **Automations' "Ask HANNAH" steps failed for most people.** They called the server without the provider, model and API key chosen in chat, so they only worked when the server had its own key. They now use the same AI as chat (cloud provider and model, your key, or Ollama), with no tools. On-device chat models show a clear message instead, because they only run while you chat.
- Saved automations could disappear: the task list kept only the newest 100 entries, and HANNAH's background memory tasks pushed older automations out. Automations are now always kept.
- An automation's "Show a notification" result was invisible unless browser notifications were allowed. Results and approval requests now also appear as a card in the app, with a link to Automations.
- A new scheduled automation was saved switched off, so it never ran until you found "Run on schedule". It now starts on its schedule when you first save it.
- Saving now refuses steps that aren't connected to the trigger, and says which ones; they'd never run. Runs cut off by a reload no longer stay "Running" forever, and with HANNAH open in two tabs a scheduled automation runs once, not twice.
- **Automations editor rebuilt.** The drag-and-connect canvas made it easy to build automations that silently didn't work: a new step landed unconnected (and unconnected steps never run), and connecting steps by dragging small handles was close to impossible on a phone. Automations are now edited as a list: when it runs (with day buttons for any days of the week), then the steps in order, with add, move up, move down and remove. Saving says exactly what's missing. Your automations, approvals and run history come first on the page, there are four ready-made templates, deleting asks first, and leaving with unsaved changes asks too. Older automations open with their steps in run order, and the editor says if any were never connected. The page no longer repeats results in a floating card while you're on it, and the canvas library is gone from the app.
- **Desktop apps crashed on launch in 1.3.0** (macOS, Windows and Linux). The main process imported the auto-updater in a way that is undefined at runtime. Fixed, and CI now starts each packaged desktop app and fails the build if it doesn't load.
- Settings (and the sign-in check on the landing page) could crash when the server answered the account check with something other than HANNAH's JSON, for example a web page.
- The website said the downloadable desktop app can use your screen, mouse and keyboard (computer use). That still needs a desktop app you build yourself, so it's now listed on the roadmap instead.
- Download buttons showed the app's "Page not found" screen for visitors who had opened the site before: the offline service worker answered `/download/…` with the cached app page instead of letting the request reach the server. Server paths (`/download`, `/api`, `/v1`, `/mcp`, `/.well-known`) now always go to the network.
- Download buttons on the website led to a GitHub 404 whenever the newest published release didn't have a file with that exact name. They now go to `/download/<platform>` on HANNAH's own site, which starts the download from the newest release that has the package (including older file names) and shows a clear "not available yet" page instead of a 404.

## 1.3.0 — 2026-11-16

The first published release since 1.0.2. The tags `v1.0.3`, `v1.1.0` and `v1.2.0` were created but never published: their release step stopped because signing credentials weren't configured. This release includes all of that work.

### New

- **Your personal AI, any model.** 20 providers on one gateway (Groq, OpenAI, Anthropic, Gemini, OpenRouter, Together, Cerebras, DeepSeek, Mistral, xAI, Fireworks, NVIDIA NIM and more), plus self-hosted Ollama, LM Studio, llama.cpp and vLLM, with live model discovery, streaming and normalized errors.
- **Smart routing.** The Auto model picks a provider and model per message in Balanced, Best quality, Budget, Fastest, Private or Custom mode. A preview shows the choice, the reason and alternatives before you send, and requests fall back to the next allowed provider if one fails. Private mode is enforced on the server.
- **Agent team.** Team mode plans a task, runs Research, Coding, Memory and Tasks specialists in parallel, verifies the result, and can resume after a restart. The Agents screen shows every run.
- **Accounts on your own database.** Sign in with email and password on a server connected to Postgres (Supabase, Neon and others) or SQLite. Provider keys are stored encrypted, data syncs across devices, and you can export or delete everything.
- **Voice.** Device or OpenAI voices, device or Whisper speech recognition, and interrupting HANNAH by talking.
- **Expressive avatar.** The 3D model smiles, blinks, follows your pointer, gestures with each emotion, and moves its mouth while talking.
- **WebLLM that actually loads.** In-browser AI now shows real download progress, explains failures, offers a retry, and keeps the model loaded between screens.
- **Developer platform.** OpenAI-compatible `/v1` API with routing modes, per-account developer keys, MCP server and client, A2A messaging, signed webhooks and a JavaScript SDK.
- **Models screen.** Recommendations for your task, budget and hardware. "Use in chat" now opens the chat with that model, including local Ollama models.
- **Reminders** by chat or Dashboard, with system notifications in the Android and iOS apps.
- **Skills marketplace** with integrity checks and publisher signatures.

### Improved

- **Real page addresses.** Screens live at `/chat`, `/models`, `/agents`, `/memory`, `/settings` and so on, instead of `#/models`. Refresh, direct links, and the browser and Android back buttons work, old `#/…` links redirect, and unknown addresses show a "Page not found" screen.
- **Platform conventions.** Phones get a bottom tab bar. Android draws edge-to-edge with readable status-bar icons and resizes for the keyboard. The desktop app has a full menu bar (Edit, View, Go with ⌘/Ctrl+1…6, Settings ⌘/Ctrl+, and Check for Updates), a minimum window size, and an About panel. Windows reminders now show as system notifications.
- **Windows installer.** Windows now ships an installer with a Start-menu entry and an uninstaller, replacing the portable executable. That's also what makes desktop auto-update possible.
- **Integrations guide.** The Integrations page now documents every way in (REST API, OpenAI-compatible `/v1`, MCP server and client, A2A, webhooks, your own database) with the credential each one needs, copyable examples, config file locations for Claude Desktop, Cursor and VS Code, server settings, rate limits, error codes and troubleshooting.
- **New landing page** that describes what HANNAH does today, separates the roadmap from shipped features, and lists downloads with install notes.
- **One version everywhere.** The web app, desktop, Android and iOS builds all identify as 1.3.0, and CI fails if any of them disagree or if a tag doesn't match.

### Fixed

- **Desktop:** the avatar didn't render and the interface fonts didn't load, because the desktop app's security policy blocked WebAssembly, `blob:` workers and Google Fonts. The policy now allows exactly those. This also lets WebLLM run on desktop.
- **macOS:** voice input couldn't get microphone access, because the app lacked the microphone entitlement and usage description.
- Desktop auto-update and several website links pointed at a repository that doesn't exist.
- iOS permission prompts and the home-screen name still said "Shanaya".
- The iOS web-app status bar used white text on HANNAH's light background.
- Cost estimates now appear only for prices with a verification date (none yet), instead of from unverified list prices.
- The chat layout scrolled sideways on narrow phones.
- On the Integrations page, the remote MCP configuration was nearly invisible (white text on a white card), and the local MCP example left out the `HANNAH_API_TOKEN` it needs to chat.
- The WebLLM engine was bundled twice (about 2 MB extra gzipped), which put the app over its size budget and failed the web and desktop builds. It now loads only in its worker.
- The release workflow no longer requires signing secrets that aren't configured. It publishes what it can build and labels each package's signing status.

### Known limitations

- macOS builds are not notarized and Windows builds are not code-signed yet. The release notes explain how to open them.
- The Android APK is a debug-signed test build (no Play Store listing). The iOS app isn't distributed; it needs an Apple Developer signing identity.
- Not built yet: wake word, calendar and email connectors, running saved automations, desktop file and terminal tools.

## 1.0.2 — 2026-11-11

- Native app projects for Android and iOS, and release publishing fixes.

## 1.0.1 — 2026-11-11

- MCP integration with server endpoints and tools.
