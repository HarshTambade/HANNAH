import { useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, Copy, KeyRound, Loader2, MinusCircle, Play, XCircle } from "lucide-react";
import { apiFetch, apiUrl, getApiAccessToken, getSessionGroqKey, hasApiSession, isAccountSession, isGuestSession } from "../services/api";
import { Account } from "../services/Account";
import { copyText } from "../services/clipboard";

type Outcome = "idle" | "running" | "ok" | "failed" | "skipped";
type Row = { id: string; name: string; what: string; outcome: Outcome; detail: string; ms?: number };

const ROWS: Array<Pick<Row, "id" | "name" | "what">> = [
  { id: "server", name: "Server", what: "GET /api/health" },
  { id: "credential", name: "Your credential", what: "GET /api/models" },
  { id: "openai", name: "OpenAI-compatible API", what: "GET /v1/models" },
  { id: "chat", name: "A real reply", what: "POST /v1/chat/completions (hannah-auto)" },
  { id: "mcp", name: "MCP server", what: "POST /mcp (initialize, tools/list)" },
  { id: "a2a", name: "Agent2Agent", what: "GET /api/a2a/agent-card" },
  { id: "webhooks", name: "Webhooks", what: "GET /api/account/webhooks" },
];

const icons: Record<Outcome, typeof CheckCircle2> = { idle: CircleDashed, running: Loader2, ok: CheckCircle2, failed: XCircle, skipped: MinusCircle };
const tones: Record<Outcome, string> = { idle: "text-slate-400", running: "text-sky-600 animate-spin", ok: "text-emerald-600", failed: "text-rose-600", skipped: "text-slate-400" };

class Skip extends Error {}

async function readJson(response: Response) {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : (body.error as { message?: string } | undefined)?.message || `HTTP ${response.status}`);
  return body;
}

