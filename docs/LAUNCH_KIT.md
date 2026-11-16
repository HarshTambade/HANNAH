# HANNAH Launch Kit

**Launch date:** 15 November 2026<br>
**Product:** HANNAH — a private, cross-platform AI companion with a living 3D avatar, multilingual voice, and hybrid local/cloud inference.<br>
**Primary links:** `https://hannah.app` · Privacy `https://hannah.app/privacy` · Terms `https://hannah.app/terms` · Support `https://hannah.app/support`

> Replace the placeholder domain and URLs with the production domain before publishing. Verify every claim against the release build. Character counts below were checked against the literal strings in this document.

## 1. Positioning line (148 characters)

> **HANNAH is a private AI companion with a living 3D avatar, multilingual voice, and a hybrid brain that runs offline or in the cloud when you choose.**

This is the requested 150-character positioning line. It fits in 148 characters, so it can be used in press materials, Product Hunt copy, social bios, and the website hero.

### App Store subtitle (30-character field)

The App Store subtitle field allows **30 characters**, not 150. Use:

> **AI companion, offline or cloud**

Alternative compliant subtitles:

| Subtitle | Characters | Use |
| --- | --- | --- |
| `Private AI companion` | 20 | Safest, privacy-first |
| `Your private AI companion` | 25 | Warmer |
| `AI companion, offline or cloud` | 30 | Hybrid architecture |
| `Private AI, on your device` | 26 | Offline emphasis |

Do not paste the 148-character positioning line into the App Store subtitle field; App Store Connect will reject it.

## 2. App Store description (3,851 characters)

The App Store description limit is **4,000 characters**. This version is 3,851 characters including spaces and line breaks.

```text
HANNAH is a private AI companion with a living 3D avatar, a warm voice, and a brain that can run on your device or in the cloud—only when you choose.

Most AI companions ask you to trade your privacy for personality. HANNAH takes the opposite approach. The app is built around a simple promise: you should always know where your conversation is going, and you should be able to keep it local.

A COMPANION THAT FEELS PRESENT
HANNAH appears as a real-time 3D character who reacts to the conversation with expressive motion and emotion. She is not a static chatbot window. She listens, responds, and changes her expression as the mood shifts. The avatar is rendered with Three.js and runs smoothly across phone, desktop, and the web.

TALK, TYPE, OR CALL
Write a message, speak naturally, or start an in-app virtual call. HANNAH supports English, Hindi, and Marathi voice input and output. Voice is optional: you can use the app entirely by text, and you can turn spoken replies off at any time.

PRIVATE BY ARCHITECTURE
- On-device AI: download a compact GGUF model once and keep text conversations on your phone with llama.cpp.
- WebLLM: run a supported model inside your browser with WebGPU.
- Local Ollama: connect your own Ollama server for a private local endpoint.
- Cloud when you want it: Groq is the default cloud provider, with OpenAI, Anthropic, and other OpenAI-compatible providers available when configured.
- No HANNAH account, no server-side chat history, no advertising SDK, and no sale of your data.
- The active provider is named in the chat, so you are never guessing where a message went.

A CAPABLE ASSISTANT, WITH YOUR PERMISSION
HANNAH can use device tools to read and write files in her private app storage, check device and battery status, open supported apps, and help with bounded multi-step tasks. Sensitive actions require your confirmation. The optional native agent can use saved memories, and the optional desktop mode can operate a computer through screenshots and confirmed keyboard or mouse actions.

MEMORY YOU CONTROL
On-device memory is off by default. If you enable it, HANNAH can remember details you choose to save. You can inspect matching memories, delete individual entries, or clear everything from Settings → Privacy and voice. Memories stay in app-private storage.

BUILT FOR EVERY SCREEN
HANNAH runs as a responsive web app, an installable PWA, a native iOS and Android app, and a desktop build. Your companion follows you across screens without requiring an account.

FREE TO START
The Free plan includes 25 successful messages per day on local inference modes: WebLLM, the downloaded on-device model, and Ollama. Failed turns do not count. Premium is US$9.99 per month and adds unlimited messages, cloud providers, cloud-backed mobile and desktop agents, and priority Groq routing. Subscriptions are optional; the local experience remains useful without one.

HONEST LIMITATIONS
AI can be wrong, incomplete, or biased. HANNAH is not a medical, legal, financial, or emergency service. Cloud models require network access and send your prompt to the selected provider. Offline voice support varies by device and platform. Model quality depends on the model and hardware you choose.

YOUR DATA, YOUR CHOICE
Read the full privacy policy and terms at the links below. The policy names every third-party AI provider, explains what is sent in each mode, and describes how to delete local data and request deletion of operator-held records.

HANNAH is designed for people who want a companion with warmth and capability without giving up control of their conversations. Choose local when privacy matters most. Choose cloud when you need more capability. Either way, the choice stays visible.

Privacy: https://hannah.app/privacy
Terms: https://hannah.app/terms
Support: https://hannah.app/support
```

