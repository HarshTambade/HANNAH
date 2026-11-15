# Store Submission and Release Checklist

This is the release handoff checklist for Shanaya. Repository configuration is prepared, but a public store release is **not ready** until the owner completes the account, legal, metadata, hardware, and secret items below. Do not publish a store listing with placeholder privacy or support URLs.

## Universal listing and privacy

- [x] App icon and launch artwork exist in the checked-in PWA, Android, and iOS asset sets. Verify legibility and safe areas in each current store preview.
- [ ] Capture current screenshots on real devices for every required phone, tablet, and desktop listing size. Remove personal data and developer tools from screenshots.
- [ ] Publish a public privacy policy URL and add it to every store listing. The draft in [PRIVACY_POLICY.md](./PRIVACY_POLICY.md) describes cloud-provider message processing, the optional Anthropic integration, microphone/speech processing, device actions, on-device memory, retention, deletion, and contact details. Replace the operator placeholders before publishing.
- [ ] Publish terms of service and a support/contact URL. Confirm the legal entity, contact details, jurisdiction, and effective date with the owner. Use [TERMS_OF_SERVICE.md](./TERMS_OF_SERVICE.md) as the starting draft.
- [ ] Replace the placeholder domain, contact addresses, dateline, and pricing/billing status in [LAUNCH_KIT.md](./LAUNCH_KIT.md) and [PRESS_RELEASE.md](./PRESS_RELEASE.md) with launch-day values.
- [ ] Complete each store's content/age-rating questionnaire and provide accurate short and long descriptions, category, keywords, and release notes.
- [ ] Review every SDK and enabled provider's privacy, retention, data residency, and acceptable-use terms. Complete a data inventory before filling in store privacy disclosures.
- [ ] Verify accessibility, localized listing copy, icon/splash appearance, and permission prompts on actual target hardware.
- [ ] Set up crash/error monitoring and a release owner who can halt promotion and respond to reports.

## Security and red-team readiness

- [x] Incoming agent turns flag common instruction-override phrases; output/tool text is checked for common credential and PII patterns; direct self-harm encouragement, violent threats, and a small set of dehumanizing insults are blocked by a local text heuristic.
- [x] Shell and terminal tool names are denied by default; agent turns default to 8 with a hard maximum of 20; tool calls are checked again before execution.
- [x] File reads/writes/deletes, calls, messages, flashlight changes, memory writes/deletes, and credential deletion use a SafetyGuard confirmation path. Approval-required tools fail closed if they have no SafetyGuard action.
- [x] Native memory is off by default and requires a user opt-in. Settings provides search, individual deletion, and clear-all controls. Turning memory off stops new capture/recall but leaves existing entries until the user deletes them.
- [x] The client audit's four moderate Workbox `glob`/`minimatch` advisories are removed with a scoped compatible override. Four low findings remain in Workbox's `deepmerge@4.3.1` dependency; no patched version is published, and the npm suggested PWA downgrade is incompatible with this project.
- [x] The separate desktop shell was upgraded from Electron 34.5.8 to Electron 45.3.2, removing the high Electron and `extract-zip` findings. The root workspace audit still reports six moderate `minimatch` findings in `electron-builder@26.18.0`'s dependency tree; npm's proposed auto-fix downgrades the builder to 25.1.0. Keep this visible and recheck for a compatible upstream builder fix before release.
- [ ] Run red-team checks against the signed release build on Android/iOS and desktop: quoted/encoded prompt injection, malicious instructions in files and tool results, repeated tool calls, denied shell tool names, approval cancellation, and output containing emails, phone numbers, tokens, or payment-card test strings.
- [ ] Review the complete mobile-agent, desktop bridge, MCP, provider, and server boundaries with a security reviewer. Check that app logs and crash reports contain no message content or secrets.
- [ ] Confirm privacy policy wording and store disclosures match the final provider SDKs and live data flows.

The local checks are defense in depth, not an external moderation service. Regex-based prompt-injection, PII, and toxic-output patterns can miss novel or obfuscated cases and can flag benign text. They do not make model behavior “flawless”; retain explicit confirmations and provider controls.

