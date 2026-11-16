# Google Play Data Safety Form — HANNAH

**App:** HANNAH · AI Companion (`com.hannah.companion` for the Capacitor builds)<br>
**Document version:** 1.0 — 15 November 2026<br>
**Owner:** HANNAH privacy/engineering<br>
**Status:** Draft submission mapping. Verify every answer against the exact build, enabled SDKs, and operator configuration before publishing in Play Console.

This document maps HANNAH’s actual data flows to the Google Play **Data safety** section. It is written to be conservative: if a flow can send data off the device, it is declared as collected even when the default build keeps it local. If a processor receives data for the developer, it is declared as shared unless the operator has a written service-provider arrangement that clearly falls outside Google’s “sharing” definition.

> **Important:** Google’s form describes the behavior of the app **you submit**, not every possible configuration in the repository. If you ship with Sentry disabled, no feedback backend, no subscriptions, and no remote Ollama endpoint, some rows below become “not collected.” Do not copy this document blindly; confirm each answer.

## 1. Summary answers for Play Console

| Play Console question | Answer | Notes |
| --- | --- | --- |
| Does your app collect or share any of the required user data types? | **Yes** | Cloud AI, voice, feedback, content reports, diagnostics, and (when enabled) purchases. |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | Cloud/provider traffic uses HTTPS/TLS. Plain HTTP is allowed only for loopback local model servers, which do not leave the device. |
| Do you provide a way for users to request that their data be deleted? | **Yes** | In-app memory/file/chat controls, uninstall, and privacy@hannah.app. |
| Do you have a privacy policy? | **Yes** | Publish `PRIVACY_POLICY.md` at a public HTTPS URL and add it to the listing. |
| Have you committed to the Play Families Policy? | **No** | HANNAH is not designed for children under 13. |
| Has your app been independently validated against a global security standard? | **No** | Do not claim MASVS or ISO validation unless the operator completes it. |
| Do you use data for advertising or marketing? | **No** | No ads, no ad SDKs, no cross-app tracking. |
| Do you sell user data? | **No** | No sale or “share” for behavioral advertising. |

## 2. Data types collected and shared

Legend:

- **Collected** = transmitted off the user’s device by the app.
- **Shared** = transmitted to a third party or service provider outside the app.
- **Optional** = the user can use the core app without providing/triggering it.
- **Ephemeral** = processed only in memory/transit and not stored by the developer. Providers may still retain data under their own policies; do not mark ephemeral unless the end-to-end flow is confirmed non-retaining.

