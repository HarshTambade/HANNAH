/**
 * The landing page's words: what HANNAH does, what's next and the FAQ.
 * The page, the search structured data and /llms.txt all read from here, so
 * they always say the same thing.
 */
export type IconName = "AudioLines" | "Bot" | "Brain" | "Cable" | "CalendarDays" | "Cpu" | "Ear" | "HardDrive" | "MonitorSmartphone" | "PackageOpen" | "Sparkles" | "Waypoints" | "Workflow";

/** Everything here ships in this release. Each line says what it really does. */
export const CAPABILITIES = [
  {
    icon: "Cpu",
    title: "Any model, your choice",
    description: "Groq, OpenAI, Anthropic, Gemini, OpenRouter, Mistral, DeepSeek, xAI and more, or models on your own hardware with Ollama, LM Studio, llama.cpp or vLLM.",
  },
  {
    icon: "Waypoints",
    title: "Picks the right model for you",
    description: "Auto mode chooses a model for each message by Balanced, Best quality, Budget, Fastest or Private rules, shows you why before you send, and falls back if a provider fails.",
  },
  {
    icon: "Bot",
    title: "A team of specialist agents",
    description: "Turn on Team and HANNAH plans the task, runs Research, Coding, Memory and Tasks agents in parallel, then checks the result before answering.",
  },
  {
    icon: "AudioLines",
    title: "Talk naturally",
    description: "Speak and listen in English, Hindi and Marathi. Use your device's voices or OpenAI voices, Whisper transcription, and interrupt HANNAH mid-sentence.",
  },
  {
    icon: "Brain",
    title: "Memory you own",
    description: "See, edit, export or delete everything HANNAH remembers. With an account, sync it through your own Postgres, Supabase, Neon or SQLite database.",
  },
  {
    icon: "HardDrive",
    title: "Local and offline",
    description: "Run a model in your browser with WebLLM, on your phone with llama.cpp, or on your server. Private mode guarantees nothing goes to a cloud AI provider.",
  },
  {
    icon: "Sparkles",
    title: "A companion with presence",
    description: "A real-time 3D avatar that smiles, listens, thinks and talks, reacting to the mood of each reply.",
  },
  {
    icon: "Workflow",
    title: "Visual workflow automation",
    description: "Connect triggers, AI steps, conditions and integrations on a canvas. Workflows run on HANNAH's server on a schedule or from a webhook, with retries, approvals and a record of every step.",
  },
  {
    icon: "Cable",
    title: "Build on it",
    description: "An OpenAI-compatible API, MCP server and client, agent-to-agent (A2A) messaging, signed webhooks and a JavaScript SDK.",
  },
  {
    icon: "PackageOpen",
    title: "Skills marketplace",
    description: "Add first-party agents and community instruction skills, checked for integrity and publisher signatures before install.",
  },
  {
    icon: "Ear",
    title: "“Hey HANNAH”",
    description: "Turn on the wake word and start talking hands-free in the desktop app, on Android or in a browser tab. It's detected on your device; no audio leaves it until you speak to HANNAH.",
  },
  {
    icon: "CalendarDays",
    title: "Calendar and email",
    description: "Connect Google or Microsoft with their own sign-in. HANNAH reads your calendar and mail when you ask, and adds events, saves drafts or sends mail only after you approve.",
  },
  {
    icon: "MonitorSmartphone",
    title: "Tasks across devices",
    description: "Sign in on each device and start a task on your laptop, follow it on your phone, and approve its next step from whichever device is in your hand.",
    // An odd card out: on two-column screens it takes the full row.
    wide: true,
  },
] as const;

/**
 * The automation section. Every step named here is a node in the engine
 * (server/workflows/nodes.js); src/__tests__/LandingContent.test.ts checks
 * each integration's status against the registry, so the site can't promise
 * a step the engine doesn't have.
 */
