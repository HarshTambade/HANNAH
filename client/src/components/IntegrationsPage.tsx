import { useState } from "react";
import {
  Aperture, ArrowLeft, ArrowUpRight, Check, Clipboard, Code2, KeyRound, Network,
  PlugZap, Server, ShieldCheck, Terminal,
} from "lucide-react";
import { apiUrl } from "../services/api";

type IntegrationsPageProps = { onBack: () => void };

const apiRoot = new URL(apiUrl("/api"), window.location.href).toString().replace(/\/$/, "");
const mcpEndpoint = new URL(apiUrl("/mcp"), window.location.href).toString();
const localMcpConfig = JSON.stringify({
  mcpServers: {
    hannah: {
      command: "node",
      args: ["/absolute/path/to/HANNAH/server/mcp-stdio.mjs"],
      env: { HANNAH_API_URL: "http://127.0.0.1:3001" },
    },
  },
}, null, 2);
const apiExample = `curl -X POST "${apiRoot}/chat" \\
  -H "Authorization: Bearer $HANNAH_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"mode":"cloud","provider":"groq","messages":[{"role":"user","content":"Hello, HANNAH!"}]}'`;

const endpoints = [
  { method: "GET", path: "/api/health", description: "Check that the HANNAH API is responding. The only endpoint that needs no token." },
  { method: "GET", path: "/api/providers", description: "List providers enabled by the server without exposing credentials." },
  { method: "GET", path: "/api/models?provider=groq", description: "Discover models available from the selected provider." },
  { method: "POST", path: "/api/chat", description: "Send a conversation and receive a reply with an emotion." },
  { method: "POST", path: "/api/agent", description: "Request one agent step with tools; the client validates and runs tools." },
];