## iOS / App Store

- [x] `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription` are present in `client/ios/App/App/Info.plist` and are added by the iOS patch script if missing.
- [x] The checked-in privacy manifest declares the app's File Timestamp and UserDefaults required-reason APIs. The UserDefaults reason is `CA92.1`; audit third-party SDK manifests before submission.
- Reference: [Apple required-reason API entries](https://developer.apple.com/documentation/technotes/tn3183-adding-required-reason-api-entries-to-your-privacy-manifest).
- [ ] Confirm whether any SDK or analytics configuration tracks users across other companies' apps or websites. If it does, implement Apple's [App Tracking Transparency](https://developer.apple.com/documentation/apptrackingtransparency) permission flow before tracking; if it does not, do not request ATT unnecessarily.
- [ ] Complete App Store Connect's App Privacy answers, age rating, export-compliance answers, screenshots/previews, support URL, and privacy-policy URL.
- [ ] Create and test an App Store Connect app record, bundle ID, Developer ID/App Store distribution identities, and App Store provisioning profile.
- [ ] Configure repository variable `IOS_SIGNING_ENABLED=true` and secrets `IOS_CERTIFICATE_BASE64`, `IOS_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`, `APPSTORE_ISSUER_ID`, `APPSTORE_API_KEY_ID`, and `APPSTORE_API_PRIVATE_KEY`.
- [ ] Validate the exported IPA in TestFlight on supported iPhones/iPads before requesting App Review.

The workflow fails a release run if the iOS signing variable or any required signing/App Store Connect secret is missing.

## Android / Google Play

- [x] `client/android/variables.gradle` targets API 36. As of August 31, 2026, Google Play requires new apps and updates to target Android 16 / API 36 or higher for standard mobile apps; recheck the [target API policy](https://developer.android.com/google/play/requirements/target-sdk) before each submission.
- [x] Release workflow builds a signed APK and Android App Bundle (AAB) when signing credentials are present.
- [ ] Configure `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` repository secrets. Back up the upload/release key securely; do not replace it casually.
- [ ] Create the Play Console app record, enroll in Play App Signing, upload the AAB, complete the Data safety form, content rating, target-audience, ads, app-access, and privacy-policy fields. Use [DATA_SAFETY_FORM.md](./DATA_SAFETY_FORM.md) as the draft answer map and re-verify it against the exact release build.
- [ ] Confirm the on-call roster, alerts, key-rotation procedure, Sentry triage levels, and audit-log review cadence in [OPERATIONS_RUNBOOK.md](./OPERATIONS_RUNBOOK.md) before enabling production traffic.
- [ ] Add internal testers, test install/update flows, and review Android permission declarations and prominent disclosures.
- [ ] Start with a Play Console staged rollout, monitor crash/ANR and support signals, and halt or roll back if the release regresses.
- [ ] Check Android developer identity verification requirements for direct distribution in addition to Play Console requirements.

## Windows desktop

- [x] Electron release workflow accepts `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD` (or the legacy `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` secret names) and fails release packaging if credentials are missing or signing fails.
- [ ] Provision an Authenticode signing identity and store the certificate/PFX or signing-service reference and password in GitHub Actions secrets. An EV certificate is not a universal technical requirement; current [electron-builder signing guidance](https://www.electron.build/docs/features/code-signing/) says EV no longer skips SmartScreen reputation accumulation since 2024. Choose a certificate or managed signing service that meets the owner's trust and key-custody requirements.
- [ ] Verify the installer and executable signatures on a clean Windows machine and monitor SmartScreen reputation after release.

## macOS desktop

- [x] Electron configuration enables Hardened Runtime and includes the checked-in entitlements files. Release packaging requires code signing and notarization; it uses the Developer ID certificate and Apple credentials.
- [x] The generated Capacitor Electron release project is pinned to the patched Electron 45.3.2 line and is dependency-audited in CI before packaging.
- [ ] Configure secrets `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
- [ ] Verify the signed app, stapled notarization ticket, DMG, and auto-update from a clean macOS account and both supported architectures.

## Linux desktop

- [x] Release workflow creates detached GPG signatures for AppImage and DEB assets and publishes a SHA-256 checksum file.
- [ ] Configure `GPG_PRIVATE_KEY` and `GPG_PASSPHRASE`; keep an offline backup and publish the corresponding public key/fingerprint through a trusted channel.
- [ ] Verify signatures and checksums from a clean Linux machine before distributing the release.

## Desktop updater and staged rollout

- [x] Electron uses GitHub Releases as its publish provider and invokes `electron-updater` after startup. Release workflow requires Windows/macOS signing and stages `latest.yml`, `latest-mac.yml`, and `latest-linux.yml` at 10%. See [electron-builder auto-update and rollout docs](https://www.electron.build/v26/docs/features/auto-update/).
- [ ] Before promotion, install each signed package, confirm update discovery/download/install, and check that release metadata references the exact uploaded artifact filenames.
- [ ] Promote cautiously over several days: 10% → 25% → 50% → 100%. Update and upload each platform's `latest*.yml` with the new `stagingPercentage` value; monitor crash reports, update failures, and support tickets between steps.
- [ ] If an update is faulty, stop increasing its percentage and publish a fixed release with a **higher version number**. Do not reuse the failed version.

## Optional mobile OTA with Capawesome Live Update

Capawesome Live Update is documented here for future setup; it is not installed or enabled by this repository change. The owner must create a Capawesome Cloud app, review its service and privacy terms, and provide the app ID before enabling OTA. See [Capawesome setup](https://capawesome.io/docs/cloud/live-updates/setup/) and the [Capacitor Live Update SDK docs](https://capawesome.io/docs/sdks/capacitor/live-update/).

1. Install the Capacitor 8 plugin and sync native projects:

   ```bash
   cd client
   npm install @capawesome/capacitor-live-update
   npx cap sync
   ```

2. Create a Capawesome Cloud app and configure its app ID in `capacitor.config.ts`. Use `autoUpdateStrategy: "background"`, `readyTimeout: 10000`, and `autoBlockRolledBackBundles: true` only after testing the startup path and rollback behavior.
3. Call `LiveUpdate.ready()` as early as possible once the app has initialized successfully, before any `sync()` call. A bundle that fails to call `ready()` within the timeout is reset to the built-in bundle.
4. Use versioned channels such as `production-<versionCode>` so a bundle only reaches native binaries with compatible plugins. Configure Android's default channel in a native string resource and iOS's `CapawesomeLiveUpdateDefaultChannel` in `Info.plist`.
5. Upload a bundle with `npm run build` followed by `npx @capawesome/cli apps:liveupdates:upload`. Use separate tester/staging and production channels, promote a small cohort first, and monitor each deployment in the Capawesome Console.
6. For rollback, repoint or stop the affected channel in the Console. The plugin can revert a bundle that fails its readiness check; a user or support flow can also call `LiveUpdate.reset()` and restart/reload. Ship native plugin or permission changes through the app stores rather than OTA.

Only binary-compatible web assets (HTML, CSS, JavaScript) should ship through OTA. Native code, plugin, permission, or platform configuration changes require a new store binary. Keep OTA bundle signing/integrity and channel access controls enabled when configuring the service.

## Staged release go/no-go

- [ ] Security reviewer signs off on the release build and red-team findings.
- [ ] Privacy policy, terms, support URL, screenshots, store forms, and age/content rating are complete.
- [ ] Platform signing, notarization, update, and rollback checks pass with production credentials.
- [x] CI enforces a 5 MiB gzipped renderer budget and a 150 MiB per-installer artifact ceiling.
- [ ] Older target devices and lower-end desktops have been exercised; record frame rate, startup time, memory use, and update behavior.
- [ ] Release owner verifies backups, support coverage, monitoring, and the rollback decision path before increasing rollout beyond 10%.
