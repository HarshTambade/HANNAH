# Changelog

All notable changes to HANNAH. Versions follow [Semantic Versioning](https://semver.org/). Android `versionCode` and the iOS build number are `MAJOR×10000 + MINOR×100 + PATCH`.

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