| Google Play data type | Collected | Shared | Optional | Purpose | Who receives it | Encrypted in transit | Deletion path |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Messages → Other in-app messages** (chat text, prompts, assistant context, tool requests and results) | **Yes**, when cloud, MobileClaw, desktop, or a remote Ollama endpoint is used | **Yes** | **Yes** — local modes avoid it | App functionality; AI inference | Groq, OpenAI, Anthropic, or the operator’s configured provider; Ollama endpoint operator | Yes | New conversation clears local state; provider deletion via provider tools; email privacy@hannah.app for operator-held copies |
| **Audio → Voice or sound recordings** (microphone audio for speech input and calls) | **Yes**, when the user starts voice input or a call | **Yes** | **Yes** — voice is optional | App functionality; speech recognition and voice calls | Apple/Google/browser speech service; Pinecall when calls are enabled | Yes, for app-controlled cloud paths; platform speech is governed by the OS/browser | Stop voice input; revoke microphone permission; platform/provider deletion tools; uninstall |
| **Files and docs** (files the user asks HANNAH to read, write, or delete in its private Documents area) | **Yes**, when file contents are included in a cloud prompt | **Yes** | **Yes** — only after a user action and confirmation | App functionality | Selected cloud provider (for file contents in a prompt) | Yes | Delete the file in the app; uninstall; provider deletion tools |
| **Photos and videos → Photos / Videos** (desktop screenshots captured for computer use) | **Yes**, only in desktop computer-use mode | **Yes** | **Yes** — desktop use is optional | App functionality; computer-use actions | Anthropic | Yes | End the desktop session; no HANNAH screenshot archive; Anthropic deletion tools |
| **App activity → Other actions** (AI content report metadata: message ID, reason, app version, platform, inference mode, timestamp) | **Yes**, only when the user taps “Report” | **No** — written to the operator’s local JSONL audit file | **Yes** | Safety review; abuse prevention; legal compliance | HANNAH operator only | Yes during transmission; at rest on the operator’s server | Email privacy@hannah.app with report ID/message ID; operator deletes the row from `logs/content_reports.jsonl` |
| **App activity → Other user-generated content** (feedback text and category) | **Yes**, only when the user submits feedback | **Yes** — Discord and/or MongoDB, depending on configuration | **Yes** | Support; product improvement | Discord webhook and/or MongoDB Atlas | Yes | Email privacy@hannah.app with approximate time/category/platform; operator deletes from Discord/MongoDB |
| **App info and performance → Crash logs** | **Yes**, only if Sentry is enabled in the shipped build | **Yes** — Sentry | **No** in a Sentry-enabled build (automatic); **No collection** if Sentry is disabled | Stability; diagnostics; app functionality | Sentry | Yes | Sentry retention expires; email privacy@hannah.app with event ID for expedited deletion |
| **App info and performance → Diagnostics** (error context, app version, release, environment, scrubbed metadata) | **Yes**, only if Sentry is enabled | **Yes** — Sentry | **No** in a Sentry-enabled build; **No collection** if Sentry is disabled | Stability; diagnostics | Sentry | Yes | Same as crash logs |
| **Financial info → Purchase history** (subscription product, entitlement status, renewal/cancellation state) | **Yes**, only when paid subscriptions are enabled | **Yes** — Apple/Google/RevenueCat/Stripe as configured | **Yes** — the app is usable on Free | App functionality; billing | App Store, Google Play, RevenueCat, Stripe | Yes | Manage in store account; contact store/billing provider; operator deletes entitlement records where permitted |
| **Personal info → Email address** (only if the user emails support) | **No**, not collected by the app | **No** by the app | **Yes** | Support correspondence | The operator’s email provider | Yes | Email privacy@hannah.app to delete the support thread |

## 3. Data types not collected

The following Play Console categories are **not collected by HANNAH** in the standard build:

- **Location:** approximate or precise. The app does not request location permission.
- **Personal info:** name, address, phone number, race/ethnicity, political or religious beliefs, sexual orientation, or other personal info. No HANNAH account is created.
- **Financial info:** user payment info, credit score, or other financial info. Card/bank details are handled by the store or billing provider and are not received by HANNAH.
- **Health and fitness:** health info or fitness info.
- **Messages:** emails, SMS/MMS. HANNAH does not read the user’s mail or SMS.
- **Photos and videos:** photo-library photos or videos. Desktop screenshots are declared above; the app does not request photo-library access.
- **Audio:** music files or other audio files. Microphone voice is declared above.
- **Calendar:** calendar events.
- **Contacts:** contacts.
- **App activity:** app interactions, in-app search history, installed apps, or other user-generated content beyond the feedback field above. Tool approvals and memories stay local.
- **Web browsing:** web browsing history.
- **Device or other IDs:** advertising ID, device ID, or other device identifiers. HANNAH does not use an advertising SDK.
- **Other:** any category not listed.

If the operator adds analytics, advertising, crash reporting other than Sentry, a new AI provider, a new voice provider, or a new billing SDK, this table must be updated **before** the next release.

## 4. Purpose mapping

Google Play’s purpose choices used above:

| Purpose | Where it applies |
| --- | --- |
| **App functionality** | Chat inference, voice input, file actions, desktop computer use, memory, subscriptions, content reports |
| **Analytics** | Crash/diagnostic review only; HANNAH does not use chat content for analytics |
| **Developer communications** | Not used for advertising or marketing |
| **Advertising or marketing** | Not used |
| **Personalization** | Not used |
| **Account management** | Not applicable; no HANNAH account |
| **Fraud prevention, security, and compliance** | Content reports, abuse prevention, rate limiting, audit logs |
| **Other purposes** | None declared |

