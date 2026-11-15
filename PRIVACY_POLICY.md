# Shanaya Privacy Policy

**Effective date:** 15 November 2026<br>
**Last updated:** 15 November 2026

Shanaya is a multilingual AI companion with a 3D avatar, voice conversation, optional on-device inference, and optional cloud AI. This policy explains what the Shanaya application and API (together, “Shanaya”, “the app”, “we”, “us”) process, why, where it goes, and how you can delete it.

Shanaya is operated by the Shanaya project operator. For privacy requests, contact **privacy@shanaya.app**. For general support, contact **support@shanaya.app**.

> **Publication note for the operator:** Replace the contact addresses, legal entity, governing-law jurisdiction, and effective date with the values that will appear on the public store listing before publishing. Do not publish placeholder contact details. This document must be hosted at a public HTTPS URL and linked from the App Store and Google Play listings.

## 1. The short version

- **No account is required.** Shanaya does not create a Shanaya account, profile, advertising identifier, or server-side chat history.
- **You choose where inference runs.** WebLLM, the downloaded on-device model, and a loopback Ollama server keep prompts on your device or local machine. Cloud and cloud-backed agent modes send the conversation to the provider you select.
- **We do not sell your data** and we do not use it for advertising, cross-app tracking, or training Shanaya’s own models.
- **Cloud AI is third-party processing.** When you use cloud mode, your messages and relevant context are sent through the Shanaya API to the configured provider, such as Groq, OpenAI, or Anthropic. Those providers process the data under their own terms and privacy policies.
- **Voice and desktop features are optional.** Microphone, speech recognition, local network access, files, and desktop screenshots are used only when you invoke the feature and grant the operating-system permission.
- **You can delete local data in the app.** Start a new conversation to clear the active chat, use the memory controls to delete saved memories, or uninstall the app to remove its private storage.

## 2. What Shanaya processes

| Data | When it is processed | Where it goes | Stored by Shanaya? |
| --- | --- | --- | --- |
| Chat messages, prompts, replies, and tool requests | When you send a message or an agent turn runs | Local modes: your device. Cloud/Ollama modes: the selected provider through the Shanaya API | No server-side conversation database. The active conversation stays in app memory for the session. |
| Voice audio and speech transcripts | When you start voice input or a voice call | Platform speech recognizer (Apple, Google, or browser), and Pinecall for calls when configured | No central audio archive or transcription database is configured by Shanaya. |
| App-private files and documents | When you ask Shanaya to list, read, write, or delete a file in its private Documents area | Local modes: the device. Cloud modes: file contents may be included in the prompt sent to the provider | The file remains in the app’s private storage until you delete it. |
| Desktop screenshots and task text | Only in the desktop computer-use feature, after you confirm the session | The configured Anthropic API | No screenshot archive is created by Shanaya. |
| Saved memories | Only if you enable on-device memory and approve a memory action | App-private LanceDB storage on iOS/Android; relevant memories may be sent with a MobileClaw request | Stored locally until you delete the memory or clear app data. |
| Feedback you submit | When you use the feedback form | A private Discord webhook and/or a MongoDB collection configured by the operator | Yes, until the operator deletes it. The feedback form does not send your chat transcript. |
| AI content reports | When you tap “Report” on an assistant reply | A metadata-only JSONL audit file on the Shanaya server | Yes: message ID, reason, app version, platform, inference mode, timestamp, and report ID. No reply text. |
| Crash logs and diagnostics | Automatically, only when the operator enables Sentry | Sentry | Sentry retains events under the operator’s Sentry plan. Shanaya’s scrubbers remove chat text, credentials, headers, and local paths before upload. |
| Purchase and subscription data | When paid subscriptions are enabled and you buy or restore Premium | Apple App Store, Google Play, RevenueCat, or Stripe, as configured | The billing provider stores payment data. Shanaya stores only the entitlement state needed to unlock Premium. |
| API access token | When a deployment requires a Shanaya API bearer token | The Shanaya API server for validation | The token is held in page memory for the session and is not written to browser storage by Shanaya. |
| Server metadata | For every API request | The hosting provider and application logs | Method, path, status, latency, and timestamp. Shanaya does not log request bodies, chat text, IP addresses, or Authorization values. |

Shanaya does not collect precise or approximate location, contacts, calendar events, SMS or call logs, health data, fitness data, browsing history, installed-app lists, or advertising identifiers. Shanaya does not request photo-library access.

## 3. Third-party AI providers and Apple Guideline 5.1.2(i) disclosure

