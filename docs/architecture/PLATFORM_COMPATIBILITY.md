# HANNAH platform compatibility

What runs where, and how sure we are.

Key:
- **Verified**: run for real on that platform.
- **CI**: built, and launched or tested, in GitHub Actions.
- **Unit**: covered by unit tests only.
- **—**: doesn't apply on that platform.
- **Missing**: not built.

User-facing support statements are in `docs/PLATFORM_SUPPORT.md`; this table is the engineering view behind them.

| Capability | Web/PWA | macOS (Electron) | Windows (Electron) | Linux (Electron) | Android | iOS |
| --- | --- | --- | --- | --- | --- | --- |
| Chat, models, routing | Verified | Verified (smoke test) | CI (build red at the audit step until KI-3) | CI | CI build | CI archive, no signed IPA released |
| Accounts and sync | Verified locally; **off in production** (KI-2) | Same | Same | Same | Same | Same |
| Server workflows (editor, runs) | Verified locally (real Groq) | Same | Same | Same | Same | Same |
| Device routines | Unit + e2e | Unit | Unit | Unit | Unit | Unit |
| Desktop workflow jobs (page read, coding) | — | Verified pieces; full chain needs a person at the dialogs | Unit | Unit | — | — |
| Screen viewing (on request) | — | Verified | Unit | Unit | — | — |
| Open apps, startup routine | — | Verified | Unit | Unit | — | — |
| HANNAH's browser, YouTube notes, PDF | — | Verified | Unit | Unit | — | — |
| Accessibility-tree app control (observe, act, verify) | — | Built; rules unit-tested; real run blocked on Accessibility permission (KI-24) | Missing (KI-25) | Missing (KI-25) | — | — |
| Phone Bridge (calls/SMS handoff) | — | — | — | — | Unit, no device run | Unit, no device run |
| Native vector memory (LanceDB) | — | — | — | — | Plugin wired, no device run | Plugin wired, no device run |
| Reminders and notifications | Verified | Unit | Unit | Unit | Plugin wired | Plugin wired |
| Voice (wake word, speech) | e2e | Unit | Unit | Unit | Plugin wired | Plugin wired |
| App icon in what's shipped | Verified | **v1.4.0: Electron's icon.** Fixed on main (packaged app checked) | Brand gate only (the .exe icon isn't parsed) | Fixed on main; checked by CI from the next run | **v1.4.0: Capacitor's icon.** Fixed on main (CI APK checked) | Brand gate |

## Platform restrictions (by design or by the OS)

- **iOS:**
  - No app can place or answer calls for the user, or read SMS. The Phone Bridge hands off to the phone app and Messages, and the user taps.
  - Background execution is limited. Server workflows run on the server instead.
- **Android:** calls and SMS go through the system's own apps and permission prompts. HANNAH refuses emergency numbers and doesn't automate calls.
- **macOS:**
  - Screen capture and app control need the user's Screen Recording and Accessibility permissions.
  - HANNAH asks before each screenshot and shows an indicator while allowed.
- **Windows and Linux:**
  - Screen capture works through Electron's `desktopCapturer`.
  - App control through UI Automation or AT-SPI isn't built.
- **eBPF sensor:** Linux only, root, opt-in.
- **Web:** no desktop or phone tools. Signed in, server workflows give the web app schedules and webhooks that run while the tab is closed (once the production database exists, KI-2).

## Server hosting

| Host | Workflow worker | Waits and schedules | Notes |
| --- | --- | --- | --- |
| Long-running Node (Docker, VPS, desktop dev) | In-process, every 5 s | Yes | Rate-limit waits up to 20 s happen in place |
| Vercel (serverless) | None | Only when `/api/workflows/tick` is called with `CRON_SECRET` | Production has neither a database nor a tick (KI-2). Rate-limit waits over 5 s park the run until the next tick. |