export const AUTOMATION = {
  points: [
    ["A real visual editor", "Drag steps onto a canvas, connect them, and configure each one. Copy, paste, undo, tidy up, import and export; drafts and published versions."],
    ["Triggers", "Run by hand, on a schedule in your time zone, from a webhook (secret token or HMAC signature with replay protection), or when something happens in HANNAH."],
    ["AI steps that do work", "Ask any model through HANNAH's gateway, extract structured fields from text, classify, or hand a task to a specialist agent with your memories."],
    ["Logic and data", "If, Switch, Filter, Merge, Split into items, Aggregate, Wait and Approval steps; set, map, parse, convert and validate data with safe {{ expressions }}."],
    ["Runs you can inspect", "Every run records each step's input, output, timing, attempts and exact error. Retry from the failed step, run again, cancel, or approve a waiting step from any device."],
    ["Built to keep going", "Durable queue, retries with backoff, step and workflow time limits, recovery after a server restart, and a dead-letter state instead of silent loss."],
    ["Safe by design", "Credentials are encrypted and never shown again, internal network addresses are blocked, and a workflow lists what it may do before you activate it."],
    ["Describe it instead", "Type “every morning, summarize my new email” and HANNAH drafts the workflow. It stays a draft until you test, publish and activate it."],
  ] as const,
  flow: ["Webhook", "Extract invoice", "AI review", "Over 1,000?", "Save invoice", "Notify me"] as const,
  integrations: [
    { type: "action.http", name: "Any HTTP API", status: "available" },
    { type: "trigger.webhook", name: "Webhooks", status: "available" },
    { type: "trigger.schedule", name: "Schedules (cron)", status: "available" },
    { type: "action.email", name: "Gmail and Outlook", status: "available" },
    { type: "action.calendar", name: "Google and Outlook Calendar", status: "available" },
    { type: "action.github", name: "GitHub", status: "available" },
    { type: "action.slack", name: "Slack", status: "available" },
    { type: "action.discord", name: "Discord", status: "available" },
    { type: "action.notion", name: "Notion", status: "available" },
    { type: "action.postgres", name: "PostgreSQL, Supabase, Neon", status: "beta" },
    { type: "ai.prompt", name: "20+ AI providers", status: "available" },
    { type: "ai.agent", name: "Specialist agents", status: "beta" },
    { type: "action.memory", name: "HANNAH memory", status: "available" },
    { type: "action.reminder", name: "HANNAH reminders", status: "available" },
    { type: "trigger.email", name: "New-email trigger", status: "upcoming" },
    { type: "device.browser", name: "Browser tasks on desktop", status: "upcoming" },
  ] as const,
} as const;

/** Planned, not in this release. */
export const ROADMAP = [
  ["More workflow triggers", "A new-email trigger for Gmail and Outlook, and a file-upload trigger."],
  ["Workflows on your desktop", "Steps that run browser and coding tasks on your desktop app from a server workflow."],
  ["Computer use in the desktop app", "Seeing the screen and using the mouse and keyboard, with approval for each action. Today it needs a desktop app you build yourself (see the README)."],
  ["Signed store releases", "Notarized macOS, signed Windows, Google Play and TestFlight builds."],
] as const;

export const FAQS = [
  {
    q: "What is HANNAH?",
    a: "HANNAH is a personal AI companion: you talk or type, and it answers with voice, remembers what you ask it to, and gets work done with a team of AI agents, with a live 3D avatar. It runs in the browser, as a desktop app for macOS, Windows and Linux, and on Android.",
  },
  {
    q: "What do I need to start?",
    a: "A free Groq API key from console.groq.com is enough for the web app. Your key stays in this browser tab and goes only to Groq. A HANNAH server operator can also give you an access token or an account.",
  },
  {
    q: "Is it free?",
    a: "HANNAH has no paid tiers. You pay your AI provider directly for what you use, and many providers, including Groq, have free tiers. Local models cost nothing per message.",
  },
  {
    q: "Does HANNAH work offline?",
    a: "Yes, with a local model: WebLLM in a WebGPU browser (one ~900 MB download, then cached), or a downloaded model in the Android and iOS apps.",
  },
  {
    q: "Can HANNAH do things on my computer?",
    a: "Yes, in the desktop app. Share a folder in Settings → Desktop access and HANNAH can read files there, change files in folders you mark read-write, and run commands such as your tests. Every write and every command waits for your yes in a system dialog, and the app enforces those limits itself, outside the AI model. Seeing your screen and using the mouse (computer use) still needs a desktop app you build yourself; it's on the roadmap for the downloadable app.",
  },
  {
    q: "Where do workflows run?",
    a: "On HANNAH's server, so a schedule or a webhook runs even when your devices are off. They need an account on a server with its database set up; each workflow, its runs and its credentials belong to your account only. Without an account, the simpler routines on the Automations screen run on your device while HANNAH is open.",
  },
  {
    q: "Where does my data go?",
    a: "Chat history and memories stay on your device unless you sign in to an account, which syncs them through a database the operator chooses. Requests go only to the AI provider you pick, and in Private mode only to self-hosted models.",
  },
  {
    q: "Which platforms are supported?",
    a: "The web app works in modern browsers and installs as a PWA. There are desktop apps for macOS, Windows and Linux and an Android app. The iOS app builds from source but isn't distributed yet.",
  },
  {
    q: "Can I use ChatGPT, Claude or Gemini models with HANNAH?",
    a: "Yes. Connect your own key for OpenAI, Anthropic, Google Gemini, Groq, OpenRouter, Mistral, DeepSeek, xAI and other providers, or run models locally with Ollama, LM Studio, llama.cpp, vLLM or WebLLM. Auto mode can pick a model for each message.",
  },
  {
    q: "Can I talk to HANNAH hands-free?",
    a: "Yes. Turn on “Hey HANNAH” in Settings → Voice. The wake word is detected on your device in the desktop app, on Android and in desktop browsers, and no audio leaves the device until you speak to HANNAH.",
  },
  {
    q: "Is HANNAH open source?",
    a: "HANNAH's source code is public on GitHub under a source-available, non-commercial license: you can read, run and modify it for personal and non-commercial use.",
  },
];
