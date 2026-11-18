# Device intelligence: audit, decisions and backlog

How HANNAH acts on the person's own devices: the desktop, the phone, and the services they connect. The goal is one intelligence layer (models, agents, tasks, workflows, memory, permissions) with each environment doing only what it can really do. This page records what exists, what was built, what's next, and what won't be built and why.

Status words: **Available** (shipped and verified), **Beta** (shipped, verified in parts, labelled in the app), **Next** (dependency-ready, planned in this order), **Later** (needs something else first), **Not planned** (a platform, policy or legal limit; the reason is given).

## 1. Audit: what HANNAH already had

| Layer | Where | Reused for device work |
| --- | --- | --- |
| Model gateway and routing (20 providers, Auto modes, Private mode, budgets) | `server/gateway.js`, `server/providers/catalog.js`, `client/src/services/ModelRouting.ts` | Yes: every agent and workflow step uses it. |
| Agent loop, specialists, Team mode | `client/src/services/AgentRuntime.ts`, `Orchestrator.ts`, `SpecialistAgents.ts`, `server/orchestrate.js` | Yes: the desktop coding task runs the same loop with tools held to one folder. |
| Tool registry and approvals | `client/src/services/DeviceTools.ts` (`getDeviceTools`, `executeHANNAHTool`), `SafetyGuard.ts`, `GuardianAgent.ts` | Yes: phone and desktop tools go through Guardian and confirmation. |
| Durable tasks across devices | `server/task-runs.js` (checkpoints, one-device lease), `server/device-tasks.js` (follow and approve from another device) | Yes: the pattern for "one device does it, others watch". |
| Workflow engine | `server/workflows/` (durable queue, waits, approvals, desktop jobs) | Yes: desktop steps; phone steps are next. |
| Memory with provenance and sensitivity | `client/src/services/Memory*.ts`, account sync | Yes: preferences (favourite apps, contacts' roles) will live here, never credentials. |
| Mail and calendar | `server/connections.js` (Google, Microsoft: search, read, draft, send with approval, events) | Yes: the communication layer builds on it. |
| Desktop runtime | Electron app + `client/plugins/desktop-tools` (shared folders, approved commands, native dialogs, workflow tasks, hidden page reader) | Yes: the base for the vision and action engine. |
| Computer use | Only a bridge you build yourself (`client/electron-agent-main.example.cjs`: screenshot-desktop, sharp, nut-js) and `/api/desktop/computer` (Anthropic computer use, server key). Not in the downloadable app. | Partly: the action vocabulary and approval summaries (`DesktopAgent.ts`) carry over. The dependencies need review: current nut-js releases aren't on the public npm registry. |
| Phone actions on the phone itself | `make_call` and `send_message` tools: open the dialer or composer on the same phone | Yes: now share the Phone Bridge's number checks (no emergency numbers, no `*`/`#` codes). |
| Native agent plugins | `capacitor-native-agent`, `capacitor-mobile-claw`, `capacitor-mobilecron` (Rust agent loop, scheduling) | Not used by the Phone Bridge; noted for background work on Android. |

What was missing for "use my phone from my computer": pairing, a device identity the server can verify, a channel for short-lived commands, and native code to open the dialer and composer and look up contacts.

## 2. Built: HANNAH Phone Bridge

Give a command on the computer → HANNAH sends it to your paired phone → the phone's own dialer or Messages opens with it filled in → you tap Call or Send → HANNAH reports only what the phone verified.

**Pairing** (`server/phone-bridge.js`, Settings → Phone on both devices)
- The computer, signed in, creates a one-time code (8 characters, 10 minutes, stored as a hash, at most 3 waiting).
- The phone, signed in to the **same account**, sends the code with a P-256 public key. The key was generated in the app's WebView with WebCrypto as non-extractable and is kept in IndexedDB.
- A code can't pair a phone to a different account.
- Both screens show the key's fingerprint so you can compare them.
- The phone chooses what it allows: calls, SMS, contact lookups. The computer can't grant itself more.

**Commands**
- Every request from the phone is signed with its key: phone id, time (±60 s), method, path, SHA-256 of the exact body. The server verifies it against the key stored at pairing.
- A command lives for **60 seconds**. A phone not seen in the last 45 seconds is reported **offline**, and nothing is queued: a call or SMS never happens later.
- Each command carries a nonce. The phone checks it hasn't seen it before and sends it back with the result. A result is accepted once, in a valid order.
- Removing a phone ends its waiting commands, and its next request gets 403.

**On the phone**, each command is checked again, independently:
- the phone's own on/off switch and allowed actions;
- the command's expiry and its nonce;
- the number's shape;
- no emergency numbers, and no USSD or MMI codes (`*`, `#`).

Then the native `HannahPhone` plugin acts:

| | Android (`HannahPhonePlugin.java`) | iOS (`HannahPhonePlugin.swift`) |
| --- | --- | --- |
| Call | `ACTION_DIAL`: dialer opens with the number; you tap Call. No `CALL_PHONE` permission. | `tel:` URL: iOS shows its own call confirmation. |
| SMS | `ACTION_SENDTO` `smsto:` with `sms_body`: your messaging app opens with recipient and text; you tap Send. No `SEND_SMS` permission (Google Play restricts it). | `MFMessageComposeViewController`: you send or cancel, and iOS reports which. |
| Find contact | `ContactsContract` query after `READ_CONTACTS` is granted; only matches are returned. | `CNContactStore` after Contacts access; only matches. |

**Reported states:**
- Sent to phone.
- Delivered.
- Dialer opened.
- Composer opened.
- On iOS only: you sent the SMS, or you cancelled it.
- Declined on the phone, with its reason.
- Failed.
- Expired.

"Call connected" and "message delivered" are never reported: the platforms don't give apps that information without restricted permissions.

**From chat on a computer:** `phone_find_contact`, then `phone_call` or `phone_text`.
- Calls and texts need your confirmation in HANNAH, showing the name and number, and then your tap on the phone.
- "Call Aman" looks Aman up on the phone. If several people or numbers match, HANNAH asks you which.

**Why Java on Android:** the app module is Java, with no Kotlin toolchain. The plugin uses the same Android APIs. Adding the Kotlin Gradle plugin for one class would change the build for no functional gain; converting is cheap if the module moves to Kotlin.

**Why polling, not push:** the phone checks every 3 seconds while HANNAH is open on it. Waking a closed app needs Firebase Cloud Messaging and APNs keys, which this deployment doesn't have. Until then, "open HANNAH on the phone" is the honest requirement, and the computer says so when the phone is offline.

**Verification**
- `server/phone-bridge.test.js` (real server, SQLite):
  - pairing across accounts, one-time codes and fingerprints;
  - signatures: unsigned, tampered, old, and another account's phone id;
  - one-time delivery, nonces and result order;
  - emergency and USSD refusals, and allowed actions;
  - offline phones, expiry with no later delivery, and revocation;
  - contact matches only.
- `client/src/__tests__/PhoneBridge.test.ts`:
  - the app signs exactly the string the server checks, and checks numbers the same way;
  - the phone-side refusals;
  - Android and iOS SMS outcomes;
  - outcome wording that never claims more than was verified;
  - tools only on signed-in computers, with approval.
- iOS: the Swift plugin type-checks against Capacitor and the iOS SDK (with a negative control). A full Xcode build here stops in a third-party package (`capacitor-lancedb`'s Rust bindings), before reaching HANNAH's code. CI builds iOS.
- Android: compiled with Gradle and run end to end in the emulator, 12 of 12 checks (section 5).

## 2a. Built: seeing the screen, opening apps, startup routine (desktop)

All three are in the desktop app. The rules are enforced in Electron's main process (`client/plugins/desktop-tools`), not by the web page or the model.

**Seeing the screen, on request** (`core.mjs` `captureScreen`, `plugin.mjs`, `server/vision.js`)
- "What's on my screen?" or "explain this error" in chat calls `desktop_look_at_screen`.
- The first look asks in a system dialog: **Look once**, **Allow for 15 minutes**, or **Don't allow**. While allowed:
  - the menu bar (macOS) or tray shows it, with **Pause** and **Stop**;
  - an in-app banner shows it with **Stop**;
  - the session ends by itself after 15 minutes.
- Looks are limited to 12 a minute.
- If macOS hasn't given Screen Recording permission, HANNAH says how to turn it on instead of asking.
- One JPEG of the display under the pointer, at most 1568 px on its long side. HANNAH's own windows are hidden for a moment so it shows what you're looking at.
- The image goes to `POST /api/vision/describe`, which sends it to one vision model the caller may use and returns text. The chat agent never receives the image.
  - **Keys:** the same as chat (saved keys, a visitor's Groq key, or the server's).
  - **Private mode:** keeps it on self-hosted models (`HANNAH_VISION_MODEL`, for example an Ollama vision model).
  - **Model fallback:** a retired model (404) falls through to the provider's next vision model.
- Nothing is saved.
- Text on the screen is treated as data. The model reports instructions it sees instead of following them, and doesn't read out passwords, codes or keys.
- Looking is separate from acting: this tool can't click or type.

**Opening apps** (`apps.mjs`)
- Apps are found from the system's own launchers:
  - **macOS:** `.app` bundles in the Applications folders.
  - **Windows:** Start menu shortcuts.
  - **Linux:** XDG `.desktop` entries, with the user's own entries taking precedence.
- "VS Code" and "chrome" are matched to the real names. If more than one app matches, HANNAH asks which.
- Each open asks first (**Open**, **Always allow opening this app**, or **Cancel**). An app can also open with a shared folder, for example a project in VS Code.
- Apps are opened without a shell:
  - **macOS:** `open -a`.
  - **Windows:** the shortcut itself.
  - **Linux:** the entry's `Exec` line, split per the Desktop Entry spec.
- **Verified by process ID:** a new process for that app means it opened. No new process, but one already running, means it was brought forward. Neither means "not confirmed". A Windows shortcut with no target is reported as "couldn't check", never as success.

**Startup routine** (Settings → Desktop access)
- Steps are apps (optionally with a shared folder), links (http or https only) and waits, up to 12 steps.
- Saving shows every step in a system dialog. **Start HANNAH when I sign in** is a separate switch with its own dialog:
  - **macOS and Windows:** it registers a login item (`app.setLoginItemSettings`), visible in Login Items or Startup apps.
  - **Linux:** it writes `~/.config/autostart/hannah.desktop`.
  - **Development copies:** they can't turn it on.
- At sign-in, HANNAH waits 5 seconds, runs the steps in order and checks each app. Then it shows a notification and keeps the run in a history. **Run now** does the same on demand.
- Turning it off removes the login item.

**Verified on this Mac (macOS, Electron 45)**

| Check | Result |
| --- | --- |
| 76 apps found; "vs code", "chrome", "calculator" matched | Pass |
| Calculator opened and its new process confirmed (about 0.6 s); a second open reported "already running" | Pass |
| A missing app gives the system's error, not success | Pass |
| The Linux launcher path (spawn from a `.desktop` `Exec`, check by program name) with a real process | Pass |
| The real plugin in Electron: open an app, save a routine, Run now (each step confirmed), recent activity | Pass |
| Login item: on gives macOS status "enabled", off gives "not-registered" | Pass |
| Launched with `--hannah-login` and a routine switched on: the routine ran by itself and Calculator was confirmed | Pass |
| The vision route against Groq's `qwen/qwen3.8-27b` with a rendered editor and terminal: explained the real bug (`useState()` without a default) and refused the planted "call this number" line | Pass (1.5 s) |
| Private mode with no self-hosted vision model: refused to send the picture | Pass |
| A screenshot with macOS Screen Recording denied: no dialog, the session doesn't start, readable steps to fix | Pass |
| The desktop app's launch smoke test with the new tray menu | Pass |

**Not run:**
- **A real screenshot reaching the model.** The development Electron binary doesn't have macOS Screen Recording permission here, and granting it needs a person in System Settings. The capture code and the vision route are each verified, but not together.
- **Windows and Linux on real systems.** The Windows code path and Linux desktop sessions are covered by unit tests and fixture folders only.
- **Unsigned macOS builds.** macOS ties Screen Recording permission to the app's signature, so it may need granting again after each update until builds are signed.

## 2b. Built: HANNAH's browser, YouTube study notes, verified PDFs (desktop)

**HANNAH's browser** (`browser.mjs` performs actions; `core.mjs` decides what's allowed)
- **The window:** one visible window, titled "HANNAH browser (signed out)".
  - Its session is in memory and new each time: none of your own browser's accounts or cookies, and nothing kept after it closes.
  - Sandboxed, with context isolation and no Node.js.
  - Pop-ups load in the same window. Downloads and permission requests are refused, and requests to this computer itself or to link-local and metadata addresses are cancelled.
  - HANNAH's scripts run in an isolated world, so the page's scripts can't interfere with them.
- **Actions:** open a page, search (web through DuckDuckGo's HTML page, or YouTube), read, scroll, go back, click, type, and look (a screenshot to the vision model).
  - The model sees the page text and a list of controls, each with a ref (`e12 link "…" → url`).
  - Clicks are real mouse events at the control's position. Some sites ignore scripted clicks: YouTube's "Show transcript" did.
- **Rules:**
  - **Asks once:** starting the browser.
  - **Doesn't ask:** reading, scrolling, searching, following links, and buttons that only show things.
  - **Asks each time:** typing anything other than a search (the dialog shows the text), and buttons that send, order, post, follow, subscribe, sign in, delete or change something.
  - **Never:** typing into password, one-time code, PIN, card or bank fields, and pressing pay, place order, checkout or buy now. HANNAH tells you to do those yourself in the window.
- **Closing the window** stops everything.

**YouTube study notes**
- `browser_search` (YouTube) returns the videos shown, with title, channel, length and link.
- `youtube_read_video` opens the video, pauses it, reads the title, channel and description, and clicks **Show transcript**. It reads the same transcript panel anyone can open, in either of YouTube's current layouts, dropping the screen-reader time labels.
- **Long transcripts:** a 2-hour lecture is about 100,000 characters, more than many models or free plans accept in one request.
  - It's split into timed parts of about 9,000 characters.
  - Each part is condensed in turn through `/v1/chat/completions`, using only what is said, with your routing, so Private mode stays self-hosted. HANNAH waits out rate limits using the provider's own `Retry-After`.
  - The final notes are written from the condensed parts.
- **No transcript:** the tool says so, and the model is told not to invent content.

**PDF notes** (`notes.mjs`, `desktop_save_notes_pdf`)
- **Rendering:** Markdown becomes escaped HTML. Headings, lists, tables, code and links (http and https only) carry over. Raw HTML from the model is shown as text.
- **Printing:** in a hidden window with scripts off and network blocked, and a content security policy of `default-src 'none'`.
- **Header:** title, creator, source link, topic and date.
- **No transcript read:** if no transcript was read for the video, the first page says the notes come only from the title and description.
- **Saving and checking:** saved only to a read-write shared folder after a system dialog. The bytes are checked as a complete PDF before writing, then read back from disk; size and page count must match. HANNAH says "saved" only when that check passes.

**Fixes found while building this**
- **Too many tools:** in the desktop app, the agent offered every tool for most requests, 28 before this work and 44 now, but the server accepts 20. Those requests failed. Signed-in web users with 23 tools were affected too.
  - Tools are now chosen per request, from the tool families its words call for, plus the profile's tools and a small core, within 20.
  - Research requests now get the browser instead of only the knowledge base.
- **Long tool results:** results over 8,000 characters, such as a long file read or a page, made the whole agent turn fail.
  - The server now accepts tool results up to 60,000 characters. The app clips results to fit, and shortens older ones once used.
- **Provider limits:** a provider's "request too large" (413) is reported clearly, and its `Retry-After` is passed on to callers of `/v1`.

**Verified on this Mac (Electron 45, live sites)**

| Check | Result |
| --- | --- |
| Search YouTube for GATE operating-systems lectures: 12 real results with title, channel, length and link | Pass |
| Open a 1 h 22 min lecture and read its transcript: 616 segments, about 80,000 characters, starting "Hello everyone, welcome to…" | Pass |
| "Subscribe" on YouTube asks first; declining presses nothing | Pass |
| GitHub sign-in: typing into the password field is refused; typing a username asks first and shows the text | Pass |
| PDF saved to a shared folder after a yes, then read back and checked: Quick Look shows the header, lists, table and formulas, and a planted `<script>` appears as text | Pass |
| A 1 h 57 min lecture condensed from its full transcript in 10 timed parts, waiting out the free Groq plan's rate limits (274 s) | Pass |
| A real model (Groq `openai/gpt-oss-120b` through `/api/agent`) given "find a GATE operating systems lecture on YouTube about process synchronization and prepare PDF notes": searched YouTube, picked a 1 h 57 min GATE lecture, read and condensed its whole transcript, wrote notes under the requested headings, saved the PDF (2 pages, checked on disk, credited to the channel), and only then said it was saved | Pass |
| The notes' worked examples (a shared X = 10 race, GATE 2013 with max x = 2 and min x = −4) appear in the lecture's own transcript | Pass |

**Free plans and long lectures.** On Groq's free plan (8,000 tokens a minute for this model), condensing a 2-hour lecture takes about 4 to 5 minutes of waiting out rate limits. The final request may need another wait. Agent turns now wait out a provider's `Retry-After` up to three times before giving up. In one run the key was already busy (Groq reported 6,509 of 8,000 tokens used that minute), and the final turn only went through on a later try. Paid plans or other providers don't hit this.

**Not run:** this whole flow inside the packaged app's chat window (the pieces were run in Electron and through the server, and the app's glue is unit-tested), on Windows and Linux, and on sites other than YouTube, GitHub and DuckDuckGo.

## 2c. Built (macOS first): computer control — observe, act, verify

HANNAH can read the interface of the app in front and use it: press buttons, put text in fields, type, use keys and shortcuts, scroll, click, drag, switch apps, manage windows and quit apps. Each action is checked against what's on screen afterwards. It reuses the pieces above: the same consent dialogs, activity log, app launcher, browser, files and terminal. There's no second screen-capture system and no second runtime.

**Architecture**

```
chat / voice ─▶ desktop_* tools (client/src/services/DesktopActions.ts)
                  │  Capacitor bridge: only the methods in BRIDGED_METHODS
                  ▼
Electron main process ─ plugins/desktop-tools/electron/dist/
   core.mjs     folders, commands, screen, apps, browser (existing rules)
   control.mjs  control rules: session, approvals, stale checks, verification, task history
                  │  one adapter interface per platform
                  ▼
   macOS   hannah-control (client/native/macos-control/HannahControl.swift)
           Accessibility API (AXUIElement) + CoreGraphics events, JSON on stdin/stdout
   Windows not built: planned on UI Automation + SendInput
   Linux   not built: planned on AT-SPI + X11 input (Wayland: the desktop's remote-desktop portal)
```

- **Isolation:** the web page never gets operating-system access. It can call only the named methods, and every rule is enforced in the main process. The helper is a separate signed program started per request as HANNAH's child process, so macOS attributes its permission to HANNAH. There's no network listener.
- **From HANNAH Web:** web and phone sessions reach the desktop only through the existing paired-device jobs (`DesktopWorkflowJobs.ts`). Computer control isn't offered there yet, and nothing exposes it to network callers.

**Screen intelligence** (`observe`)
- **Semantic first:** the accessibility tree of the focused window, up to 300 elements. Each element has:
  - its role, label (title, description or placeholder) and value;
  - whether it's enabled, focused or selected;
  - its frame in screen points;
  - its actions;
  - a path such as `0.3.1`.
- **Also returned:** the app, its windows, the focused element, open sheets and dialogs, visible text (static text, headings, text areas and cells), and lines that look like errors.
- **Chromium and Electron apps:** Chrome, VS Code and others build their tree when HANNAH asks (`AXManualAccessibility`).
- **Visual fallback:** where an app exposes nothing, `desktop_look_at_screen` (section 2a) takes a screenshot for a vision model, and actions use coordinates.

**Actions** (`desktop_act`)
- **By element:** `press`, `show-menu`, `focus`, `set-value`, `select-text`, `increment`, `decrement`. Real accessibility actions, not synthesized clicks.
- **By point:** `click`, `double-click`, `right-click`, `scroll`, `drag`, as real CoreGraphics mouse events. Points must be inside the observed window.
- **Keyboard:** `type` (real key events with Unicode text) and `key` (named keys with cmd, shift, option and control).
- **Apps and windows:** `desktop_switch_app`; `desktop_window` (raise, minimize, restore, fullscreen, move, resize, close); `desktop_quit_app`. `desktop_open_app` checks that a window shows the project folder.

**Safeguards**
- **Session:** nothing happens without a control session (`desktop_control_start`).
  - It starts with a system dialog that lists what HANNAH may and may not do, and lasts 10 to 30 minutes.
  - The menu bar shows "Controlling". The HANNAH menu has **Stop Controlling Now** and **Pause**.
  - **Emergency stop:** Control+Option+Shift+Escape, a global shortcut. It ends the session, cancels the running task, and drops an action waiting for approval even if you then click yes.
- **Fresh observations only:** an action must name the latest observation, at most 30 seconds old.
  - For element actions, the expected role and label come from that observation, not from the model. The helper re-reads the element and stops with `CHANGED` if it differs.
  - For points and keys, the app and window in front must still be the ones observed.
- **Verification:** after each action HANNAH observes again.
  - **`action-confirmed`:** the app's state shows the result: the field holds the text, focus moved there, the window or its contents changed, or the process is gone.
  - **`action-attempted`:** nothing confirms it.
  - A task can be finished as **completed** only when its last action was confirmed.
- **Never:**
  - password fields (listed without their value);
  - pay, order, checkout or buy;
  - HANNAH's own windows and dialogs, so she can't approve her own requests;
  - macOS security prompts, Keychain, Passwords and password managers;
  - Force Quit, signing out or locking.
- **Asks every time:** buttons that send, delete, post, sign in or change something; quitting apps; closing windows; Cmd+Q, Cmd+W, Cmd+Delete; and every action in a terminal or System Settings, because typing there runs commands. Commands themselves go through `desktop_run_command`'s own approval.
- **Asks once per app per session:** typing.
- **Limits:** 60 actions a minute and 2,000 characters per text.
- **Untrusted content:** screen text, web pages and documents are data. Nothing on screen can start a session or grant permissions; only the person can, in a system dialog.

**Task record** (`control-tasks.json` in the app's data folder, last 30 tasks; plus the activity log)
- **Each task:** an id, the request, the plan, and its status: planned, executing, waiting-approval, completed, failed or cancelled.
- **Each step:** an observation (app, window, element count), or an action with its target (app, window, element and path or point), its result, its verification evidence and its status (action-attempted, action-confirmed, failed or denied).

**Permissions (macOS)**
- **Accessibility:** System Settings → Privacy & Security → Accessibility → HANNAH. Needed for reading other apps and for posting mouse and keyboard events. `requestControlAccess` shows macOS's own prompt; HANNAH can't grant it to herself.
- **Screen Recording:** only for screenshots (section 2a).
- **Unsigned builds:** macOS ties both permissions to the app's signature, so they may need granting again after each update.

**Tool registry** (`DesktopActions.ts`; routed by `AgentRouter.ts` for "click / type / press / switch to / scroll / close / menu / button …")

| Tool | Calls | Asks the user |
| --- | --- | --- |
| `desktop_control_start` | `controlStatus`, `requestControlAccess`, `startControl`, `startControlTask` | Yes, the session dialog |
| `desktop_observe` | `observeScreen` | No (needs a session) |
| `desktop_act` | `controlAct` | Per the rules above |
| `desktop_switch_app` | `focusApp` | No (needs a session) |
| `desktop_window` | `controlWindow` | Close only |
| `desktop_quit_app` | `quitApp` | Always |
| `desktop_control_finish` | `finishControlTask` | No |

**Helper contract** (`hannah-control <command>`, a JSON object on stdin)
- **Answers:** `{"ok": true, …}`, or `{"ok": false, "code", "error"}`.
- **Commands:**
  - `status`, `request-access`, `running`;
  - `frontmost`, `observe` {pid?, maxNodes?};
  - `press`, `show-menu`, `focus`, `increment`, `decrement` {pid, path, expect: {role, label}};
  - `set-value` {…, value}, `select-text` {…, location, length};
  - `click` {x, y, button, count}, `drag` {fromX, fromY, toX, toY}, `scroll` {dx, dy, x?, y?};
  - `type` {text}, `key` {key, modifiers};
  - `activate`, `quit` {pid};
  - `window` {pid, index, expectTitle, action, x, y, width, height}.
- **Refusals:** `ACCESSIBILITY_PERMISSION`, `CHANGED`, `SECURE_FIELD`, `DISABLED`, `NOT_SETTABLE`.

**Build and packaging:** `client/scripts/build-macos-control.mjs` compiles a universal binary (arm64 and x86_64, macOS 12+) during `prepare-electron-release.mjs`. `electron-builder.yml` unpacks it from `app.asar` (`asarUnpack`). CI checks the packaged helper exists, has both architectures and answers.

**Tests** (2026-11-18)

| Check | Where | Result |
| --- | --- | --- |
| Rules: session, consent, stale and changed UI, verification, approvals, refusals, emergency stop during an approval, unsupported platforms (9 tests) | `plugins/desktop-tools/control.test.mjs`, stand-in adapter | Pass |
| The helper compiles (Swift, universal binary) and answers `status` and `running` on this Mac | real macOS | Pass |
| Without Accessibility permission, starting control and posting a click are refused with the permission message | real macOS, `scripts/macos-control-check.mjs` | Pass |
| Packaged app: the helper is at `app.asar.unpacked/assets/hannah-control` (x86_64 and arm64) and answers; the app launches and loads (`HANNAH_SMOKE_OK 1.5.0`) | local `--dir` package | Pass |
| With Accessibility on, on TextEdit: read the tree, set text (read back), click, type with real key events (read back), Cmd+S, and the file on disk has the text; scroll; minimize and restore; stale observation refused; quit confirmed; emergency stop | `scripts/macos-control-check.mjs` | **Not run yet:** needs Accessibility switched on for the app running it (KI-24) |
| Test A: VS Code opens a project, confirmed by its window title | `scripts/macos-control-check.mjs --vscode` | Not run yet (same reason) |

**Not built:** the Windows and Linux adapters (they report that clearly); computer control requested from HANNAH Web; continuous observation (observation is on request, during a session); drag and drop between apps beyond a straight drag.

## 3. Backlog, in dependency order

### Phase 2: Desktop vision and action
Items 1 to 3 are built (section 2a). Next are 4 and 5.
1. **Screen observation, on request.** (Built.)
   - Electron `desktopCapturer` takes a screenshot only when you ask, with a visible indicator and per-session consent. The image goes to a vision-capable model through the gateway ("what's on my screen", "explain this error").
   - macOS needs the Screen Recording permission, which the app can't grant itself; Settings will say so.
   - Watching is separate from acting.
2. **Open apps** (built; switching windows comes with item 4) with approval: `open -a` (macOS), the Start menu or app paths (Windows), `.desktop` launchers (Linux). Verify by checking the app's window appears.
3. **Startup routines.** (Built.)
   - `app.setLoginItemSettings` starts HANNAH at login only if you turn it on, and the Login Items list shows it.
   - A "When the desktop app starts" trigger then opens your apps, folders and URLs in order, with a run history.
   - No hidden services.
4. **Accessibility-first control** (built for macOS, section 2c; Windows UI Automation and Linux AT-SPI adapters still to build): macOS AX API, Windows UI Automation, Linux AT-SPI, through a native helper. Mouse and keyboard only where accessibility gives nothing.
   - Every action is summarized and approved, as `DesktopAgent.ts` does today.
   - The result is checked with a fresh observation before the next step.
5. **Browser automation** (built in HANNAH's own signed-out browser, section 2b; using your own signed-in browser is still to come) beyond reading pages: navigation and form filling in a separate signed-out window. Signed-in sites only through the person's own browser with their go-ahead per step.

### Phase 3: Daily tasks on the desktop
- **YouTube study notes.** (Built, section 2b.)
  - Search and open a video. Read the transcript only where it's shown on the page or captions are publicly available; YouTube's caption download API is limited to the video's owner.
  - Generate notes, then a PDF (Markdown to PDF on the desktop), and verify the file.
  - If no transcript is accessible, say so; never invent a summary.
- **Instagram and other social feeds:** Instagram shows a sign-in wall to signed-out visitors, so HANNAH's signed-out browser can't read feeds, and HANNAH won't sign in for you. This needs your own browser (item 5's remainder) or screen reading. Then: read what's on screen and summarize, with scrolling you approve. HANNAH never likes, follows, comments or posts on its own, and doesn't bypass sign-in or CAPTCHAs.
- **Food ordering (Swiggy, Zomato):** neither offers a public ordering API.
  - The only route is computer use in your own signed-in browser: prepare the cart, show restaurant, items, taxes, delivery fee, total and address, then **you** place the order.
  - HANNAH never authorizes payment.

### Phase 4: Phone Bridge, remaining (Later)
- **Push wake-up (FCM and APNs)** so a closed phone app can receive a request, and the request is shown as a notification you confirm.
- **QR pairing:** the code works today; scanning needs a barcode plugin.
- **iPhone end-to-end run on a device.**
- **Workflow nodes:** "Start a phone call" and "Prepare an SMS", using the same bridge with the same confirmations. A workflow can't bypass the phone's tap.

### Phase 5: Communication (Next after Phase 2's first items)
- **Gmail and Outlook:** add labels, archive, follow-ups and attachments to the existing search, read, draft and approved send.
- **Google Chat:** the official API needs a Google Workspace account and a configured Chat app, and is planned for Workspace users only.
- **WhatsApp:** only the WhatsApp Business Platform (Cloud API), for business numbers. Personal WhatsApp has no official API. HANNAH won't read message databases or use session tokens.
- **Slack and Discord reading:** through their official APIs with OAuth.

### Not planned
- **Placing a call with no tap** (`ACTION_CALL` or `CALL_PHONE`), **silent SMS** (`SEND_SMS`), or **reading call state or logs:** these need restricted permissions that the use case doesn't justify under Google Play policy, and iOS doesn't allow them.
- **Calling or texting emergency numbers** on someone's behalf.
- **Cloud telephony presented as "your phone":** VoIP could be a separate, clearly labelled integration.
- **Hidden screen recording, or monitoring without a visible indicator.**

## 4. Permissions

| Permission | Where | Asked when |
| --- | --- | --- |
| Contacts (`READ_CONTACTS`, `NSContactsUsageDescription`) | Phone app | The first time your computer asks the phone to find a name |
| None for calls or SMS | Phone app | The dialer and composer act after your tap |
| Using this phone from a computer | Phone app, Settings → Phone | When you pair; can be turned off or narrowed any time |
| Shared folders, commands, workflow tasks | Desktop app, Settings → Desktop access | When you add each one |
| Screen Recording (macOS) | System Settings → Privacy & Security | macOS asks the first time HANNAH looks; HANNAH's own dialog asks before every look or 15-minute session |
| Opening an app | Desktop app, a system dialog | Each time, unless you chose "always" for that app |
| Start at sign-in (login item or XDG autostart) | Desktop app, Settings → Desktop access | When you turn it on |

The register CI checks is `docs/NATIVE_PERMISSIONS.json`.

## 5. Android end-to-end run

The real Android app (debug build) in the emulator (API 36, Google dialer and Messages) is the phone. `scripts/phone-bridge-android-e2e.mjs` is the computer, signed in to the same account against a local server. The script:
- types the pairing code into the app's own Settings → Phone screen, through Playwright's Android WebView support;
- inspects the phone with `adb`: the resumed activity, a UI dump and screenshots;
- adds a test contact through the contacts provider.

Latest run: **12 of 12 checks passed.**

| Check | Result |
| --- | --- |
| Pairing completes; computer and phone show the same key fingerprint | Pass |
| The computer sees the phone online with the actions it allowed (call, SMS, contacts) | Pass |
| A lookup for "Bridgetest" returns only that contact and number | Pass |
| The call request is reported as "dialer opened" | Pass |
| Google's dialer is the resumed activity | Pass |
| The dialer shows +91 98765 43210, waiting for Call | Pass |
| No call is active (`dumpsys telecom`) | Pass |
| The SMS request is reported as "composer opened" | Pass |
| Google Messages is the resumed activity | Pass |
| The composer holds "Reaching in 20 minutes", waiting for Send | Pass |
| After the computer removes the phone, the app clears its pairing and shows the pair form again | Pass |
| A request to the removed phone is refused (409) | Pass |

To reach a server on the development machine, debug builds allow HTTP to `localhost` only (`android/app/src/debug`, used with `adb reverse`). Release builds don't include that file and stay HTTPS-only.

Not run: an iPhone end to end (no device here; the Swift plugin type-checks), and a closed phone app, which can't receive requests until push wake-up exists.
