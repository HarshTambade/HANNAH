import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft, ArrowUpRight, Bot, Check, Clipboard, Code2, Database, KeyRound, LifeBuoy,
  Network, PlugZap, Server, Settings2, ShieldCheck, Terminal, Unplug, Webhook, Workflow,
} from "lucide-react";
import { apiUrl } from "../services/api";
import { SITE_URL } from "../config/site";
import { pathForScreen } from "../routes";
import DatabaseIntegration from "./DatabaseIntegration";
import McpServersCard from "./McpServersCard";
import { copyText } from "../services/clipboard";
import IntegrationCheck from "./IntegrationCheck";

type IntegrationsPageProps = { onBack: () => void };

// Every route, limit and variable below is taken from the server code
// (server/index.js, api-security.js, v1.js, a2a.js, webhooks.js, mcp-*.mjs).
// Update this page when those change.

// Pre-rendered at build time (no window), the examples use the public site.
const pageBase = typeof window === "undefined" ? `${SITE_URL}/` : window.location.href;
const apiRoot = new URL(apiUrl("/api"), pageBase).toString().replace(/\/$/, "");
const serverRoot = apiRoot.replace(/\/api$/, "");
const mcpEndpoint = new URL(apiUrl("/mcp"), pageBase).toString();
const settingsHref = pathForScreen("settings", import.meta.env.BASE_URL);

const localMcpConfig = JSON.stringify({
  mcpServers: {
    hannah: {
      command: "node",
      args: ["/absolute/path/to/HANNAH/server/mcp-stdio.mjs"],
      env: {
        HANNAH_API_URL: "http://127.0.0.1:3001",
        HANNAH_API_TOKEN: "<operator token or hk_ developer key>",
      },
    },
  },
}, null, 2);

const vscodeMcpConfig = JSON.stringify({
  servers: {
    hannah: {
      type: "stdio",
      command: "node",
      args: ["/absolute/path/to/HANNAH/server/mcp-stdio.mjs"],
      env: { HANNAH_API_URL: "http://127.0.0.1:3001", HANNAH_API_TOKEN: "<operator token or hk_ developer key>" },
    },
  },
}, null, 2);

const remoteMcpConfig = JSON.stringify({
  mcpServers: {
    hannah: {
      url: mcpEndpoint,
      headers: { Authorization: "Bearer <hk_ developer key>" },
    },
  },
}, null, 2);

const chatExample = `curl -X POST "${apiRoot}/chat" \\
  -H "X-Groq-API-Key: $GROQ_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"mode":"cloud","provider":"groq","messages":[{"role":"user","content":"Hello, HANNAH!"}]}'`;

const chatResponse = `{
  "reply": "Hi! How can I help today?",
  "emotion": "happy"
}`;

const openaiJs = `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${serverRoot}/v1",
  apiKey: process.env.HANNAH_API_KEY, // hk_… developer key
});

const stream = await client.chat.completions.create({
  model: "hannah-auto",
  messages: [{ role: "user", content: "Summarize MCP in one line." }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");`;

const openaiPython = `from openai import OpenAI
import os

client = OpenAI(base_url="${serverRoot}/v1", api_key=os.environ["HANNAH_API_KEY"])
reply = client.chat.completions.create(
    model="groq/openai/gpt-oss-120b",
    messages=[{"role": "user", "content": "Hello, HANNAH!"}],
)
print(reply.choices[0].message.content)`;

const openaiByok = `curl "${serverRoot}/v1/chat/completions" \\
  -H "X-Groq-API-Key: $GROQ_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"hannah-auto","hannah":{"routing":{"mode":"budget"}},
       "messages":[{"role":"user","content":"Hi"}]}'`;

const a2aExample = `curl -X POST "${apiRoot}/a2a" \\
  -H "Authorization: Bearer $HANNAH_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "role": "user",
        "messageId": "msg-1",
        "parts": [{ "kind": "text", "text": "Draft a two-line reminder for Friday." }]
      }
    }
  }'`;

const a2aResponse = `{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "kind": "message",
    "role": "agent",
    "parts": [{ "kind": "text", "text": "Reminder: …" }],
    "metadata": { "model": "…", "provider": "Groq" }
  }
}`;

const webhookVerify = `import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the exact request body string, before JSON parsing.
export function verifyHannahWebhook(rawBody, headers, secret) {
  const timestamp = headers["x-hannah-timestamp"];
  const signature = headers["x-hannah-signature"] ?? "";
  const expected = "sha256=" + createHmac("sha256", secret).update(\`\${timestamp}.\${rawBody}\`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  return fresh && signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}`;

