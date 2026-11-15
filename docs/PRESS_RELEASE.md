# FOR IMMEDIATE RELEASE

## Shanaya Launches a Private, Cross-Platform AI Companion That Runs on Your Device or in the Cloud

**A living 3D avatar, multilingual voice, hybrid local/cloud inference, and optional Linux kernel-level sensing — with the user’s choice of provider visible in every conversation.**

**REMOTE-FIRST — 15 November 2026** — Shanaya, a new cross-platform AI companion, is launching today for the web, iOS, Android, and desktop. Shanaya combines a real-time 3D avatar, voice conversation in English, Hindi, and Marathi, and a hybrid architecture that can keep inference on the user’s device or route it to a cloud provider the user explicitly selects.

Most AI companions are cloud products with a friendly interface. Shanaya is built around a different premise: a companion can feel present without making the conversation opaque. The app names the active inference provider in the chat, keeps local memory off by default, requires confirmation before sensitive device actions, and offers downloaded on-device models, browser-local WebLLM, and user-controlled Ollama endpoints alongside Groq, OpenAI, and Anthropic cloud options.

“We wanted to build a companion that feels alive without asking people to give up control of their conversations,” said the Shanaya founding team. “That meant treating privacy as an architecture decision, not a settings toggle. You can run Shanaya locally, switch to the cloud when you need more capability, and always see which path is active.”

### A companion with presence

Shanaya’s avatar is rendered in real time with Three.js and responds to the emotional tone of the conversation through motion and expression. Users can type, speak, or start an in-app virtual call. Voice input and spoken replies are optional, and the app supports English, Hindi, and Marathi.

The experience is designed for continuity across screens: a responsive web app, an installable progressive web app, native iOS and Android builds, and a desktop package. No Shanaya account is required, and the server does not maintain a conversation database.

### Hybrid AI, visible by design

Shanaya’s inference paths include:

- **On-device AI:** a downloaded GGUF model running through llama.cpp on iOS and Android.
- **WebLLM:** browser-local inference on WebGPU-capable hardware.
- **Local Ollama:** a user-configured local model endpoint.
- **Cloud:** Groq by default, with OpenAI, Anthropic, and other OpenAI-compatible providers available when configured.
- **Cloud-backed agents:** optional MobileClaw and desktop computer-use modes that send task context to Anthropic.

When a cloud mode is active, the app displays the provider in the chat footer and explains the data path in its privacy policy. The policy discloses the third-party AI providers that may receive chat text, voice, files, and desktop screenshots, as required by Apple App Store Guideline 5.1.2(i) and Google Play’s user-data rules.

### Capability with a confirmation boundary

Shanaya can read and write files in her private app storage, check device and battery status, open supported apps, and complete bounded multi-step tasks. Sensitive actions pass through a confirmation flow, and the optional desktop agent asks before keyboard or mouse actions.

On Linux, an optional eBPF monitor provides **kernel-level sensing** of system events for users who explicitly enable it. The monitor is metadata-only, opt-in, and does not read application payloads or expose a root shell. Shanaya describes it as kernel-level observability, not unrestricted kernel control.

### Pricing and availability

Shanaya is available now as a web app and progressive web app, with iOS, Android, and desktop builds. The Free plan includes 25 successful messages per day on local inference modes. Premium is **US$9.99 per month** and adds unlimited messages, cloud providers, cloud-backed mobile and desktop agents, and priority Groq routing. Billing integration is being finalized with RevenueCat, Stripe, and native store billing; the launch build labels checkout as a placeholder and does not charge users.

### Privacy and safety commitments

- No Shanaya account and no server-side chat history.
- No sale of user data and no advertising SDK.
- On-device memory is opt-in and can be deleted entry by entry.
- Content reports send a message ID and reason, not the reply text.
- Sentry error events are scrubbed of prompts, credentials, headers, and local file paths.
- Cloud processing is disclosed per provider, and local modes remain available.

Shanaya is not a medical, legal, financial, or emergency service. AI output can be inaccurate, and users should verify important information.

### Media resources

- Product site: `https://shanaya.app`
- Press kit and screenshots: `https://shanaya.app/press`
- Privacy policy: `https://shanaya.app/privacy`
- Terms of service: `https://shanaya.app/terms`
- Support: `https://shanaya.app/support`

**Media contact:** `press@shanaya.app`

### About Shanaya

Shanaya is an independent, cross-platform AI companion project focused on private, user-controlled conversation. It combines a real-time 3D avatar, multilingual voice, local and cloud inference, and confirmation-gated device tools. Shanaya is designed for people who want a warm, capable companion without giving up visibility into where their data goes.

### Boilerplate note

This press release is a launch template. Replace the placeholder domain, media contact, and any unverified performance or availability claims before distribution. Confirm the final pricing and billing status on the date of release. Do not describe the optional eBPF monitor as unrestricted kernel control.
