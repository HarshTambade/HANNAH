# Platform support

Status for **HANNAH 1.4.0**, reviewed 2026-11-17. Every claim below says how it was checked. "Built" means the package compiled and was produced by CI. It doesn't mean someone ran it on that operating system.

## How each platform ships

| Platform | Package | Built by | Signing today |
| --- | --- | --- | --- |
| Web / PWA | Static site (`client/dist`) | CI "Web and PWA" job | Not applicable |
| macOS 12+ | DMG and ZIP, Apple silicon and Intel | CI "Electron (macos-latest)" | Not signed or notarized: no Apple Developer ID in the repository secrets |
| Windows 10/11 | NSIS installer (x64) | CI "Electron (windows-latest)" | Not code-signed: no certificate in the repository secrets |
| Linux (x86-64) | AppImage and `.deb` | CI "Electron (ubuntu-latest)" | SHA-256 checksums; GPG signatures once `GPG_PRIVATE_KEY` is set |
| Android 7+ (API 24) | APK; AAB when a Play key exists | CI "Android" | Debug-signed: no release keystore in the repository secrets |
| iOS / iPadOS | Xcode archive; IPA when signing exists | CI "iOS" | **Blocked:** needs an Apple distribution certificate, a provisioning profile and App Store Connect API keys |

## Feature matrix

**Legend:** ✅ works · 🟡 partly (see note) · ❌ not available · 🚫 blocked by the operating system or missing credentials. A verification tag follows each mark: **T** = tested in this release (automated browser tests or a manual run), **B** = built only, not run on that OS, **D** = by design from the code, not yet run on a device.

Each cell maps to one of the five readiness classes a release is judged by:

| Class | In this matrix |
| --- | --- |
| 1 · Implemented and verified | ✅ T |
| 2 · Implemented but partially verified | ✅ B, ✅ D, 🟡 T, 🟡 B, 🟡 D |
| 3 · Unsupported by the platform | 🚫 with an operating-system reason, or ❌ where the platform can't offer it |
| 4 · Blocked by external requirements | 🚫 signing, store or credential reasons |
| 5 · Not implemented | ❌ (not yet) |

A stable release needs no class-5 cell in a row that the release notes advertise, and every class-4 cell named under "Credentials needed" below.

