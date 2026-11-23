/**
 * The landing page's words: what HANNAH does, what's next and the FAQ.
 * The page, the search structured data and /llms.txt all read from here, so
 * they always say the same thing.
 */
export type IconName = "Radar" | "AudioLines" | "Bot" | "Brain" | "Cable" | "CalendarDays" | "Cpu" | "Ear" | "HardDrive" | "MonitorSmartphone" | "PackageOpen" | "Sparkles" | "Waypoints" | "Workflow";

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
    icon: "Waypoints",
    title: "Search and deep research",
    description: "Turn on Search the web and HANNAH searches, opens the pages and answers with citations you can click. Deep research plans the work and writes a report; every citation is checked against what was read, and pages it couldn't open are listed.",
  },
  {
    icon: "HardDrive",
    title: "PowerPoint, PDF, Word and Excel",
    description: "Ask for a deck, a report or a workbook in plain words, from your files or from research. Files are editable, Excel formulas are real formulas, and each file is opened again and checked before you get it.",
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
    title: "Your phone, from your computer",
    description: "Pair your phone, then ask from your computer to call or text someone. HANNAH finds them in the phone's contacts, and the phone's own dialer or Messages opens with it filled in. You tap Call or Send.",
  },
  {
    icon: "MonitorSmartphone",
    title: "Tasks across devices",
    description: "Sign in on each device and start a task on your laptop, follow it on your phone, and approve its next step from whichever device is in your hand.",
  },
  {
    icon: "Radar",
    title: "Robots, checked before they move (beta)",
    description: "Ask a robot to go somewhere, inspect a route or move an arm. A Safety Gateway checks every request, you approve it, and the result is verified from the robot's own state. Tested with HANNAH's built-in simulators; not yet run on a physical robot.",
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
    ["Triggers", "Run by hand, on a schedule in your time zone, when a new email arrives in Gmail or Outlook, when you upload a file, from a webhook (secret token or HMAC signature with replay protection), or when something happens in HANNAH."],
    ["AI steps that do work", "Ask any model through HANNAH's gateway, extract structured fields from text, classify, or hand a task to a specialist agent with your memories."],
    ["Logic, data and code", "If, Switch, Filter, Merge, Split into items, Aggregate, Wait and Approval steps; set, map, parse, convert and validate data with safe {{ expressions }}; or write JavaScript that runs in an isolated sandbox with no network or file access."],
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
    { type: "ai.prompt", name: "23+ AI providers", status: "available" },
    { type: "ai.agent", name: "Specialist agents", status: "beta" },
    { type: "action.memory", name: "HANNAH memory", status: "available" },
    { type: "action.reminder", name: "HANNAH reminders", status: "available" },
    { type: "trigger.email", name: "New-email trigger", status: "available" },
    { type: "device.browser", name: "Read pages on your desktop", status: "beta" },
    { type: "device.coding", name: "Coding tasks on your desktop", status: "beta" },
    { type: "trigger.file", name: "File uploads (CSV, JSON, text)", status: "available" },
    { type: "data.code", name: "JavaScript in a sandbox", status: "beta" },
  ] as const,
} as const;

/** The model section: the providers HANNAH connects to (server/providers/catalog.js) and Auto's routing modes (services/ModelRouting.ts; LandingContent.test.ts keeps them in step). */
export const MODEL_PROVIDERS = {
  cloud: ["Groq", "OpenAI", "Azure OpenAI", "Amazon Bedrock", "Hugging Face", "Anthropic", "Google Gemini", "OpenRouter", "Together AI", "Cerebras", "DeepSeek", "Mistral AI", "xAI Grok", "Fireworks AI", "NVIDIA NIM", "SambaNova", "Perplexity", "Hyperbolic"],
  local: ["Ollama", "LM Studio", "llama.cpp", "vLLM / LiteLLM", "WebLLM in the browser", "On-device on Android and iOS"],
} as const;

export const ROUTING_MODES = [
  ["Balanced", "Fits the model to each message: light for chat, stronger for coding and research."],
  ["Best quality", "The most capable model you can use, for every message."],
  ["Budget", "The lowest-cost model that can still handle the message."],
  ["Fastest", "The quickest measured model, then models known to be fast."],
  ["Private", "Only models on your own hardware or this HANNAH server. Nothing goes to a cloud AI provider."],
  ["Custom", "Your own provider list and quality ceiling."],
] as const;

export type Status = "available" | "beta" | "upcoming";

/** The agent section. Statuses follow docs/PLATFORM_SUPPORT.md. */
export const AGENTS = {
  team: ["Research", "Coding", "Memory", "Tasks"],
  computer: [
    { name: "Files and terminal", text: "Share a folder in the desktop app; HANNAH reads it, edits read-write folders and runs commands such as your tests. Each write and command asks you in a system dialog.", status: "available" },
    { name: "Desktop tasks from workflows", text: "A server workflow can ask your desktop app to read a web page in a hidden, signed-out window or run a coding task in a shared folder. Each task asks you first.", status: "beta" },
    { name: "Computer use", text: "Seeing the screen and using the mouse and keyboard. Today only in a desktop app you build yourself with the bridge; coming to the downloadable app.", status: "upcoming" },
  ] as { name: string; text: string; status: Status }[],
} as const;