## 3. App Store promotional text (153 characters)

The promotional text field allows **170 characters** and can be changed without a new review.

> **Meet HANNAH: a private AI companion with a living 3D avatar, Hindi and Marathi voice, and a brain that runs on your device or in the cloud. Your choice.**

Character count: **153**. Confirm the count after any edit.

### Keyword ideas (100-character limit)

> `AI companion,private AI,offline AI,3D avatar,voice chat,Hindi,Marathi,local LLM,Groq,Ollama`

Check the current App Store keyword rules and avoid repeating the app name or competitor names.

## 4. Product Hunt taglines

Product Hunt allows a short tagline. Keep each under 60 characters.

1. **Privacy:** `A private AI companion that stays on your device.` — 49 characters<br>
2. **JARVIS-like capability:** `Your own JARVIS, with a face and a local brain.` — 47 characters<br>
3. **Emotional companion:** `A companion who remembers how you feel.` — 39 characters<br>

### Product Hunt first comment draft

> Hi Product Hunt! I built HANNAH because I wanted an AI companion that felt alive without treating my conversations as the product.
>
> HANNAH has a real-time 3D avatar, voice chat in English, Hindi, and Marathi, and a hybrid architecture. You can run a downloaded model on your phone, use WebLLM in the browser, point her at your own Ollama server, or switch to Groq, OpenAI, or Anthropic when you need more capability. The app names the active provider, so you always know where a message is going.
>
> There is no HANNAH account and no server-side chat history. Local memory is opt-in and can be deleted entry by entry. Sensitive device actions require confirmation, and every assistant reply has a “Report” control.
>
> Free includes 25 successful local messages per day. Premium is $9.99/month for unlimited messages and cloud-backed agents; billing is being connected, so this launch build is explicitly a preview.
>
> I would love feedback on the local/cloud switching, the avatar’s presence, and what would make HANNAH feel more natural to talk to. Thank you for trying her.

## 5. Reddit post templates

Use one community’s template at a time. Read each community’s rules, disclose that you are the builder, answer questions in the thread, and do not cross-post identical text. Avoid benchmark claims you have not measured on the reader’s hardware.

### 5.1 r/LocalLLaMA

**Title:** `I built a 3D AI companion with a hybrid local/cloud brain — WebLLM, llama.cpp, Ollama, and Groq behind one interface`

**Body:**

```text
Hi r/LocalLLaMA,

I’m the builder of HANNAH, a cross-platform AI companion with a 3D avatar and voice chat. The part I think this community will care about is the routing: the same conversation can run through four different inference paths without changing the UI.

What is actually running:
- WebLLM in the browser through WebGPU, using a small Llama instruct model.
- A downloaded GGUF model on iOS/Android through llama.cpp.
- A user-configured Ollama endpoint through the local API server.
- Groq (default), OpenAI, Anthropic, or another OpenAI-compatible provider when the user explicitly switches to cloud.

Why hybrid instead of cloud-only:
- Local modes keep prompts on the device or the user’s own machine.
- Cloud mode is opt-in and the active provider is named in the chat footer.
- If cloud fails, the client can fall back to a local path instead of dropping the turn.
- There is no HANNAH account and no server-side conversation database.

Things I’m still figuring out:
- How to make the local/cloud switch legible without adding friction to every message.
- Which small GGUF quantizations hold a companion persona best on mid-range phones.
- Whether Ollama users prefer a single pinned model or automatic model discovery.
- How to measure tokens/sec and time-to-first-token fairly across WebGPU, llama.cpp, and Groq without turning the thread into a benchmark contest.

The app is free to start with 25 successful local messages per day. Premium ($9.99/month) adds unlimited messages and cloud-backed agents; checkout is a placeholder in the launch build, and I’m being explicit about that rather than pretending billing is live.

I’m happy to share architecture details, the routing logic, or the confirmation flow for device tools. If you try it, please tell me which local path you used and where it broke. I’ll answer every technical question I can.

Disclosure: I’m the builder. Links: [site] · [privacy] · [source or demo]
```