Shanaya is a hybrid app. The provider that receives your data depends on the inference mode you choose and on how the operator has configured the deployment. The following disclosure is intended to satisfy Apple App Store Guideline 5.1.2(i) and Google Play’s user-data disclosure requirements.

| Provider | Data that may be sent | When it is sent | Purpose | Provider privacy policy |
| --- | --- | --- | --- | --- |
| **Groq** | Chat messages, assistant context, tool schemas, tool results, and model parameters. A visitor-supplied Groq API key may be forwarded in a request header. | Cloud mode when Groq is selected, or when Groq is the operator’s default provider | AI inference | https://groq.com/privacy-policy/ |
| **OpenAI** | Chat messages, assistant context, tool schemas, tool results, and model parameters | Cloud mode when OpenAI is configured and selected | AI inference | https://openai.com/policies/privacy-policy/ |
| **Anthropic** | Chat messages, assistant context, tool schemas, tool results, saved memories relevant to the request, and desktop task text/screenshots for computer use | MobileClaw mode, desktop computer-use mode, or cloud mode when Anthropic is configured and selected | AI inference and computer-use actions | https://www.anthropic.com/legal/privacy |
| **Ollama** | Chat messages, assistant context, tool schemas, and tool results | Ollama mode | Local or self-hosted AI inference | Ollama is software you or the operator run. The endpoint’s operator controls processing. See https://ollama.com/ |
| **Other configured providers** | Chat messages and agent context | Only when the operator configures that provider and you select it | AI inference | The provider’s own privacy policy, linked in the app where available |
| **Mithi TTS** | Reply text and language code | When the operator configures a Mithi voice service and voice output is enabled | Speech synthesis | The operator’s Mithi service terms |
| **Pinecall** | Voice audio and call session metadata | When you start a supported voice call | Real-time voice calls | The operator’s Pinecall service terms |
| **Apple / Google / browser speech services** | Microphone audio and recognized text | When you use voice input | Speech recognition | https://www.apple.com/legal/privacy/ and https://policies.google.com/privacy |
| **Sentry** | Crash logs, error stack traces, app version, release, environment, and scrubbed diagnostic metadata | When the operator enables Sentry | Error monitoring and stability | https://sentry.io/privacy/ |
| **Discord** | Feedback text, category, app version, platform, and inference mode | When you submit feedback and a Discord webhook is configured | Support and product improvement | https://discord.com/privacy |
| **MongoDB Atlas** | The same feedback fields | When you submit feedback and MongoDB is configured | Support and product improvement | https://www.mongodb.com/legal/privacy-policy |
| **Vercel or another hosting provider** | Request metadata such as IP address, headers, path, and timestamp at the infrastructure layer | For every API request | Hosting, security, and abuse prevention | https://vercel.com/legal/privacy-policy |
| **Apple App Store / Google Play / RevenueCat / Stripe** | Purchase history, subscription status, and payment information | When paid subscriptions are enabled | Billing and entitlement management | The applicable store or billing provider’s policy |

**What you are consenting to when you use cloud AI.** Selecting a cloud mode and sending a message is your instruction to transmit that message and the context needed to answer it to the provider shown in the app. If you do not want your conversation sent to a third-party AI provider, choose WebLLM, the downloaded on-device model, or a local Ollama endpoint. The app identifies the active provider in the chat footer and in the inference settings.

**No sale of personal information.** We do not sell personal information, share it for cross-context behavioral advertising, or use it for advertising measurement. We do not use your conversations to train Shanaya’s own models. Third-party providers process data under their own terms; review those terms before using cloud modes with sensitive information.

**Sensitive information.** Do not enter passwords, API keys, financial account numbers, government identifiers, health records, or other sensitive personal data unless you understand how the selected provider handles it. Local modes reduce transmission but do not make your device invulnerable.

## 4. Why we process data

We process data only to:

- provide the conversation, avatar, voice, memory, file, and agent features you request;
- route a request to the inference provider you select;
- enforce free-tier limits and, when billing is connected, Premium entitlements;
- keep the service secure, diagnose crashes, and prevent abuse;
- respond to feedback, content reports, and privacy requests;
- comply with legal obligations and enforce our Terms of Service.

We do not use your data for advertising, profiling for advertising, or sale. We do not make automated decisions that produce legal or similarly significant effects about you.

## 5. Local storage and retention

Shanaya keeps the active conversation in React state for the current page or app session. The repository does not configure a server-side conversation database.

