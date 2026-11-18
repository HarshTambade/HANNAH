# HANNAH Platform Compatibility

## Web/PWA
- Supported: Chromium/Firefox/Safari modern. Service worker/PWA build via Vite.

## Desktop (Electron via Capacitor)
- Supported builds: macOS, Windows, Linux (CI).
- Requires desktop app for workflow device jobs and computer use.

## Android
- Capacitor project present. Native plugins: LanceDB, MobileClaw, MobileCron.
- Device verification required.

## iOS
- Capacitor project present. SPM includes LanceDB/MobileCron.
- Device verification required.

## Backend
- Node/Express primary. Python backend secondary (single-step fallback).
- Database: SQLite or Postgres.

## Known restrictions
- eBPF: Linux only, opt-in, root.
- On-device models: WebLLM/Native only in chat; automations require cloud/Ollama.