export default function IntegrationsPage({ onBack }: IntegrationsPageProps) {
  const [copied, setCopied] = useState("");

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => current === key ? "" : current), 1800);
    } catch {
      setCopied("");
    }
  };

  return (
    <main className="landing-page relative h-[100dvh] overflow-y-auto bg-slate-50 text-ink selection:bg-brand-200/30">
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -left-40 top-32 h-[32rem] w-[32rem] rounded-full bg-indigo-600/[0.12] blur-[140px]" />
        <div className="absolute -right-40 top-[38rem] h-[32rem] w-[32rem] rounded-full bg-cyan-500/[0.08] blur-[150px]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/80 backdrop-blur-sm">
        <div className="mx-auto flex h-[4.25rem] max-w-6xl items-center justify-between px-5 sm:px-8">
          <button type="button" onClick={onBack} className="inline-flex items-center gap-2 text-xs font-medium text-slate-600 transition hover:text-ink">
            <ArrowLeft size={15} /> Back
          </button>
          <span className="flex items-center gap-2 font-['Manrope'] text-[13px] font-extrabold tracking-[0.2em] text-ink"><Aperture size={16} strokeWidth={1.7} /> HANNAH</span>
          <span className="w-12" aria-hidden="true" />
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-6xl px-5 pb-16 pt-12 sm:px-8 sm:pt-16">
        <div className="max-w-3xl">
          <p className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-brand-600"><PlugZap size={13} /> Connect HANNAH</p>
          <h1 className="mt-4 font-['Manrope'] text-4xl font-semibold tracking-[-0.055em] text-ink sm:text-5xl">Bring HANNAH into your workflow.</h1>
          <p className="mt-5 max-w-2xl text-sm leading-7 text-slate-500">Use the REST API from your own app, or connect an MCP-compatible host to chat with HANNAH and inspect available models.</p>
        </div>

        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          <section className="rounded-2xl border border-slate-100 bg-white p-5 sm:p-7 shadow-soft">
            <div className="flex items-start gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-100 bg-cyan-50 text-cyan-600"><Code2 size={19} /></span>
              <div>
                <h2 className="font-['Manrope'] text-lg font-semibold text-ink">REST API</h2>
                <p className="mt-1 text-[13px] leading-5 text-slate-400">Connect websites, automations, and custom apps to HANNAH’s API.</p>
              </div>
            </div>

            <div className="mt-6 space-y-2">
              {endpoints.map((endpoint) => (
                <div key={endpoint.path} className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-white px-3.5 py-3 sm:flex-row sm:items-center sm:gap-3 shadow-soft">
                  <span className={`w-11 shrink-0 font-mono text-[10px] font-bold ${endpoint.method === "GET" ? "text-emerald-600" : "text-violet-600"}`}>{endpoint.method}</span>
                  <div className="min-w-0 flex-1">
                    <code className="text-xs text-ink">{endpoint.path}</code>
                    <p className="mt-1 text-[11px] leading-4 text-slate-500">{endpoint.description}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-soft">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
                <span className="inline-flex items-center gap-2 text-[11px] font-bold text-slate-500"><Terminal size={12} /> Quick example</span>
                <button type="button" onClick={() => void copy(apiExample, "api")} className="inline-flex items-center gap-1.5 text-[11px] text-slate-600 transition hover:text-ink" aria-label="Copy API example">
                  {copied === "api" ? <Check size={12} /> : <Clipboard size={12} />}{copied === "api" ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="overflow-x-auto p-4 text-[11px] leading-5 text-slate-600"><code>{apiExample}</code></pre>
            </div>

            <p className="mt-4 flex items-start gap-2 text-[11px] leading-5 text-slate-500"><KeyRound size={13} className="mt-0.5 shrink-0 text-brand-600" />Groq is the default. You may send a session key with X-Groq-API-Key, or configure other provider keys on your server. Never put keys in frontend source code or public URLs.</p>
          </section>

          <section className="rounded-2xl border border-slate-100 bg-white p-5 sm:p-7 shadow-soft">
            <div className="flex items-start gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-violet-100 bg-violet-50 text-violet-600"><Network size={19} /></span>
              <div>
                <h2 className="font-['Manrope'] text-lg font-semibold text-ink">MCP integrations</h2>
                <p className="mt-1 text-[13px] leading-5 text-slate-500">Expose HANNAH to a desktop, IDE, or other MCP-capable host.</p>
              </div>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              {[
                { name: "hannah_chat", detail: "Chat with optional recent context." },
                { name: "hannah_status", detail: "Check service and provider status." },
                { name: "hannah_models", detail: "List configured model IDs." },
              ].map((tool) => (
                <div key={tool.name} className="rounded-lg border border-slate-100 bg-white p-3 shadow-soft">
                  <code className="text-[11px] font-semibold text-violet-600">{tool.name}</code>
                  <p className="mt-2 text-[11px] leading-4 text-slate-500">{tool.detail}</p>
                </div>
              ))}
            </div>

            <div className="mt-5 rounded-2xl border border-slate-200 bg-white shadow-soft">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <span className="inline-flex items-center gap-2 text-[11px] font-bold text-slate-500"><Server size={12} /> Local desktop / IDE setup</span>
                <button type="button" onClick={() => void copy(localMcpConfig, "mcp")} className="inline-flex items-center gap-1.5 text-[11px] text-slate-600 transition hover:text-ink" aria-label="Copy local MCP configuration">
                  {copied === "mcp" ? <Check size={12} /> : <Clipboard size={12} />}{copied === "mcp" ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="overflow-x-auto p-4 text-[11px] leading-5 text-slate-600"><code>{localMcpConfig}</code></pre>
            </div>
            <ol className="mt-4 space-y-2 text-[11px] leading-5 text-slate-400">
              <li><span className="mr-2 font-mono text-violet-600">01</span>Run `npm install --prefix server` and start the API with `npm run dev:server`.</li>
              <li><span className="mr-2 font-mono text-violet-600">02</span>Replace the example path with the full path to this project’s `server/mcp-stdio.mjs`.</li>
              <li><span className="mr-2 font-mono text-violet-600">03</span>Add the JSON to your MCP host settings and restart that host.</li>
            </ol>

            <div className="mt-5 rounded-xl border border-amber-100 bg-amber-50 p-4 shadow-soft">
              <p className="flex items-center gap-2 text-xs font-bold text-amber-600"><ShieldCheck size={13} /> Remote MCP endpoint</p>
              <p className="mt-2 break-all font-mono text-[11px] text-ink">{mcpEndpoint}</p>
              <p className="mt-2 text-[11px] leading-5 text-slate-500">For remote hosts, enable `MCP_ENABLED=true` and set a server-side `MCP_API_TOKEN` (32+ characters). Send it as a Bearer token from the host’s secret settings. Keep it out of this app and all browser code.</p>
            </div>
          </section>
        </div>

        <section className="mt-6 grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-100 bg-white p-5 sm:p-7 shadow-soft">
            <h2 className="font-['Manrope'] text-lg font-semibold text-ink">Tools and limits</h2>
            <p className="mt-1 text-[13px] leading-5 text-slate-500">Every tool is read-only or conversational. HANNAH MCP never runs device tools, files, desktop control, or billing actions.</p>
            <div className="mt-5 space-y-2">
              {[
                { name: "hannah_chat", input: "prompt, history (max 12, 16,000 chars), mode (cloud or ollama), model", output: "reply, emotion", note: "Calls the configured AI provider and may incur provider usage." },
                { name: "hannah_status", input: "none", output: "status, provider, ready", note: "Checks /api/health without exposing keys." },
                { name: "hannah_models", input: "none", output: "provider, defaultModel, models", note: "Lists configured model IDs only." },
              ].map((tool) => (
                <div key={tool.name} className="rounded-lg border border-slate-100 bg-white p-4 shadow-soft">
                  <code className="text-xs font-semibold text-violet-600">{tool.name}</code>
                  <p className="mt-2 text-[11px] leading-5 text-slate-500"><span className="font-bold text-slate-600">Input:</span> {tool.input}</p>
                  <p className="mt-1 text-[11px] leading-5 text-slate-500"><span className="font-bold text-slate-600">Output:</span> {tool.output}</p>
                  <p className="mt-1 text-[11px] leading-5 text-slate-500">{tool.note}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-100 bg-white p-5 sm:p-7 shadow-soft">
            <h2 className="font-['Manrope'] text-lg font-semibold text-ink">Server environment</h2>
            <p className="mt-1 text-[13px] leading-5 text-slate-500">Set these in <code className="rounded bg-slate-100 px-1 font-mono text-xs text-brand-600">server/.env</code> or your hosting secret store.</p>
            <div className="mt-5 space-y-2">
              {[
                { name: "HANNAH_API_TOKEN", detail: "Required by all /api routes except /api/health. 32–512 characters." },
                { name: "HANNAH_API_URL", detail: "Base URL used by the MCP server. Defaults to http://127.0.0.1:$PORT." },
                { name: "MCP_ENABLED", detail: "Set to true to mount the HTTP MCP endpoint at /mcp." },
                { name: "MCP_API_TOKEN", detail: "Bearer token for remote MCP hosts. 32+ characters." },
                { name: "GROQ_API_KEY", detail: "Default cloud provider key. Keep server-side." },
                { name: "OLLAMA_BASE_URL", detail: "Local or remote Ollama endpoint. Plain HTTP is allowed only on loopback." },
              ].map((item) => (
                <div key={item.name} className="rounded-lg border border-slate-100 bg-white px-3.5 py-3 shadow-soft">
                  <code className="text-[11px] font-semibold text-brand-600">{item.name}</code>
                  <p className="mt-1 text-[11px] leading-4 text-slate-500">{item.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mt-6 grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-100 bg-white p-5 sm:p-7 shadow-soft">
            <h2 className="font-['Manrope'] text-lg font-semibold text-ink">Host setup examples</h2>
            <p className="mt-1 text-[13px] leading-5 text-slate-500">Use the stdio command for local desktop or IDE hosts. Use the HTTPS endpoint for remote hosts.</p>
            <div className="mt-5 space-y-3">
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-soft">
                <p className="text-[11px] font-bold text-slate-600">Claude Desktop / Cursor / Windsurf</p>
                <pre className="mt-2 overflow-x-auto text-[11px] leading-5 text-slate-600"><code>{localMcpConfig}</code></pre>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-soft">
                <p className="text-[11px] font-bold text-slate-600">Remote HTTP host</p>
                <pre className="mt-2 overflow-x-auto text-[11px] leading-5 text-violet-50/80"><code>{`{
  "mcpServers": {
    "hannah": {
      "url": "${mcpEndpoint}",
      "headers": {
        "Authorization": "Bearer <MCP_API_TOKEN>"
      }
    }
  }
}`}</code></pre>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-100 bg-white p-5 sm:p-7 shadow-soft">
            <h2 className="font-['Manrope'] text-lg font-semibold text-ink">Troubleshooting and safety</h2>
            <ul className="mt-4 space-y-2 text-xs leading-5 text-slate-500">
              <li><span className="font-bold text-slate-600">No tools appear:</span> confirm the host supports MCP, the path to <code className="rounded bg-slate-100 px-1 font-mono text-[11px] text-brand-600">mcp-stdio.mjs</code> is absolute, and the API server is running.</li>
              <li><span className="font-bold text-slate-600">401 or 403:</span> set <code className="rounded bg-slate-100 px-1 font-mono text-[11px] text-brand-600">HANNAH_API_TOKEN</code> in the MCP process or send <code className="rounded bg-slate-100 px-1 font-mono text-[11px] text-brand-600">MCP_API_TOKEN</code> as a Bearer token for remote hosts.</li>
              <li><span className="font-bold text-slate-600">Empty replies:</span> check provider readiness with <code className="rounded bg-slate-100 px-1 font-mono text-[11px] text-brand-600">hannah_status</code> and verify the selected model exists.</li>
              <li><span className="font-bold text-slate-600">Context too large:</span> keep prompt plus history below 16,000 characters.</li>
              <li><span className="font-bold text-slate-600">Privacy:</span> MCP has no access to files, device tools, accounts, or desktop control. It only calls the HANNAH API.</li>
              <li><span className="font-bold text-slate-600">Billing:</span> cloud chat may incur provider usage. MCP does not expose subscriptions or checkout.</li>
            </ul>
          </div>
        </section>

        <div className="mt-6 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6 shadow-soft">
          <div className="flex items-start gap-3"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-emerald-200/80" /><p className="max-w-3xl text-xs leading-5 text-slate-500">MCP provides chat, status, and model listing only. It does not let another platform control HANNAH’s device tools or access her private app data. The receiving platform must support MCP and apply its own permissions.</p></div>
          <a href="https://modelcontextprotocol.io/" target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-brand-600 transition hover:text-brand-700">MCP overview <ArrowUpRight size={12} /></a>
        </div>
      </div>
    </main>
  );
}