## 5. Data handling details Play Console asks for

### 5.1 Is data collection optional or required?

- **Chat, voice, files, desktop screenshots, feedback, and content reports:** optional. The user chooses whether to use cloud mode, voice, files, desktop control, feedback, or reporting. Local text chat remains available without cloud data collection (subject to device/model support).
- **Crash logs and diagnostics:** if Sentry is enabled, collection is automatic and not user-toggleable. Treat it as required for that build, or disable Sentry and declare no crash/diagnostic collection.
- **Purchase history:** optional; only if the user buys Premium.
- **Email support:** optional and outside the app’s automatic collection; do not declare it as app-collected data unless the app itself sends an email address.

### 5.2 Is data processed ephemerally?

- **Voice audio:** the developer does not store an audio archive. Platform speech services may process audio ephemerally or retain it under their own policies. Do **not** mark the entire flow ephemeral unless the specific platform and provider are confirmed non-retaining.
- **Chat text:** not ephemeral in the Play sense. Providers may retain it under their terms even though HANNAH has no conversation database.
- **Content reports:** stored in a JSONL file; not ephemeral.
- **Feedback:** stored in Discord/MongoDB; not ephemeral.
- **Sentry events:** retained under the Sentry plan; not ephemeral.

### 5.3 Is data encrypted in transit?

**Yes**, for all app-controlled network paths:

- Cloud providers are reached over HTTPS.
- Remote Ollama and other remote model endpoints must use HTTPS. The server rejects plain HTTP for non-loopback hosts.
- Loopback HTTP (`localhost`, `127.0.0.1`, `::1`) never leaves the device.
- The HANNAH API requires HTTPS in production deployments; the operator must terminate TLS at the hosting layer or reverse proxy.

Platform speech recognition and store billing are encrypted by the platform provider; verify their current disclosures. Do not claim end-to-end encryption: the server and provider can read requests in order to process them.

### 5.4 Can users request deletion?

**Yes.** The app provides:

- **New conversation** to clear the active transcript.
- **Settings → Privacy and voice** memory controls to delete individual memories or clear all memories.
- File deletion inside HANNAH’s private Documents area.
- Uninstall to remove app-private storage, downloaded models, and local preferences.
- **privacy@hannah.app** for feedback, content reports, Sentry events, and operator-held data.
- Store/billing controls for subscriptions.

There is no HANNAH account to delete. Because content reports and feedback contain no account identifier, a deletion request must include enough metadata to locate the record (report ID or message ID, approximate time, platform, category). The operator should respond within 30 days.

### 5.5 Data transfers and international processing

Cloud providers may process data in the United States or other countries. The operator must ensure a lawful transfer mechanism and reflect it in the privacy policy. Local modes do not transfer prompts to the operator or a cloud provider.

## 6. Third-party SDK and service inventory for the declaration

| SDK/service | Data touched | Play Data safety treatment | Notes |
| --- | --- | --- | --- |
| Groq API | Chat text, tool context, optional visitor key header | Shared: Messages | AI inference |
| OpenAI API | Chat text, tool context | Shared: Messages | Only if configured |
| Anthropic API | Chat text, memory context, desktop screenshots | Shared: Messages; Photos/videos | MobileClaw and desktop |
| Ollama | Chat text, tool context | Shared: Messages if remote; **not collected** if loopback/local | Operator-controlled |
| Apple/Google/browser speech | Microphone audio, transcript | Shared: Audio | Platform-dependent |
| Pinecall | Call audio/session metadata | Shared: Audio | Only when calls enabled |
| Mithi TTS | Reply text | Shared: Messages? — text is sent to the TTS service | If configured; not a voice recording |
| Sentry | Crash logs, diagnostics | Shared: Crash logs, Diagnostics | Disable to remove this row |
| Discord | Feedback text | Shared: Other user-generated content | Operator webhook |
| MongoDB Atlas | Feedback text | Shared: Other user-generated content | Operator database |
| Vercel/hosting | Request metadata, IP at infrastructure layer | Not declared as app-collected content; hosting provider processes it | Confirm the host’s role and privacy policy |
| Apple App Store / Google Play / RevenueCat / Stripe | Purchase history, entitlement | Shared: Purchase history | Only when billing is enabled |