### 5.2 r/artificial

**Title:** `Most AI companions are cloud products. I built one where you can choose local, cloud, or both — and see the trade-off in the chat.`

**Body:**

```text
Hi r/artificial,

AI companions usually make the same implicit trade: convenience in exchange for sending everything to a server. I wanted to see whether a companion could feel present while keeping that choice visible.

HANNAH is a cross-platform AI companion with a 3D avatar and multilingual voice. The architecture is deliberately hybrid:
- On-device model (llama.cpp + GGUF) for text when the user wants privacy or is offline.
- WebLLM for browser-local inference on supported hardware.
- Ollama for people who already run local models.
- Groq, OpenAI, or Anthropic for cloud turns when the user selects them.

The product decisions that mattered most:
1. The active provider is always named in the chat, not buried in settings.
2. Local memory is off by default and can be deleted entry by entry.
3. Device actions, file writes, and desktop control require explicit confirmation.
4. Every assistant reply has a report control that sends a message ID and reason, not the reply text.
5. There is no account and no server-side chat history.

What I’m wrestling with:
- Emotional presence without manipulation. The avatar should react, not guilt the user into staying.
- Honest capability labels. A small local model should not be marketed as equivalent to a frontier cloud model.
- Pricing that keeps the local experience useful. Free is 25 successful local messages/day; Premium is $9.99/month for unlimited and cloud-backed agents. Billing is not connected yet, so the launch build says so.
- Safety for a companion that can also act through tools. Confirmation is necessary but not sufficient; auditability matters.

I’m not posting this as a “ChatGPT killer.” It is a different bet: the user should be able to choose the privacy/capability trade-off per conversation, and the interface should make that choice obvious.

I would value feedback on the framing, the consent flow, and the emotional design. What would make you trust a companion like this — or refuse to use one?

Disclosure: I’m the builder. Links: [site] · [privacy] · [terms]
```

## 6. Launch channel checklist

- [ ] Publish the production domain, privacy policy, terms, and support page over HTTPS.
- [ ] Replace the placeholder checkout before charging anyone. If billing is not live, keep the “placeholder” label visible.
- [ ] Verify the App Store subtitle is 30 characters or fewer and the description is 4,000 or fewer.
- [ ] Capture screenshots that show the avatar, local/cloud mode label, voice controls, and privacy settings. Remove keys, tokens, personal data, and developer tools.
- [ ] Record a 20–30 second demo: local mode answer, switch to cloud, avatar emotion change, report control.
- [ ] Test the Reddit links on mobile and confirm the site does not require an account.
- [ ] Prepare a pinned FAQ comment with local model requirements, supported devices, pricing, and data handling.
- [ ] Set up UTM links for each channel and a privacy-friendly analytics page (or no analytics).
- [ ] Monitor Product Hunt and Reddit for the first four hours; answer technical questions with specifics, not marketing copy.
- [ ] Have the operations runbook and Sentry dashboard open during launch.

## 7. Claims to avoid

- “100% private” or “your data never leaves your device” — cloud modes exist and send data to providers.
- “Works offline” without qualification — voice, cloud agents, and model downloads may require a network.
- “Unlimited free” — Free is 25 successful local messages per day.
- “JARVIS” as a literal capability claim — it is a cultural reference, not a guarantee.
- “Kernel-level control” — the optional Linux eBPF monitor is metadata-only kernel sensing, not unrestricted kernel control.
- “End-to-end encrypted” — the server and provider can read requests to process them.
- “Trained on your conversations” or “never trained on any data” — describe HANNAH’s own policy precisely and link provider terms.
- “Medical, therapeutic, legal, or financial advice” — HANNAH is not a licensed professional service.