/** One MCP JSON-RPC call; the answer comes as JSON or as a one-event stream. */
async function mcpCall(root: string, method: string, params: Record<string, unknown>, id: number) {
  const response = await apiFetch(`${root}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  // Off (MCP_ENABLED=false), or a host that doesn't route /mcp to the server: either way it isn't an MCP endpoint.
  if (response.status === 404 || /^\s*</.test(text)) throw new Skip("Off on this server (MCP_ENABLED=false).");
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try { message = (JSON.parse(text) as { error?: string }).error || message; } catch { /* keep the status */ }
    throw new Error(message);
  }
  const data = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).pop() || text;
  const body = JSON.parse(data) as { result?: Record<string, unknown>; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message || "The MCP server reported an error.");
  return body.result || {};
}

/**
 * Runs each integration against this server with the credential this browser
 * already holds, and shows what came back. Nothing here is a sample: every row
 * is a request that was just made.
 */
export default function IntegrationCheck({ serverRoot, settingsHref }: { serverRoot: string; settingsHref: string }) {
  const [rows, setRows] = useState<Row[]>(() => ROWS.map((row) => ({ ...row, outcome: "idle", detail: "Not checked yet." })));
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [account, setAccount] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [newKey, setNewKey] = useState("");
  const [keyError, setKeyError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => { setConnected(hasApiSession()); setAccount(isAccountSession()); }, []);
  const who = getApiAccessToken() ? "the operator token" : account ? "your account" : isGuestSession() ? "your Groq key" : "";

  const set = (id: string, patch: Partial<Row>) => setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const step = async (id: string, work: () => Promise<string>) => {
    set(id, { outcome: "running", detail: "Checking…", ms: undefined });
    const started = performance.now();
    try {
      const detail = await work();
      set(id, { outcome: "ok", detail, ms: Math.round(performance.now() - started) });
    } catch (error) {
      set(id, { outcome: error instanceof Skip ? "skipped" : "failed", detail: error instanceof Error ? error.message : "It didn't answer.", ms: Math.round(performance.now() - started) });
    }
  };
  const needCredential = () => { if (!hasApiSession()) throw new Skip("Connect first: sign in, or add your Groq key, then run this again."); };
  /** A key remembered on this browser lives in a cookie only /api receives, so this page can't send it to /v1 or /mcp. */
  const needSendableCredential = () => {
    needCredential();
    if (isGuestSession() && !getSessionGroqKey()) throw new Skip("Your key is remembered in a cookie that only /api receives, so this page can't send it here. From your own code, send it in X-Groq-API-Key.");
  };

  const run = async () => {
    setRunning(true);
    await step("server", async () => {
      const body = await readJson(await fetch(apiUrl("/api/health"), { signal: AbortSignal.timeout(15_000) }));
      if (body.status !== "ok") throw new Error("The server didn't report ok.");
      return `Up. Default provider: ${String(body.provider || "unknown")}${body.ready ? ", ready" : ", no operator model configured (your own key still works)"}.`;
    });
    await step("credential", async () => {
      needCredential();
      const body = await readJson(await apiFetch(apiUrl("/api/models"), { signal: AbortSignal.timeout(20_000) }));
      const models = Array.isArray(body.models) ? body.models.length : 0;
      return `Accepted (${who}). ${models} chat model${models === 1 ? "" : "s"} available from ${String(body.provider || "the provider")}.`;
    });
    await step("openai", async () => {
      needSendableCredential();
      const body = await readJson(await apiFetch(`${serverRoot}/v1/models`, { signal: AbortSignal.timeout(20_000) }));
      const list = Array.isArray(body.data) ? body.data as Array<{ id: string }> : [];
      return `${list.length} model IDs, including ${list.slice(0, 2).map((model) => model.id).join(" and ") || "none"}.`;
    });
    await step("chat", async () => {
      needSendableCredential();
      const body = await readJson(await apiFetch(`${serverRoot}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "hannah-auto", max_tokens: 400, messages: [{ role: "user", content: "Reply with the single word: ready" }] }),
        signal: AbortSignal.timeout(60_000),
      }));
      const reply = (body.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]?.message?.content?.trim();
      if (!reply) throw new Error("The model returned an empty reply.");
      return `“${reply.slice(0, 80)}” from ${String(body.model || "the routed model")}.`;
    });
    await step("mcp", async () => {
      needSendableCredential();
      await mcpCall(serverRoot, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hannah-integrations-check", version: "1.0.0" } }, 1);
      const listed = await mcpCall(serverRoot, "tools/list", {}, 2);
      const tools = Array.isArray(listed.tools) ? listed.tools as Array<{ name: string }> : [];
      return `${tools.length} tools: ${tools.map((tool) => tool.name).join(", ")}.`;
    });
    await step("a2a", async () => {
      const body = await readJson(await fetch(apiUrl("/api/a2a/agent-card"), { signal: AbortSignal.timeout(15_000) }));
      if (typeof body.name !== "string" || typeof body.url !== "string") throw new Error("The server didn't return an agent card.");
      const skills = Array.isArray(body.skills) ? body.skills.length : 0;
      return `Agent card for “${String(body.name)}”, protocol ${String(body.protocolVersion)}, ${skills} skill${skills === 1 ? "" : "s"}.`;
    });
    await step("webhooks", async () => {
      if (!isAccountSession()) throw new Skip("Webhooks belong to an account. Sign in to add one in Settings → Account.");
      const body = await Account.webhooks();
      return `${body.webhooks.length} webhook${body.webhooks.length === 1 ? "" : "s"} set up; ${body.events.length} event types available.`;
    });
    setRunning(false);
  };

  const createKey = async () => {
    setKeyError("");
    try {
      const created = await Account.createApiKey(keyName.trim() || "Integrations page");
      setNewKey(created.key);
      setKeyName("");
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : "Couldn't create a key.");
    }
  };

  return (
    <section id="live-check" aria-labelledby="live-check-title" className="scroll-mt-44 rounded-[1.75rem] border border-slate-200/80 bg-white p-5 shadow-[0_24px_60px_-34px_rgba(38,44,74,0.35)] sm:p-7 lg:scroll-mt-28">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="live-check-title" className="font-['Manrope'] text-xl font-semibold text-ink">Test this server now</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Runs each integration against <span className="break-all font-mono text-[13px] text-ink">{serverRoot}</span> with {who || "the credential you connect with"} and shows what came back. The reply check sends one short message to a model.</p>
        </div>
        <button type="button" onClick={() => void run()} disabled={running} className="btn-primary inline-flex shrink-0 items-center gap-2 disabled:cursor-wait">
          {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} {running ? "Checking…" : "Run the checks"}
        </button>
      </div>
      {!connected && <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-5 text-amber-900">You're not connected in this browser, so only the public checks will run. <a href={settingsHref} className="font-semibold underline">Connect or sign in</a>, then come back.</p>}

      <ul className="mt-5 divide-y divide-slate-100 rounded-2xl border border-slate-200" aria-live="polite">
        {rows.map((row) => {
          const Icon = icons[row.outcome];
          return (
            <li key={row.id} className="flex items-start gap-3 px-4 py-3" data-check={row.id} data-outcome={row.outcome}>
              <Icon size={17} className={`mt-0.5 shrink-0 ${tones[row.outcome]}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-ink">{row.name} <span className="font-mono text-[11px] font-normal text-slate-500">{row.what}</span></p>
                <p className={`mt-0.5 break-words text-[13px] leading-5 ${row.outcome === "failed" ? "text-rose-700" : "text-slate-600"}`}><span className="sr-only">{row.outcome === "ok" ? "Passed: " : row.outcome === "failed" ? "Failed: " : row.outcome === "skipped" ? "Skipped: " : ""}</span>{row.detail}</p>
              </div>
              {row.ms !== undefined && row.outcome !== "skipped" && <span className="shrink-0 font-mono text-[11px] text-slate-400">{row.ms} ms</span>}
            </li>
          );
        })}
      </ul>

      <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink"><KeyRound size={15} className="text-sky-700" /> Developer key for scripts, SDKs and MCP hosts</p>
        {account ? (
          <>
            <p className="mt-1 text-[13px] leading-5 text-slate-600">Create an <span className="font-mono">hk_</span> key here. It's shown once; revoke it any time in Settings → Account.</p>
            <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void createKey(); }}>
              <label htmlFor="new-key-name" className="sr-only">Key name</label>
              <input id="new-key-name" value={keyName} onChange={(event) => setKeyName(event.target.value.slice(0, 60))} placeholder="Name, for example: my laptop" className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-sky-400" />
              <button type="submit" className="btn-outline">Create key</button>
            </form>
            {keyError && <p role="alert" className="mt-2 text-[13px] text-rose-700">{keyError}</p>}
            {newKey && (
              <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-[13px] font-semibold text-emerald-900">Copy it now. It won't be shown again.</p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-lg bg-white px-2.5 py-2 font-mono text-[12px] text-ink">{newKey}</code>
                  <button type="button" onClick={() => void copyText(newKey).then((ok) => { setCopied(ok); window.setTimeout(() => setCopied(false), 1800); })} className="btn-outline inline-flex shrink-0 items-center gap-1.5"><Copy size={13} /> {copied ? "Copied" : "Copy"}</button>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="mt-1 text-[13px] leading-5 text-slate-600">Developer keys belong to an account on this server. <a href={settingsHref} className="font-semibold text-sky-700 underline">Sign in or create an account</a> to make one, or send your own Groq key in <span className="font-mono">X-Groq-API-Key</span> with no account at all.</p>
        )}
      </div>
    </section>
  );
}