/**
 * What works where, from docs/PLATFORM_SUPPORT.md (simplified: “yes”, a short
 * note, or “—” for not available).
 */
export const PLATFORM_MATRIX = {
  columns: ["Web", "macOS, Windows, Linux", "Android", "iOS"],
  rows: [
    ["Chat, voice, agents and memory", "yes", "yes", "yes", "Build from source"],
    ["Local models", "WebLLM (WebGPU)", "WebLLM; Ollama via the server", "On-device", "On-device"],
    ["“Hey HANNAH” wake word", "Desktop browsers", "yes", "While on screen", "—"],
    ["Visual workflows", "yes", "yes", "Runs view; canvas best on larger screens", "Runs view; canvas best on larger screens"],
    ["Files, terminal and desktop workflow tasks", "—", "yes", "—", "—"],
    ["Call or text from your computer (Phone Bridge)", "Sends the request", "Sends the request", "yes", "Build from source"],
    ["Reminders when HANNAH is closed", "—", "While the app runs", "yes", "yes"],
    ["Automatic updates", "yes", "macOS, Windows, AppImage", "Web updates", "—"],
  ],
} as const;

/** Planned, not in this release. */
/**
 * The robotics section. Each capability named here is checked against the
 * server's contract by src/__tests__/LandingContent.test.ts, so the site can't
 * name one the robot runtime doesn't implement. The limits are part of the
 * content on purpose: this is tested with simulators only.
 */
export const ROBOTICS = {
  status: "beta" as Status,
  rules: [
    ["The AI never touches a motor", "A model can only pick a named capability, such as “drive to a place”. The robot's own planner and controller do the moving."],
    ["Checked twice, then approved by you", "A Safety Gateway on the server and another on the robot refuse a goal outside the workspace, a robot that isn't ready, or a speed above its limit, and say why. Then you approve."],
    ["Stopping is always allowed", "Stop, pause and cancel never wait for approval. If the robot loses its link to HANNAH, it stops by itself."],
    ["Verified, or not called done", "“Arrived” is said only when the robot's reported position matches the goal. A grasp counts only when the gripper reports it is holding the object."],
  ],
  capabilities: [
    { id: "navigate_to", label: "Drive to a named place" },
    { id: "return_to_dock", label: "Return to the dock" },
    { id: "inspect_area", label: "Visit points and report" },
    { id: "report_surroundings", label: "Say what the range sensor detects" },
    { id: "capture_image", label: "Take a picture, when you've switched the camera on" },
    { id: "move_robot_arm", label: "Move an arm" },
    { id: "grasp_object", label: "Grasp an object" },
    { id: "release_object", label: "Release it" },
    { id: "stop_motion", label: "Stop" },
  ],
  also: ["Plans: several steps under one approval that lists every step", "Fleet: HANNAH picks the nearest ready robot and says why", "Commissioning: a physical robot can't move until a person completes eleven checks", "Figures from real records: outcomes, durations, command latency"],
  limits: [
    "Tested with HANNAH's built-in simulators: a mobile robot and an arm.",
    "The ROS 2 and Gazebo files are written and have not been run yet. No physical robot has been connected.",
    "HANNAH is not safety-certified, and Stop is a software request, not an emergency stop.",
  ],
} as const;

/**
 * The Devices section. The protocols named here are the ones the hub has an
 * adapter for (server/devices/profiles.js); a test fails if this list says
 * more than the server does, or if a shipped profile is called plug and play.
 */
export const DEVICES = {
  status: "beta" as Status,
  rules: [
    ["A hub on your own network", "A small program, HANNAH Edge, runs on a computer next to your devices. It speaks to them and opens the connection to HANNAH. Nothing connects in to your network."],
    ["Added without writing code", "Pick the device from a list, give HANNAH its manual, or describe it with a form. The hub then connects and shows you what it heard, before anything is switched on."],
    ["You choose what may be changed", "Reading is separate from changing. HANNAH can change only what you allowed, inside its range, and a change counts as done only when the device itself reports the new value."],
    ["Automations with no AI in them", "“When the temperature is above 28, switch the fan on” is approved once. After that the hub runs it by itself, and keeps running it without the internet."],
  ],
  protocols: [{ id: "mqtt", label: "MQTT" }, { id: "modbus-tcp", label: "Modbus TCP" }, { id: "http", label: "HTTP on the local network" }],
  notBuilt: [{ id: "matter", label: "Matter" }, { id: "zigbee", label: "Zigbee" }, { id: "zwave", label: "Z-Wave" }, { id: "ble", label: "Bluetooth" }, { id: "opcua", label: "OPC UA" }, { id: "modbus-rtu", label: "Modbus over a serial line" }],
  also: ["A manual's values come with the page and the line each was read from, and every one starts as unverified", "Each device shows how far its description was tested", "A value says whether it is live or only the last one known, and how old it is"],
  limits: [
    "Tested with HANNAH's own simulated devices, which speak MQTT and Modbus TCP over real sockets. No physical device has been connected.",
    "No description of a real product ships yet, and none is called plug and play.",
    "Matter, Zigbee, Z-Wave, Bluetooth, OPC UA and Modbus over a serial line are not built.",
    "There is no HANNAH OS image to install yet: the hub is a program you start on a computer you already have.",
    "HANNAH is not a safety system. A lock, a heater or a machine keeps its own protections.",
  ],
} as const;