| Data | Default retention | How to delete |
| --- | --- | --- |
| Active conversation | Until you start a new conversation, close the session, or uninstall the app | Tap “New conversation” or close the app |
| Saved memories (opt-in) | Until you delete them | Settings → Privacy and voice → memory controls; or clear app data |
| Downloaded on-device model | Until you remove the app or its model data | Uninstall the app or clear its storage |
| WebLLM model cache | Browser-managed | Clear site data in the browser |
| Feedback | Until the operator resolves and deletes it; target maximum 24 months | Email privacy@shanaya.app with the approximate date, category, and platform |
| AI content reports | 12 months, then reviewed for deletion | Email privacy@shanaya.app with the report ID or message ID and approximate date |
| LLM metadata traces | 30 days by default; the operator may configure a shorter period | Operator-side log rotation; these traces contain no prompt or reply text |
| Sentry events | The operator’s Sentry retention setting; commonly 30–90 days | Email privacy@shanaya.app with the event ID and approximate date |
| Billing records | As required by the store, tax, and accounting rules | Contact the store or billing provider; legal retention may prevent immediate deletion |
| Server request metadata | 30 days or less, unless security investigation requires longer | Operator-side log rotation |

Cloud providers may retain request data under their own policies and settings. Where a provider offers a data-deletion or zero-retention control, the operator should enable it. We cannot delete data that a third-party provider independently retains except through that provider’s tools or a valid legal request.

## 6. How to delete your data

Because Shanaya has no account system, most deletion happens on your device:

1. **Chat:** open a new conversation, or close the app. The active transcript is not stored in a Shanaya server database.
2. **Memories:** open **Settings → Privacy and voice**, review saved memories, delete individual entries, or clear all memories.
3. **Files:** use the app’s file controls to delete files in Shanaya’s private Documents area, or uninstall the app.
4. **On-device model and browser model:** uninstall the app or clear the browser’s site data.
5. **Feedback or content reports:** email **privacy@shanaya.app** with the report ID, message ID, approximate submission time, platform, and the email address you want us to reply to. Do not send the original chat text unless you choose to.
6. **Sentry events:** email **privacy@shanaya.app** with the event ID and approximate time. Sentry events are scrubbed and usually contain no account identifier.
7. **Subscriptions:** manage or cancel in the App Store or Google Play. Deleting the app does not cancel a subscription.

We aim to respond to verified deletion requests within **30 days**, or within the period required by applicable law. We may need to retain a minimal record of the request and any data required for tax, fraud prevention, security, or legal compliance. We will explain any retention that applies.

If you are in the European Economic Area, the United Kingdom, Switzerland, California, India, or another jurisdiction with data-protection rights, you may also have the right to access, correct, restrict, object to, or port your data, and to lodge a complaint with your local supervisory authority. Contact us first so we can try to resolve the issue.

## 7. Security

Shanaya uses HTTPS/TLS for cloud and remote provider requests. Plain HTTP is accepted only for loopback local model servers, so local traffic does not leave the device. Server API routes other than `/api/health` require a bearer token. Provider keys stay in server environment variables and are never placed in `VITE_*` client variables. Visitor-supplied Groq keys are held in page memory and forwarded only to Groq’s official HTTPS endpoint.

The app does not store chat text in application logs. Sentry scrubbers remove authorization headers, cookies, request bodies, prompt fields, key-shaped values, local file paths, and stack-frame source context before events leave the process. Content reports contain metadata only.

No method of transmission or storage is completely secure. You are responsible for protecting your device, your API token, and any provider key you enter. If you believe you have found a security issue, contact **security@shanaya.app** and do not include live credentials, private conversations, or personal data in the report.

## 8. Children

Shanaya is not directed to children under 13, and the operator does not knowingly collect personal information from children under 13. If local law sets a higher age for digital consent, that higher age applies. If you believe a child has provided personal information, contact **privacy@shanaya.app** so we can delete it.

## 9. International transfers

The operator and its providers may process data in countries other than your own, including the United States. Where required, the operator relies on appropriate safeguards such as standard contractual clauses or the provider’s applicable data-processing terms. Cloud providers’ processing locations and transfer mechanisms are described in their privacy policies.

Local modes do not send prompts to the operator or a cloud provider, although your operating system, browser, or local model runtime may still process data on your device.

## 10. Changes to this policy

We may update this policy when features, providers, or legal requirements change. We will update the effective date and, for material changes, provide an in-app notice or another prominent notice before the change takes effect. Continued use after the effective date means you accept the updated policy.

## 11. Contact

- Privacy: **privacy@shanaya.app**
- Security: **security@shanaya.app**
- Support: **support@shanaya.app**

If the operator is required to appoint a data protection officer or an EU/UK representative, the operator’s name and contact details will be published here and in the store listing before launch.