type Access = "public" | "byok" | "account" | "operator";
const accessLabels: Record<Access, { label: string; className: string }> = {
  public: { label: "Public", className: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  byok: { label: "Your key", className: "border-sky-200 bg-sky-50 text-sky-800" },
  account: { label: "Account", className: "border-violet-200 bg-violet-50 text-violet-800" },
  operator: { label: "Operator", className: "border-amber-200 bg-amber-50 text-amber-900" },
};

type Method = "GET" | "POST" | "PUT" | "DELETE";
type Endpoint = { method: Method; path: string; access: Access; description: string };

const endpointGroups: Array<{ title: string; items: Endpoint[] }> = [
  {
    title: "Research and documents",
    items: [
      { method: "POST", path: "/api/research", access: "byok", description: "Research a question: searches, reads the pages and returns an answer with checked citations and its sources. Streams each step as server-sent events." },
      { method: "POST", path: "/api/documents/compose", access: "byok", description: "Write a PowerPoint, PDF, Word or Excel file from a request in plain words, optionally from research, uploaded files or a conversation. Streams its steps; files come back as base64." },
      { method: "POST", path: "/api/documents/create", access: "byok", description: "Render a ready document or workbook description into validated files. No model call." },
      { method: "POST", path: "/api/documents/read", access: "byok", description: "Read a PDF, Word, PowerPoint, Excel, CSV, text or JSON file into text and tables, with how much of it was read." },
      { method: "POST", path: "/api/documents/convert", access: "byok", description: "The content of a file in another format (pptx, pdf, docx, xlsx)." },
      { method: "GET", path: "/api/account/documents", access: "account", description: "Files made while signed in. Download, keep or delete each by id." },
    ],
  },
  {
    title: "Status and discovery",
    items: [
      { method: "GET", path: "/api/health", access: "public", description: "Whether the API is up and the default cloud provider is ready." },
      { method: "GET", path: "/api/providers", access: "byok", description: "Providers this credential can use. Never returns keys." },
      { method: "GET", path: "/api/catalog", access: "byok", description: "Model catalog with capabilities and pricing tiers." },
      { method: "GET", path: "/api/models?provider=groq", access: "byok", description: "Model IDs available from one provider." },
    ],
  },
  {
    title: "Conversation and agents",
    items: [
      { method: "POST", path: "/api/chat", access: "byok", description: "Send 1–40 messages (up to 4,000 characters each); get a reply and an emotion." },
      { method: "POST", path: "/api/agent", access: "byok", description: "One agent step with tool definitions. Returns tool calls for your app to validate and run." },
      { method: "POST", path: "/api/orchestrate", access: "byok", description: "One phase of an agent team (plan, work, review) for a task of up to 4,000 characters." },
      { method: "POST", path: "/api/route/preview", access: "byok", description: "Which provider and model a routing mode would pick, with estimated cost, before sending." },
    ],
  },
  {
    title: "Voice",
    items: [
      { method: "GET", path: "/api/voice/providers", access: "byok", description: "Speech providers available to this credential." },
      { method: "POST", path: "/api/voice/speak", access: "byok", description: "Text to speech." },
      { method: "POST", path: "/api/voice/transcribe", access: "byok", description: "Speech to text. Send audio/* as the request body." },
    ],
  },
  {
    title: "Images and video",
    items: [
      { method: "GET", path: "/api/media/providers", access: "account", description: "Which image and video engines this account can use: OpenAI, xAI or Together for images, xAI for video." },
      { method: "POST", path: "/api/media/image", access: "account", description: "Make an image from { prompt, size?, provider? } with the account's or the server's key. Returns the image as base64. The daily budget applies, and prompts about minors or real private people are refused." },
      { method: "POST", path: "/api/media/video", access: "account", description: "Start a short video clip (xAI). Returns a job id to poll." },
      { method: "GET", path: "/api/media/video/:provider/:id", access: "account", description: "Poll a video job; when it's done, the clip comes back as base64 MP4." },
    ],
  },
  {
    title: "Shared links and projects",
    items: [
      { method: "POST", path: "/api/account/shares", access: "account", description: "Publish a read-only copy of chosen messages. Returns a link to /s/:id. At most 20 an hour." },
      { method: "GET", path: "/api/account/shares", access: "account", description: "Your shared links." },
      { method: "DELETE", path: "/api/account/shares/:id", access: "account", description: "Delete a link; it stops working at once." },
      { method: "GET", path: "/s/:id", access: "public", description: "The shared page itself: server-rendered HTML with no scripts, not indexed and not cached." },
      { method: "POST", path: "/api/agent", access: "byok", description: "Send project: { name, instructions } with an agent step to apply a project's instructions (up to 4,000 characters) to that request." },
    ],
  },
  {
    title: "AI Workforce (signed in)",
    items: [
      { method: "GET", path: "/api/workforce/bots", access: "account", description: "Your AI teammates. POST creates one from a template or from scratch." },
      { method: "POST", path: "/api/workforce/bots/:id/messages", access: "account", description: "Talk to a teammate. Asking for work returns a proposed task you accept separately." },
      { method: "POST", path: "/api/workforce/tasks", access: "account", description: "Queue a task for a teammate. It runs on the server; /tasks/:id/delegate and /handoff pass it on." },
      { method: "GET", path: "/api/workforce/approvals", access: "account", description: "Approvals waiting for you. High-risk steps always ask; critical ones (payments, robot motion) are refused." },
      { method: "POST", path: "/api/workforce/routines", access: "account", description: "Run a teammate or skill on a schedule, on an event or from a webhook. /routines/:id/run starts one now." },
      { method: "POST", path: "/api/hooks/routine/:id", access: "public", description: "A routine's webhook. Verified the provider's way: GitHub, Linear, Sentry, PagerDuty, or X-HANNAH-Signature for any service." },
      { method: "GET", path: "/api/workforce/sessions/:id/stream", access: "account", description: "Live view of a cloud computer's browser as server-sent events. /handoff takes control; /input sends your clicks and keys." },
    ],
  },
  {
    title: "Robot operations (signed in)",
    items: [
      { method: "POST", path: "/api/robots/:id/mode", access: "account", description: "Change a robot's operating mode (Manual, Assisted, Supervised Autonomy, Mission Autonomy, Maintenance, Safety Stop). Only moves the transition table allows; GET /api/robots/:id/autonomy shows the mode, profile and policy." },
      { method: "POST", path: "/api/robots/:id/teleop", access: "account", description: "Take manual control as a signed-in operator (never an API key). /teleop/:session/command sends short-lived velocity commands; /end hands control back." },
      { method: "GET", path: "/api/robots/:id/blackbox/events", access: "account", description: "The robot's black-box timeline, searchable by time, mission, source, type and severity. /blackbox/incident explains why it stopped, from the records only." },
      { method: "GET", path: "/api/robots/:id/blackbox/missions/:mission/replay", access: "account", description: "A mission rebuilt from its recordings, always marked as playback." },
      { method: "POST", path: "/api/robotops/deployments", access: "account", description: "Start a sim-to-real deployment. /simulate runs the built-in simulator, /parity compares it with the real robot, /approve needs a signed-in person." },
      { method: "POST", path: "/api/robotops/rollouts", access: "account", description: "Roll a signed update package out in waves; each wave needs approval (/waves/:index/approve) and failed robots are rolled back." },
      { method: "GET", path: "/api/interop", access: "account", description: "Every robot behind every adapter (HANNAH link, VDA 5050) in one normalized shape. /interop/capabilities says which missions each can do." },
      { method: "GET", path: "/api/trust/devices", access: "account", description: "Device identities, certificates and quarantine. PUT /api/trust/policy sets credential lifetimes, quarantine and mTLS." },
      { method: "GET", path: "/api/hardware-packages", access: "account", description: "Signed hardware packages and installs. /install, /rollback and /revoke ask a person first." },
      { method: "GET", path: "/api/robots/:id/resources", access: "account", description: "The robot computer's measured resources, with which local model fits and why." },
      { method: "POST", path: "/api/graph/ask", access: "account", description: "Ask the device graph about an entity; /graph/nodes/:id/context follows a sensor to its machine, place, robots and workflows, re-checked live." },
      { method: "GET", path: "/api/maintenance/findings", access: "account", description: "Maintenance findings, each labelled measured anomaly, suspected cause or confirmed fault, with evidence. /feedback marks one real or false." },
      { method: "GET", path: "/api/diagnostics", access: "account", description: "Self-diagnostic checks and incidents. POST /api/diagnostics/recover runs a recovery by its policy; safety-critical recoveries are refused." },
    ],
  },
  {
    title: "Accounts (when the server has a database)",
    items: [
      { method: "POST", path: "/api/account/register", access: "public", description: "Create an account. /login and /logout work the same way." },
      { method: "POST", path: "/api/account/api-keys", access: "account", description: "Create an hk_ developer key. It is shown once and stored hashed." },
      { method: "GET", path: "/api/account/export", access: "account", description: "Download everything the account stores." },
      { method: "DELETE", path: "/api/account", access: "account", description: "Delete the account and its data." },
    ],
  },
  {
    title: "Tasks across devices (signed in from the app)",
    items: [
      { method: "GET", path: "/api/account/tasks", access: "account", description: "Tasks and approval requests from all your devices in the last day (?since=<ms> for changes only)." },
      { method: "PUT", path: "/api/account/tasks/:id", access: "account", description: "The device running a task reports it, or asks for an approval (kind: approval). Approvals expire after 10 minutes by default." },
      { method: "POST", path: "/api/account/tasks/:id/decision", access: "account", description: "Approve or deny from any of your devices: { approve, deviceId, deviceName }. The first answer wins; later ones get 409." },
    ],
  },
  {
    title: "Calendar and email (signed in from the app)",
    items: [
      { method: "GET", path: "/api/account/connections", access: "account", description: "Which providers this server has set up, and which you've connected." },
      { method: "POST", path: "/api/account/connections/:provider/start", access: "account", description: "Start Google or Microsoft sign-in (PKCE). Returns the provider's sign-in URL." },
      { method: "GET", path: "/api/account/calendar/events", access: "account", description: "Events between from and to (ISO 8601, up to 92 days) from your connected calendars." },
      { method: "POST", path: "/api/account/calendar/events", access: "account", description: "Add an event. The app asks you to approve it first." },
      { method: "GET", path: "/api/account/mail/messages", access: "account", description: "Search mail (?q= uses the provider's syntax) or list the newest messages." },
      { method: "POST", path: "/api/account/mail/send", access: "account", description: "Send plain-text mail; /api/account/mail/drafts saves a draft instead. The app asks you to approve both first." },
    ],
  },
];

const v1Endpoints: Endpoint[] = [
  { method: "GET", path: "/v1/models", access: "byok", description: "Models this credential can use, plus hannah-auto." },
  { method: "POST", path: "/v1/chat/completions", access: "byok", description: "Chat completions. Set stream: true for server-sent events." },
  { method: "GET", path: "/v1/usage", access: "byok", description: "Today's estimated spend and your daily budget." },
];

const a2aEndpoints: Endpoint[] = [
  { method: "GET", path: "/.well-known/agent-card.json", access: "public", description: "Public agent card: skills, input and output modes, accepted credentials." },
  { method: "GET", path: "/api/a2a/agent-card", access: "public", description: "The same card under /api." },
  { method: "POST", path: "/api/a2a", access: "byok", description: "message/send with text parts, 1–8,000 characters. tasks/get and tasks/cancel aren't supported, and streaming is off." },
];

const credentials: Array<{ name: string; header: string; access: Access; use: string; where: string }> = [
  { name: "Your Groq key", header: "X-Groq-API-Key: gsk_…", access: "byok", use: "Chat, agents, models, voice, /v1 and A2A. No account or server token needed. Rate limits are counted per key.", where: "console.groq.com" },
  { name: "Developer API key", header: "Authorization: Bearer hk_…", access: "account", use: "The same routes, using the provider keys saved in your account. Best for scripts, SDKs and other agents.", where: "Settings → Account → Developer API keys" },
  { name: "Operator token", header: "Authorization: Bearer <HANNAH_API_TOKEN>", access: "operator", use: "Every route, including desktop control, calls, feedback, sync and tools from outside MCP servers. Only for whoever runs the server.", where: "server/.env (32–512 characters)" },
  { name: "MCP token (optional)", header: "Authorization: Bearer <MCP_API_TOKEN>", access: "operator", use: "An extra credential for the /mcp endpoint only, acting as the operator. Remote MCP hosts can also use a developer key or a Groq key, so most setups don't need it.", where: "server/.env (32+ characters)" },
];

const mcpTools = [
  { name: "hannah_chat", input: "prompt (1–4,000 chars), history (up to 12 turns, 2,000 chars each), mode: cloud | ollama, model (optional)", output: "reply, emotion (happy, sad, angry, neutral, surprised, thinking)", note: "Calls the configured AI provider and may incur provider usage. Prompt plus history must stay under 16,000 characters." },
  { name: "hannah_status", input: "none", output: "status, provider, ready", note: "Reads /api/health. Never returns keys." },
  { name: "hannah_models", input: "none", output: "provider, defaultModel, models[]", note: "Lists configured model IDs only." },
  { name: "hannah_research", input: "question (3–2,000 chars), mode: quick | latest | deep | academic | compare", output: "answer with [n] citations, sources[], couldNotRead[], unconfirmed[], methodology[]", note: "Searches and reads the web; citations are checked against what was read. Can take a few minutes." },
  { name: "hannah_create_document", input: "request, format: pptx | pdf | docx | xlsx, material (optional text to write from)", output: "name, format, bytes, summary, checks[], and the file as an embedded resource", note: "The file is validated before it is returned." },
];

const mcpHosts = [
  { name: "Claude Desktop", file: "macOS: ~/Library/Application Support/Claude/claude_desktop_config.json · Windows: %APPDATA%\\Claude\\claude_desktop_config.json" },
  { name: "Cursor", file: "~/.cursor/mcp.json (all projects) or .cursor/mcp.json (one project)" },
  { name: "VS Code", file: ".vscode/mcp.json in your workspace. VS Code uses a \"servers\" key instead of \"mcpServers\" (example below)." },
];

const webhookEvents = [
  { name: "reminder.fired", detail: "A reminder you set in HANNAH went off." },
  { name: "team.completed", detail: "An agent team finished its task." },
  { name: "budget.exceeded", detail: "Today's estimated spend passed your daily budget." },
  { name: "approval.requested", detail: "One of your devices is waiting for your approval. Forward it to a phone service (ntfy, Pushover, Slack) to hear about it when HANNAH isn't open." },
  { name: "workflow.completed", detail: "A server workflow run finished. workflow.failed when it didn't; workflow.notification from a workflow's Notify step." },
  { name: "robot.mission.finished", detail: "A robot mission ended, with its verified outcome. robot.plan.finished for a multi-step plan." },
  { name: "robot.alert", detail: "A robot reported something that needs attention, such as low battery or a fault." },
  { name: "device.alert", detail: "A device behind a hub reported an alert. device.rule.fired when a hub automation acted." },
  { name: "workforce.approval.requested", detail: "An AI teammate is waiting for your approval." },
  { name: "workforce.task.completed", detail: "An AI teammate finished a task." },
  { name: "workforce.task.failed", detail: "An AI teammate's task failed or was blocked, with the reason." },
  { name: "webhook.test", detail: "Sent when you press Test in Settings." },
];

const webhookHeaders = [
  ["X-HANNAH-Event", "The event name, for example reminder.fired."],
  ["X-HANNAH-Delivery", "A unique ID for this delivery. Use it to ignore duplicates."],
  ["X-HANNAH-Timestamp", "Unix time in seconds when it was sent."],
  ["X-HANNAH-Signature", "sha256= followed by the HMAC-SHA256 of \"<timestamp>.<body>\" with your webhook secret."],
];

const envVars = [
  { group: "Access", items: [
    { name: "HANNAH_API_TOKEN", detail: "Operator token for every /api and /v1 route. 32–512 characters. Leave it unset to serve only visitors who bring their own key." },
    { name: "CLIENT_ORIGIN", detail: "Comma-separated origins allowed to call the API from a browser." },
    { name: "HANNAH_PUBLIC_URL", detail: "Public base URL used in the A2A agent card and the calendar and email sign-in redirect. Defaults to the request's host." },
  ] },
  { group: "Providers", items: [
    { name: "GROQ_API_KEY", detail: "Default cloud provider key for operator requests. Keep it server-side." },
    { name: "OLLAMA_BASE_URL", detail: "Ollama endpoint. Plain HTTP is allowed only on loopback." },
  ] },
  { group: "MCP", items: [
    { name: "MCP_ENABLED", detail: "The streamable HTTP MCP endpoint at /mcp is on by default; false turns it off." },
    { name: "MCP_API_TOKEN", detail: "Optional extra Bearer token for /mcp that acts as the operator. 32+ characters." },
    { name: "HANNAH_API_URL", detail: "API base the MCP server calls. Defaults to http://127.0.0.1:$PORT." },
    { name: "HANNAH_MCP_SERVERS", detail: "JSON list of outside MCP servers whose tools HANNAH may use." },
  ] },
  { group: "Accounts and data", items: [
    { name: "DATABASE_URL", detail: "Postgres (Supabase, Neon or any host) or a sqlite: URL. Turns on accounts and sync." },
    { name: "HANNAH_VAULT_KEY", detail: "Encrypts saved provider keys and calendar and email sign-ins. Back it up: losing it makes them unreadable." },
  ] },
  { group: "Calendar and email", items: [
    { name: "GOOGLE_CLIENT_ID", detail: "With GOOGLE_CLIENT_SECRET, turns on Google Calendar and Gmail. Redirect URI: <public URL>/api/account/connections/google/callback." },
    { name: "MICROSOFT_CLIENT_ID", detail: "With MICROSOFT_CLIENT_SECRET, turns on Outlook Calendar and Mail. Same redirect path ending in /microsoft/callback." },
    { name: "MICROSOFT_TENANT", detail: "Which Microsoft accounts may sign in: common (default), organizations, consumers or your tenant ID." },
  ] },
  { group: "Rate limits", items: [
    { name: "HANNAH_RATE_LIMIT_WINDOW_MS", detail: "Window length. Default 60,000 (one minute), maximum one hour." },
    { name: "HANNAH_RATE_LIMIT_CHAT_MAX", detail: "Chat, A2A and voice requests per window. Default 30." },
    { name: "HANNAH_RATE_LIMIT_AGENT_MAX", detail: "Agent and agent-team requests per window. Default 60." },
    { name: "HANNAH_RATE_LIMIT_DESKTOP_MAX", detail: "Desktop-control requests per window. Default 20." },
  ] },
];

const limits = [
  ["30 / min", "Chat, A2A and voice"],
  ["60 / min", "Agent steps and agent teams"],
  ["20 / min", "Desktop control (operator)"],
  ["12 MB", "Largest JSON request body"],
];

const errors = [
  { code: "400", meaning: "The request body is invalid: wrong mode, too many messages, empty content or an unknown model. The error field says which." },
  { code: "401", meaning: "No usable credential. reason is credentials-required, byok-required or session-invalid (a revoked hk_ key or an expired session)." },
  { code: "403", meaning: "reason: operator-only. The route needs the operator token, not a visitor key or developer key." },
  { code: "429", meaning: "Rate limit reached. Wait for the Retry-After seconds. RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset come with every limited response." },
  { code: "502", meaning: "The AI provider failed or returned an empty reply. Retry, or pick another model." },
  { code: "503", meaning: "A feature isn't configured on this server, such as API authentication, the database or a voice provider." },
];

const troubleshooting = [
  { title: "No HANNAH tools appear in my MCP host", body: "Check that the host supports MCP, that the path to server/mcp-stdio.mjs is absolute, and that the API server is running at HANNAH_API_URL. Restart the host after editing its config." },
  { title: "hannah_status works but hannah_chat returns 401", body: "Set HANNAH_API_TOKEN in the MCP server's env block to the operator token or an hk_ developer key. Remote hosts send the same key as a Bearer token to /mcp." },
  { title: "The OpenAI SDK gets 401 with my Groq key", body: "SDKs send their key as a Bearer token, and Bearer accepts only hk_ developer keys or the operator token. Use an hk_ key, or send the Groq key in an X-Groq-API-Key header with no Authorization header." },
  { title: "Empty replies or 502", body: "Run hannah_status or GET /api/health to see whether the provider is ready, and check the model ID with /api/models." },
  { title: "Context too large", body: "Keep the MCP prompt plus history under 16,000 characters. /api/chat accepts at most 40 messages of 4,000 characters each." },
  { title: "Webhook signature doesn't match", body: "Sign the raw body exactly as received, before any JSON parsing, and reject timestamps older than five minutes." },
];

const sections = [
  { id: "live-check", label: "Test this server" },
  { id: "overview", label: "Overview" },
  { id: "authentication", label: "Authentication" },
  { id: "rest-api", label: "REST API" },
  { id: "openai", label: "OpenAI-compatible API" },
  { id: "mcp-server", label: "MCP server" },
  { id: "mcp-client", label: "Tools from MCP servers" },
  { id: "a2a", label: "Agent2Agent (A2A)" },
  { id: "webhooks", label: "Webhooks" },
  { id: "database", label: "Your database" },
  { id: "environment", label: "Server environment" },
  { id: "limits", label: "Limits and errors" },
  { id: "troubleshooting", label: "Troubleshooting" },
] as const;
type SectionId = (typeof sections)[number]["id"];

const overviewCards: Array<{ id: SectionId; title: string; body: string; icon: typeof Code2 }> = [
  { id: "rest-api", title: "REST API", body: "Chat, agent steps, voice and model discovery from your own app.", icon: Code2 },
  { id: "openai", title: "OpenAI-compatible API", body: "Point an OpenAI SDK at /v1, with streaming and automatic routing.", icon: Workflow },
  { id: "mcp-server", title: "MCP server", body: "Give Claude Desktop, Cursor, VS Code and other MCP hosts a HANNAH tool.", icon: Network },
  { id: "mcp-client", title: "Tools from MCP servers", body: "Let HANNAH call tools on MCP servers you run, with your approval.", icon: Unplug },
  { id: "a2a", title: "Agent2Agent (A2A)", body: "Other agents read HANNAH's agent card and message her over JSON-RPC.", icon: Bot },
  { id: "webhooks", title: "Webhooks", body: "Signed HTTP calls when reminders fire, teams finish or budgets run out.", icon: Webhook },
  { id: "database", title: "Your database", body: "Accounts, encrypted keys and memories in Postgres, Supabase, Neon or SQLite.", icon: Database },
];

const card = "scroll-mt-44 lg:scroll-mt-28 rounded-[1.75rem] border border-slate-200/80 bg-white p-5 shadow-[0_24px_60px_-34px_rgba(38,44,74,0.35)] sm:p-7";
const subheading = "text-xs font-bold uppercase tracking-[0.14em] text-slate-500";
const methodColor: Record<Method, string> = {
  GET: "text-emerald-700", POST: "text-violet-700", PUT: "text-amber-800", DELETE: "text-rose-700",
};

function C({ children }: { children: ReactNode }) {
  return <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-slate-800">{children}</code>;
}

function AccessBadge({ access }: { access: Access }) {
  const item = accessLabels[access];
  return <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${item.className}`}>{item.label}</span>;
}

function EndpointList({ items }: { items: Endpoint[] }) {
  return (
    <ul className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200">
      {items.map((endpoint) => (
        <li key={endpoint.method + endpoint.path} className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
          <span className={`w-14 shrink-0 pt-0.5 font-mono text-[11px] font-bold ${methodColor[endpoint.method]}`}>{endpoint.method}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><code className="break-all font-mono text-[13px] text-ink">{endpoint.path}</code><AccessBadge access={endpoint.access} /></div>
            <p className="mt-1 text-[13px] leading-5 text-slate-600">{endpoint.description}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function SimpleTable({ caption, columns, rows, mono = false }: { caption: string; columns: [string, string]; rows: string[][]; mono?: boolean }) {
  return (
    <div className="mt-5 overflow-x-auto rounded-2xl border border-slate-200">
      <table className="w-full text-left text-[13px]">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-slate-50 text-xs text-slate-600"><tr><th scope="col" className="px-4 py-2.5 font-semibold">{columns[0]}</th><th scope="col" className="px-4 py-2.5 font-semibold">{columns[1]}</th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map(([name, value]) => (
            <tr key={name} className="align-top">
              <th scope="row" className={`whitespace-nowrap px-4 py-3 font-semibold text-ink ${mono ? "font-mono text-[12px]" : ""}`}>{name}</th>
              <td className="min-w-[14rem] px-4 py-3 text-slate-600">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type CodeBlockProps = { label: string; code: string; id: string; copied: string; onCopy: (value: string, key: string) => void };

function CodeBlock({ label, code, id, copied, onCopy }: CodeBlockProps) {
  return (
    <div className="mt-4 min-w-0 overflow-hidden rounded-2xl border border-slate-800 bg-slate-950">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
        <span className="inline-flex min-w-0 items-center gap-2 truncate text-[11px] font-semibold text-slate-300"><Terminal size={12} className="shrink-0" /> {label}</span>
        <button type="button" onClick={() => onCopy(code, id)} className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-white/10 hover:text-white" aria-label={`Copy: ${label}`}>
          {copied === id ? <Check size={12} /> : <Clipboard size={12} />}{copied === id ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-6 text-slate-100"><code>{code}</code></pre>
    </div>
  );
}

function SectionHeader({ icon: Icon, eyebrow, title, children }: { icon: typeof Code2; eyebrow: string; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-sky-100 bg-sky-50 text-sky-700"><Icon size={19} /></span>
      <div className="min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-sky-700">{eyebrow}</p>
        <h2 className="mt-1 font-['Manrope'] text-xl font-semibold text-ink">{title}</h2>
        <div className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{children}</div>
      </div>
    </div>
  );
}

export default function IntegrationsPage({ onBack }: IntegrationsPageProps) {
  const [copied, setCopied] = useState("");
  const [active, setActive] = useState<SectionId>("live-check");
  const scroller = useRef<HTMLElement>(null);

  const copy = async (value: string, key: string) => {
    try {
      if (!(await copyText(value))) throw new Error("Copy failed.");
      setCopied(key);
      window.setTimeout(() => setCopied((current) => current === key ? "" : current), 1800);
    } catch {
      setCopied("");
    }
  };

  // Highlight the section being read in the "On this page" navigation.
  useEffect(() => {
    const root = scroller.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActive(visible.target.id as SectionId);
    }, { root, rootMargin: "-25% 0px -65% 0px" });
    sections.forEach(({ id }) => {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    });
    return () => observer.disconnect();
  }, []);

  const goTo = (id: SectionId) => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    setActive(id);
  };

  const codeProps = { copied, onCopy: (value: string, key: string) => void copy(value, key) };

  const navButton = (section: (typeof sections)[number], variant: "chip" | "rail") => (
    <button
      type="button"
      onClick={() => goTo(section.id)}
      aria-current={active === section.id ? "location" : undefined}
      className={variant === "chip"
        ? `whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition ${active === section.id ? "bg-ink text-white" : "text-slate-700 hover:bg-slate-100"}`
        : `-ml-px block w-full border-l-2 py-1.5 pl-3 text-left text-[13px] transition ${active === section.id ? "border-sky-600 font-semibold text-ink" : "border-transparent text-slate-600 hover:border-slate-300 hover:text-ink"}`}
    >{section.label}</button>
  );

  return (
    <main ref={scroller} className="landing-page deck-shell-bg relative h-[100dvh] overflow-y-auto text-ink selection:bg-sky-200/40">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
        <div className="mx-auto flex h-[4.25rem] max-w-6xl items-center justify-between gap-3 px-4 sm:px-8">
          <button type="button" onClick={onBack} className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 hover:text-ink">
            <ArrowLeft size={15} /> Back
          </button>
          <span className="flex items-center gap-2 text-sm font-semibold text-ink"><span className="logo-ring" aria-hidden="true" /> HANNAH Integrations</span>
          <a href={settingsHref} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 hover:text-ink" aria-label="Settings"><Settings2 size={15} /><span className="hidden sm:inline">Settings</span></a>
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-6xl px-4 pb-20 pt-10 sm:px-8 sm:pt-14">
        <div className="max-w-3xl">
          <p className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-sky-700"><PlugZap size={13} /> Connect HANNAH</p>
          <h1 className="display-title mt-4 text-[clamp(2.2rem,5.5vw,3.75rem)]">Bring HANNAH into your workflow.</h1>
          <p className="mt-5 max-w-2xl text-[15px] leading-7 text-slate-600">Call HANNAH from your own code, add her to an MCP host or another agent, and get notified when things happen. This guide covers every way in, the credential each one needs, and the limits that apply.</p>
          <dl className="mt-6 grid gap-2 text-sm sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">API base URL</dt>
              <dd className="mt-1 break-all font-mono text-[13px] text-ink">{apiRoot}</dd>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">OpenAI-compatible base URL</dt>
              <dd className="mt-1 break-all font-mono text-[13px] text-ink">{serverRoot}/v1</dd>
            </div>
          </dl>
        </div>

        <nav aria-label="Sections" className="sticky top-[calc(4.25rem+env(safe-area-inset-top))] z-30 -mx-4 mt-8 overflow-x-auto border-y border-slate-200 bg-white/95 px-4 py-2 backdrop-blur lg:hidden">
          <ul className="flex w-max gap-1.5">
            {sections.map((section) => <li key={section.id}>{navButton(section, "chip")}</li>)}
          </ul>
        </nav>

        <div className="mt-8 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
          <aside className="hidden lg:block">
            <nav aria-label="On this page" className="sticky top-[6.5rem]">
              <p className="px-3 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-600">On this page</p>
              <ul className="mt-3 space-y-0.5 border-l border-slate-200">
                {sections.map((section) => <li key={section.id}>{navButton(section, "rail")}</li>)}
              </ul>
            </nav>
          </aside>

          <div className="min-w-0 space-y-6">
            <IntegrationCheck serverRoot={serverRoot} settingsHref={settingsHref} />
            <section id="overview" className={card} aria-labelledby="overview-title">
              <h2 id="overview-title" className="font-['Manrope'] text-xl font-semibold text-ink">Choose an integration</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Everything goes through the same HANNAH server, with the same credentials, rate limits and daily budget. No integration gives an outside app HANNAH's device tools, files or desktop control.</p>
              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {overviewCards.map(({ id, title, body, icon: Icon }) => (
                  <button key={id} type="button" onClick={() => goTo(id)} className="flex flex-col items-start rounded-2xl border border-slate-200 bg-slate-50/70 p-4 text-left transition hover:border-sky-300 hover:bg-white">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-sky-700 ring-1 ring-slate-200"><Icon size={17} /></span>
                    <span className="mt-3 text-sm font-semibold text-ink">{title}</span>
                    <span className="mt-1 text-[13px] leading-5 text-slate-600">{body}</span>
                  </button>
                ))}
              </div>
            </section>

            <section id="authentication" className={card}>
              <SectionHeader icon={KeyRound} eyebrow="Before you start" title="Authentication">
                Send one credential with each request. Which one you need depends on who you are and which route you call. Never put keys in frontend code, public URLs or a repository.
              </SectionHeader>
              <div className="mt-5 grid gap-3 md:grid-cols-2">
                {credentials.map((item) => (
                  <div key={item.name} className="rounded-2xl border border-slate-200 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-ink">{item.name}</h3>
                      <AccessBadge access={item.access} />
                    </div>
                    <p className="mt-2 break-all font-mono text-[12px] text-slate-800">{item.header}</p>
                    <p className="mt-2 text-[13px] leading-5 text-slate-600">{item.use}</p>
                    <p className="mt-2 text-xs text-slate-500"><span className="font-semibold text-slate-700">Get it:</span> {item.where}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <span className="font-semibold text-slate-700">Badges below:</span>
                {(Object.keys(accessLabels) as Access[]).map((access) => <AccessBadge key={access} access={access} />)}
                <span>“Your key” routes also accept a developer key or the operator token.</span>
              </div>
            </section>

            <section id="rest-api" className={card}>
              <SectionHeader icon={Code2} eyebrow="HTTP and JSON" title="REST API">
                HANNAH's own API, the one the apps use. Paths are relative to <C>{serverRoot}</C>. Request bodies are JSON, up to 12 MB, unless noted.
              </SectionHeader>
              <div className="mt-6 space-y-5">
                {endpointGroups.map((group) => (
                  <div key={group.title}>
                    <h3 className={subheading}>{group.title}</h3>
                    <EndpointList items={group.items} />
                  </div>
                ))}
              </div>
              <div className="grid gap-x-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <CodeBlock label="Send a message with your Groq key" code={chatExample} id="chat" {...codeProps} />
                <CodeBlock label="Response" code={chatResponse} id="chat-response" {...codeProps} />
              </div>
              <p className="mt-4 text-[13px] leading-6 text-slate-600"><C>mode</C> is <C>cloud</C> or <C>ollama</C>. On-device models run inside the app and never reach this API. Set <C>provider</C> and <C>model</C> to pin a model, or leave them out to use the server default.</p>
            </section>

            <section id="openai" className={card}>
              <SectionHeader icon={Workflow} eyebrow="Drop-in for OpenAI SDKs" title="OpenAI-compatible API">
                Point any OpenAI client at <C>{serverRoot}/v1</C>. Tool calls follow OpenAI's format: HANNAH returns them for your code to run and never runs them on this route.
              </SectionHeader>
              <div className="mt-5"><EndpointList items={v1Endpoints} /></div>
              <div className="mt-5 grid gap-3 md:grid-cols-3">
                <div className="rounded-2xl border border-slate-200 p-4"><h3 className="text-sm font-semibold text-ink">Model IDs</h3><p className="mt-1 text-[13px] leading-5 text-slate-600"><C>provider/model</C>, such as <C>groq/openai/gpt-oss-120b</C>, or a bare model ID for the default provider.</p></div>
                <div className="rounded-2xl border border-slate-200 p-4"><h3 className="text-sm font-semibold text-ink">hannah-auto</h3><p className="mt-1 text-[13px] leading-5 text-slate-600">HANNAH picks the provider and model by how complex the request is, across every provider the credential can use.</p></div>
                <div className="rounded-2xl border border-slate-200 p-4"><h3 className="text-sm font-semibold text-ink">Routing modes</h3><p className="mt-1 text-[13px] leading-5 text-slate-600">With hannah-auto, add <C>{`"hannah": {"routing": {"mode": …}}`}</C>: quality, balanced, budget, fastest, private, offline or custom. Private and offline never reach a hosted provider.</p></div>
              </div>
              <div className="grid gap-x-4 xl:grid-cols-2">
                <CodeBlock label="JavaScript, streaming" code={openaiJs} id="openai-js" {...codeProps} />
                <CodeBlock label="Python" code={openaiPython} id="openai-py" {...codeProps} />
              </div>
              <CodeBlock label="curl with your Groq key and a routing mode" code={openaiByok} id="openai-curl" {...codeProps} />
              <p className="mt-4 text-[13px] leading-6 text-slate-600">OpenAI SDKs send their key as <C>Authorization: Bearer</C>, which accepts an <C>hk_</C> developer key or the operator token. To use your own Groq key instead, send it in <C>X-Groq-API-Key</C> with no Authorization header, as in the curl example.</p>
            </section>

            <section id="mcp-server" className={card}>
              <SectionHeader icon={Network} eyebrow="HANNAH as a tool" title="MCP server">
                Any host that supports the Model Context Protocol can call HANNAH. Run it locally over stdio for desktop apps and IDEs, or over HTTPS for remote hosts.
              </SectionHeader>

              <h3 className={`${subheading} mt-6`}>Tools</h3>
              <div className="mt-2 grid gap-3 lg:grid-cols-3">
                {mcpTools.map((tool) => (
                  <div key={tool.name} className="rounded-2xl border border-slate-200 p-4">
                    <code className="font-mono text-[13px] font-semibold text-violet-700">{tool.name}</code>
                    <dl className="mt-2 space-y-1.5 text-[13px] leading-5 text-slate-600">
                      <div><dt className="inline font-semibold text-slate-800">Input: </dt><dd className="inline">{tool.input}</dd></div>
                      <div><dt className="inline font-semibold text-slate-800">Output: </dt><dd className="inline">{tool.output}</dd></div>
                    </dl>
                    <p className="mt-2 text-xs leading-5 text-slate-500">{tool.note}</p>
                  </div>
                ))}
              </div>

              <h3 className={`${subheading} mt-7`}>Local setup (stdio)</h3>
              <ol className="mt-3 space-y-2.5 text-sm leading-6 text-slate-700">
                {[
                  <>Install and start the API: <C>npm install --prefix server</C>, then <C>npm run dev:server</C>. It listens on port 3001.</>,
                  <>Copy the config below and replace the path with the full path to <C>server/mcp-stdio.mjs</C> in your copy of HANNAH.</>,
                  <>Set <C>HANNAH_API_TOKEN</C> to the operator token or an <C>hk_</C> developer key, add the config to your host, and restart the host.</>,
                ].map((step, index) => (
                  <li key={index} className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-100 text-xs font-bold text-sky-800">{index + 1}</span><span className="min-w-0">{step}</span></li>
                ))}
              </ol>
              <CodeBlock label="Claude Desktop, Cursor and most hosts" code={localMcpConfig} id="mcp-local" {...codeProps} />
              <SimpleTable caption="Where each MCP host keeps its configuration" columns={["Host", "Config file"]} rows={mcpHosts.map((host) => [host.name, host.file])} />
              <CodeBlock label=".vscode/mcp.json (VS Code)" code={vscodeMcpConfig} id="mcp-vscode" {...codeProps} />
              <p className="mt-3 text-xs leading-5 text-slate-500">Other hosts use similar JSON. Check your host's documentation for the file location and key names.</p>

              <h3 className={`${subheading} mt-7`}>Remote setup (streamable HTTP)</h3>
              <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-amber-900"><ShieldCheck size={15} /> Remote MCP endpoint</p>
                <p className="mt-2 break-all font-mono text-[13px] text-ink">{mcpEndpoint}</p>
                <p className="mt-2 text-[13px] leading-6 text-amber-950">Send the credential you already have: an <C>hk_</C> developer key or the operator token as a Bearer token, or your Groq key in <C>X-Groq-API-Key</C>. Each tool call runs with that credential's limits and budget. Keep the key in your host's secret settings, never in browser code. Operators can turn the endpoint off with <C>MCP_ENABLED=false</C>. “Test this server now” at the top of this page checks it.</p>
              </div>
              <CodeBlock label="Remote MCP host" code={remoteMcpConfig} id="mcp-remote" {...codeProps} />
            </section>

            <div id="mcp-client" className="scroll-mt-44 lg:scroll-mt-28 [&>section]:mt-0">
              <McpServersCard />
            </div>

            <section id="a2a" className={card}>
              <SectionHeader icon={Bot} eyebrow="Agent to agent" title="Agent2Agent (A2A)">
                Other agents can find HANNAH from her public agent card and send her messages with JSON-RPC 2.0. Each message is answered on its own, with no stored history and no access to device tools, memories or account data.
              </SectionHeader>
              <div className="mt-5"><EndpointList items={a2aEndpoints} /></div>
              <div className="grid gap-x-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <CodeBlock label="message/send" code={a2aExample} id="a2a" {...codeProps} />
                <CodeBlock label="Response" code={a2aResponse} id="a2a-response" {...codeProps} />
              </div>
              <p className="mt-4 text-[13px] leading-6 text-slate-600">Authenticate with an <C>hk_</C> developer key or the operator token as a Bearer token, or with <C>X-Groq-API-Key</C>. A2A calls share the chat rate limit and count toward the same daily budget.</p>
            </section>

            <section id="webhooks" className={card}>
              <SectionHeader icon={Webhook} eyebrow="Outgoing events" title="Webhooks">
                HANNAH sends a signed POST to your URL when something happens in your account. Add up to five in <a href={settingsHref} className="font-medium text-sky-700 underline decoration-sky-300 underline-offset-2 hover:text-sky-900">Settings → Account → Webhooks</a>; you need to be signed in.
              </SectionHeader>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {webhookEvents.map((event) => (
                  <div key={event.name} className="rounded-2xl border border-slate-200 p-4">
                    <code className="font-mono text-[13px] font-semibold text-violet-700">{event.name}</code>
                    <p className="mt-1 text-[13px] leading-5 text-slate-600">{event.detail}</p>
                  </div>
                ))}
              </div>
              <SimpleTable caption="Headers sent with every webhook" columns={["Header", "Value"]} rows={webhookHeaders} mono />
              <CodeBlock label="Verify a delivery (Node.js)" code={webhookVerify} id="webhook-verify" {...codeProps} />
              <p className="mt-4 text-[13px] leading-6 text-slate-600">URLs must be public <C>https</C> addresses. Private and local network addresses are refused, and so are usernames or passwords in the URL. Verify the signature instead.</p>
            </section>

            <div id="database" className="scroll-mt-44 lg:scroll-mt-28 [&>section]:mt-0">
              <DatabaseIntegration />
            </div>

            <section id="environment" className={card}>
              <SectionHeader icon={Server} eyebrow="For server operators" title="Server environment">
                Set these in <C>server/.env</C> or your host's secret store, then restart the server. <C>server/.env.example</C> lists every option.
              </SectionHeader>
              <div className="mt-5 grid gap-5 lg:grid-cols-2">
                {envVars.map((group) => (
                  <div key={group.group}>
                    <h3 className={subheading}>{group.group}</h3>
                    <ul className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200">
                      {group.items.map((item) => (
                        <li key={item.name} className="px-4 py-3">
                          <code className="break-all font-mono text-[12px] font-semibold text-ink">{item.name}</code>
                          <p className="mt-1 text-[13px] leading-5 text-slate-600">{item.detail}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>

            <section id="limits" className={card}>
              <SectionHeader icon={ShieldCheck} eyebrow="What to expect" title="Limits and errors">
                Rate limits are counted per credential: each Groq key, account and operator token has its own window. Every error response is JSON with an <C>error</C> message, and some add a <C>reason</C>.
              </SectionHeader>
              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {limits.map(([value, label]) => (
                  <div key={label} className="rounded-2xl border border-slate-200 p-4">
                    <p className="font-['Manrope'] text-2xl font-semibold text-ink">{value}</p>
                    <p className="mt-1 text-[13px] text-slate-600">{label}</p>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-slate-500">These are the defaults. Operators can change them with the HANNAH_RATE_LIMIT_* variables.</p>
              <SimpleTable caption="HTTP status codes the API returns" columns={["Status", "Meaning"]} rows={errors.map((item) => [item.code, item.meaning])} mono />
            </section>

            <section id="troubleshooting" className={card}>
              <SectionHeader icon={LifeBuoy} eyebrow="When something's off" title="Troubleshooting">
                The most common problems, and how to fix them.
              </SectionHeader>
              <div className="mt-5 space-y-2">
                {troubleshooting.map((item) => (
                  <details key={item.title} className="group rounded-2xl border border-slate-200 px-4 py-3 open:bg-slate-50/70">
                    <summary className="flex cursor-pointer list-none items-start gap-2 text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden"><span aria-hidden="true" className="text-slate-500 transition group-open:rotate-90">›</span>{item.title}</summary>
                    <p className="mt-2 pl-4 text-[13px] leading-6 text-slate-600">{item.body}</p>
                  </details>
                ))}
              </div>
            </section>

            <div className="flex flex-col gap-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div className="flex items-start gap-3"><ShieldCheck size={16} className="mt-0.5 shrink-0 text-emerald-700" /><p className="max-w-3xl text-[13px] leading-6 text-emerald-950">Integrations get conversation, status and model information only. They can't control HANNAH's device tools, read her files or memories, or act in your desktop apps. The app or host you connect applies its own permissions on top.</p></div>
              <a href="https://modelcontextprotocol.io/" target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1.5 text-[13px] font-semibold text-emerald-800 transition hover:text-emerald-950">MCP overview <ArrowUpRight size={13} /></a>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