export const ROADMAP = [
  ["Real devices and more ways to reach them", "Today devices work with HANNAH's own simulated ones over MQTT, Modbus TCP and HTTP. Next: the same checks against real products, then Matter and Zigbee, then images that make an edge computer a hub from first boot."],
  ["Robots in Gazebo and on real hardware", "Today robots work with HANNAH's built-in simulators. Running the ROS 2 adapter with Nav2 in Gazebo comes first, then a supervised physical robot, then arms with MoveIt 2."],
  ["Computer use in the desktop app", "Seeing the screen and using the mouse and keyboard, with approval for each action. Today it needs a desktop app you build yourself (see the README)."],
  ["Signed store releases", "Notarized macOS, signed Windows, Google Play and TestFlight builds."],
  ["Sign in to more services", "One-click sign-in for Slack, GitHub and Notion in workflows (today they use tokens or webhook URLs), and instant email triggers instead of checking every few minutes."],
  ["Shared workspaces", "Workflows and credentials a team can share. Today each belongs to one account."],
] as const;

export const FAQS = [
  {
    q: "Can HANNAH control my lights, plugs and sensors?",
    a: "With simulated devices, yes; with real ones it is untested. You run a hub (HANNAH Edge) on a computer on your network, add a device by picking it from a list, giving HANNAH its manual or describing it with a form, and the hub checks the connection before you switch it on. HANNAH speaks MQTT, Modbus TCP and HTTP today. It has been tested only with its own simulated devices; Matter, Zigbee, Z-Wave and Bluetooth are not built. HANNAH is not a safety system.",
  },
  {
    q: "Can HANNAH control a robot?",
    a: "In simulation, yes; on real hardware, not yet. You add a robot under Robots, start HANNAH's robot runtime, and ask it to drive to a place, inspect a route, take a picture or move an arm. Every request is checked by a Safety Gateway, approved by you, and verified from the robot's own state. This is tested with HANNAH's built-in simulators only: the ROS 2 and Gazebo files have not been run, no physical robot has been connected, and HANNAH is not safety-certified. Its Stop button is a software request, not an emergency stop.",
  },
  {
    q: "What is HANNAH?",
    a: "HANNAH is a personal AI companion: you talk or type, and it answers with voice, remembers what you ask it to, and gets work done with a team of AI agents, with a live 3D avatar. It runs in the browser, as a desktop app for macOS, Windows and Linux, and on Android.",
  },
  {
    q: "What do I need to start?",
    a: "A free Groq API key from console.groq.com is enough for the web app. Your key stays in this browser tab and goes only to Groq. Where a HANNAH server includes its own models for accounts, an email and a password are all you need; the page says so when that's the case. A server operator can also give you an access token.",
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
    a: "Yes, in the desktop app. Share a folder in Settings → Desktop access and HANNAH can read files there, change files in folders you mark read-write, and run commands such as your tests. Every write and every command waits for your yes in a system dialog, and the app enforces those limits itself, outside the AI model. Turn on “Run workflow tasks” and your server workflows can also ask it to read a web page or run a coding task (beta); each task asks you first. Seeing your screen and using the mouse (computer use) still needs a desktop app you build yourself; it's on the roadmap for the downloadable app.",
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
    q: "Can HANNAH search the web and make documents?",
    a: "Yes. With Search the web on, HANNAH searches, reads the pages and cites them; Deep research writes a full report with its sources and what it couldn't verify. Ask for a PowerPoint, PDF, Word document or Excel workbook and you get a real file to download, written from your attached files, from that research or from the conversation. Web search uses your Groq key unless the server has a search API key; on a free Groq plan, several searches in a row can hit its per-minute limit, and HANNAH says so when that happens.",
  },
  {
    q: "Can I talk to HANNAH hands-free?",
    a: "Yes. Turn on “Hey HANNAH” in Settings → Voice. The wake word is detected on your device in the desktop app, on Android and in desktop browsers, and no audio leaves the device until you speak to HANNAH.",
  },
  {
    q: "How do I get help or report a problem?",
    a: "Open an issue on GitHub with what you did and what happened; Settings → Diagnostics can export a report with keys and personal details removed. For a security problem, don't post the details publicly: open an issue asking for a private contact, and the maintainer will reach you.",
  },
  {
    q: "Is HANNAH open source?",
    a: "HANNAH's source code is public on GitHub under a source-available, non-commercial license: you can read, run and modify it for personal and non-commercial use.",
  },
];