If a provider is configured but not used in the shipped build, remove it from the declaration. If a provider is used only for some users (for example, a visitor-supplied Groq key), still declare the data type because the capability exists.

## 7. Permissions and prominent disclosure

HANNAH requests only the permissions needed for user-invoked features:

| Permission | Why | When |
| --- | --- | --- |
| `RECORD_AUDIO` (Android) / `NSMicrophoneUsageDescription` (iOS) | Voice input and calls | When the user starts voice or a call |
| `NSSpeechRecognitionUsageDescription` (iOS) | Turn speech into text | When the user starts voice input |
| `NSLocalNetworkUsageDescription` (iOS) | Connect to Ollama or a local model host | When the user chooses local network inference |
| Desktop screen capture / accessibility (Electron) | Desktop computer use | Only after the user confirms a desktop session |
| File access inside app-private storage | Read/write/delete HANNAH files | Only after a user request and confirmation |

The app does not request location, contacts, calendar, SMS, call-log, photo-library, or advertising-ID permissions.

**Cloud disclosure:** The onboarding flow explains local versus cloud processing, the inference settings name the active provider, and the chat footer states where the current mode sends data. Before publishing, confirm that the first cloud turn is preceded by a clear disclosure that the message will be sent to the named third-party provider and that the user consents by sending. If the operator wants a separate consent checkbox, add it before the first cloud message and keep this document in sync.

## 8. Content rating and AI disclosures

- **AI-generated content:** Yes. HANNAH generates text, voice, and avatar behavior with AI. The app provides an in-chat “Report” control for assistant messages.
- **User-generated content:** Feedback and content reports are user-submitted. Chat text is not published to other users.
- **Moderation:** Users can report AI content; the operator reviews metadata-only reports. The app does not provide a public social feed.
- **Age rating:** HANNAH is not directed to children. Complete the IARC questionnaire accurately; the AI companion and cloud processing may affect the rating.
- **News, health, financial, or legal content:** HANNAH is a general companion, not a licensed professional service. The Terms of Service include disclaimers.

## 9. Pre-submission verification checklist

- [ ] Confirm the exact `HANNAH_API_TOKEN` deployment and HTTPS termination.
- [ ] Confirm whether Sentry is enabled in the release build. If yes, declare crash logs and diagnostics; if no, remove them.
- [ ] Confirm whether feedback delivery is configured. If neither Discord nor MongoDB is configured, `/api/feedback` returns 503; the app still shows the form, so either configure delivery or hide the form in that build.
- [ ] Confirm whether paid billing is connected. If not, do not declare purchase history; the checkout is a placeholder.
- [ ] Confirm the AI provider list in `server/providers/catalog.js` and the shipped `server/.env`. Remove unused providers from the privacy policy and this form.
- [ ] Confirm `CONTENT_REPORT_LOG` is writable and that the file contains no message text.
- [ ] Verify a report writes exactly the allowed fields: `schemaVersion`, `id`, `receivedAt`, `messageId`, `reason`, `appVersion`, `platform`, `inferenceMode`, optional `modeDetail`, `source`.
- [ ] Verify Sentry events contain no prompt, reply, key, Authorization header, IP address, or local path.
- [ ] Publish the privacy policy at a public HTTPS URL and link it in the Play listing and in-app settings.
- [ ] Publish the terms of service and support URL.
- [ ] Test deletion: clear chat, delete a memory, delete a file, submit a report, and email a deletion request.
- [ ] Re-run the mapping after adding any SDK, provider, analytics tool, or billing integration.

## 10. Operator notes

This mapping is a compliance aid, not a substitute for legal advice or a Play Console review. Google’s definitions and form fields can change. Keep a dated copy of the answers you submit, the build version, the provider list, and the privacy policy URL with the release record. If the operator cannot verify a flow, declare it conservatively and document the uncertainty.