| Capability | Web | iOS | Android | macOS | Windows | Linux |
| --- | --- | --- | --- | --- | --- | --- |
| Install and start | ✅ T | 🚫 signing | ✅ B (sideload APK) | ✅ B (Control-click → Open first time) | ✅ B (SmartScreen warning) | ✅ B |
| Sign in (key, token, account) | ✅ T | ✅ D | ✅ D | ✅ D | ✅ D | ✅ D |
| Main interface and layout | ✅ T (desktop and phone widths) | ✅ D (safe areas, tab bar) | ✅ D (edge-to-edge, tab bar) | ✅ D (menu bar, min window size) | ✅ D (menu bar) | ✅ D |
| Navigation, deep links to screens, back | ✅ T | ✅ D | ✅ D (system back walks app history) | ✅ D (Go menu, ⌘1–6, ⌘[ ⌘]) | ✅ D (Alt+←/→, Ctrl+1–6) | ✅ D |
| Voice out (text-to-speech) | ✅ T | ✅ D | ✅ D | ✅ D | ✅ D | 🟡 D (depends on installed system voices; OpenAI voices work) |
| Voice in (microphone) | 🟡 T (browser speech recognition in Chromium and Safari; Whisper anywhere) | ✅ D | ✅ D | ✅ D (needs the new microphone entitlement) | ✅ D | 🟡 D (Whisper; no system speech recognition in Electron) |
| "Hey HANNAH" wake word | ✅ T (Chromium, recorded "Hey Hannah" as the microphone; desktop browsers) | ❌ (not yet) | 🟡 D (while HANNAH is on screen; downloads the 41 MB model once) | ✅ D (while the app is open) | ✅ D (while the app is open) | ✅ D (while the app is open) |
| Files | 🟡 T (export and import JSON) | 🟡 D (app sandbox) | 🟡 D (app storage) | 🟡 D (export and import) | 🟡 D | 🟡 D |
| Reminders and notifications | 🟡 T (only while the tab is open) | ✅ D (system notifications, even when closed) | ✅ D (system notifications, even when closed) | 🟡 D (while the app runs) | 🟡 D (while the app runs; needs the installer's app identity) | 🟡 D (while the app runs; depends on the desktop's notification service) |
| Visual workflows (server engine, editor, runs, credentials) | ✅ T (browser test against a real server: build, test-run, webhook run, failure and retry; server tests on SQLite and Postgres) | 🟡 D (same web UI; the canvas is cramped on a phone, the runs view works) | 🟡 D (same) | ✅ D | ✅ D | ✅ D |
| HANNAH app icon (no framework default) | ✅ T (favicon, maskable PWA icon) | 🟡 B (icon set generated; iOS build not distributed) | ✅ B (aapt2-verified adaptive, round, monochrome) | ✅ T (packaged app checked locally) | 🟡 B (ICO generated and configured; checked in CI build) | 🟡 B (PNG set generated and configured; checked in CI build) |
| Cloud models (20 providers, routing) | ✅ T (mocked providers) | ✅ D | ✅ D | ✅ D | ✅ D | ✅ D |
| Local models | ✅ T (WebLLM downloaded and answered in Chromium with WebGPU; after the worker change, download progress re-verified, reply not yet re-run) | ✅ D (llama.cpp on-device) | ✅ D (llama.cpp on-device) | 🟡 D (WebLLM with WebGPU; Ollama through the server) | 🟡 D (as macOS) | 🟡 D (as macOS; WebGPU support varies by GPU driver) |
| Agents and Team mode | ✅ T (mocked models) | ✅ D | ✅ D | ✅ D | ✅ D | ✅ D |
| Desktop files and terminal | ❌ | ❌ | ❌ | ✅ T (HannahDesktop plugin; see below) | ✅ B | ✅ B |
| Tasks across devices (follow and approve) | ✅ T (approve from another device, mocked account API; server tests on SQLite) | ✅ D | ✅ D | ✅ D | ✅ D | ✅ D |
| Calendar and email (Google, Microsoft) | ✅ T (sign-in flow with mocked providers; server tests with fake Google and Graph) | 🟡 D (sign-in opens the system browser) | 🟡 D (sign-in opens the system browser) | 🟡 D (system browser) | 🟡 D (system browser) | 🟡 D (system browser) |
| Desktop computer use | ❌ | ❌ | ❌ | 🟡 D (only in a self-built desktop app with the bridge, plus the server's Anthropic key) | 🟡 D | 🟡 D |
| Memory and local storage | ✅ T | ✅ D | ✅ D | ✅ D | ✅ D | ✅ D |
| Knowledge (indexed documents with citations) | ✅ T (browser test: paste, search, citation, remove) | ✅ D (add files, paste) | ✅ D (add files, paste) | ✅ D (plus indexing a shared folder's text files) | ✅ D (same) | ✅ D (same) |
| Daily briefing (step, chat tool, settings, preview) | ✅ T (browser test: weather place lookup kept across reloads; unit tests for every section) | ✅ D | ✅ D | ✅ D | ✅ D | ✅ D |
| Setup check | ✅ T (browser test: server, model, storage verdicts) | ✅ D (microphone permission can't be read ahead of time on iOS: reported as not checked) | ✅ D | ✅ D (adds tray and shortcut) | ✅ D (same) | ✅ D (same) |
| Background work | 🚫 browser: only while open | 🚫 iOS: no background agents; notifications only | 🟡 D (notifications; no foreground service yet) | 🟡 while running | 🟡 while running | 🟡 while running |
| Permission prompts | ✅ T (browser) | ✅ D (microphone, speech, local network strings) | ✅ D (microphone, notifications) | ✅ D (microphone, local network) | ✅ D | ✅ D |
| App updates | ✅ T (PWA update prompt) | 🚫 App Store or TestFlight | 🟡 live web updates (Capawesome); APK updates are manual | ✅ D (auto-update from GitHub Releases; Stable or Beta channel, check on demand, update history; the channel and history were driven in the real app on macOS) | ✅ D (auto-update with the NSIS installer; same channels) | 🟡 D (AppImage auto-updates; `.deb` doesn't) |
| Tray or menu bar, Ctrl/⌘+Shift+H, `hannah://` links | ❌ (browser) | ❌ (not yet: no URL scheme in the iOS app) | ❌ (not yet) | ✅ T (driven in the real app: tray present, shortcut registered, `hannah://settings` opened Settings, unknown links ignored) | ✅ B | ✅ B |
| Backup and restore, diagnostics, text size | ✅ T (browser tests: back up, delete, restore; crash recorded and redacted; larger text without horizontal scroll) | ✅ D | ✅ D | ✅ D (desktop app builds from the same code) | ✅ D | ✅ D |
| Accessibility (axe, WCAG 2.1 AA) | ✅ T (eight screens at desktop and phone widths, no serious or critical findings) | ✅ D (same screens in the app's web view) | ✅ D | ✅ D | ✅ D | ✅ D |
| Error and offline states | ✅ T | ✅ D | ✅ D | ✅ D | ✅ D | ✅ D |

## What was actually run for 1.3.0

- **Browser (Chromium, Playwright):** 25 end-to-end tests at desktop and phone sizes. They cover routing (direct links, refresh, back and forward, old `#/` links, 404), landing-page links and version, chat, Team mode, routing preview, Models and "Use in chat", account sign-in and the Marketplace. WebLLM was separately downloaded (about 13 minutes) and answered a message. After the engine moved into its worker, a second run on the production build confirmed progress reporting through the new worker protocol (32% of the download in 15 minutes on a slow connection); the reply step was not re-run on that build.
- **Unit and API tests:** 148 client and 101 server tests. CI runs them on every push.
- **Desktop security policy:** the built app was served under the Electron runtime's default policy and under HANNAH's policy. The default left the avatar blank and blocked the fonts; HANNAH's policy rendered both, with no violations.
- **Desktop main process:** compiled with the generated Electron project (TypeScript, no errors).
- **Native projects:** versions synced (1.3.0, build 10300); `npx cap sync` for iOS and Android succeeded.
- **Not run in this release:** the packaged apps on macOS, Windows and Linux; Android on a device or emulator; iOS on a device or simulator. No iOS simulator runtime is installed here, and the local Android build needs a JDK 17+ that wasn't available. CI builds every package; the release notes and this page will be updated when someone runs them.

## Credentials needed for signed releases

Set these as GitHub repository secrets (Settings → Secrets and variables → Actions). The workflow uses each one automatically when it exists, and never prints it.

| To get | Secrets |
| --- | --- |
| Release-signed Android APK and Play AAB | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` |
| Signed iOS IPA for TestFlight | `APPLE_DEVELOPER_CERTIFICATE_P12`, `APPLE_DEVELOPER_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`, `APPSTORE_ISSUER_ID`, `APPSTORE_API_KEY_ID`, `APPSTORE_API_PRIVATE_KEY`, and the repository variable `IOS_SIGNING_ENABLED=true` |
| Signed and notarized macOS app | `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Code-signed Windows installer | `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` |
| GPG-signed Linux packages | `GPG_PRIVATE_KEY`, `GPG_PASSPHRASE` |

## Releasing

1. Set the version in `client/package.json`, run `npm version <x.y.z> --no-git-tag-version` in the root, `client` and `server`, then `node client/scripts/sync-native-versions.mjs`.
2. Add a `## <x.y.z>` section to `CHANGELOG.md`.
3. `node scripts/check-versions.mjs` must pass. CI runs it too, and on tag builds checks the tag matches.
4. Push, then either push the tag `v<x.y.z>`, or run **Build HANNAH** from the Actions tab with "Publish release" checked and the tag filled in.
5. The release job runs only after the tests and all five platform builds pass. It stages the packages under stable names, writes `SHA256SUMS`, writes notes from the changelog with each package's signing status, publishes, and then checks that every asset arrived.
