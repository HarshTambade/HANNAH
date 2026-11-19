import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ExternalLink, KeyRound, Link2, Plug, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { IS_WEBSITE, SITE_URL } from "../config/site";
import { apiUrl } from "../services/api";
import ChatChannels from "./ChatChannels";
import HostingSetup from "./HostingSetup";
import {
  CONNECTORS_EVENT, canSignIn, connect, disconnect, finishSignIn, isSignInReturn, listConnections, loadCatalog, refreshConnection,
  type CatalogEntry, type Connection,
} from "../services/Connectors";

const AUTH_LABEL = { oauth: "Sign in", none: "No sign-in", token: "Token" } as const;
const TONES = ["bg-sky-100 text-sky-800", "bg-violet-100 text-violet-800", "bg-emerald-100 text-emerald-800", "bg-amber-100 text-amber-800", "bg-rose-100 text-rose-800", "bg-cyan-100 text-cyan-800", "bg-indigo-100 text-indigo-800"];
const tone = (id: string) => TONES[[...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % TONES.length];
const initials = (name: string) => name.replace(/\(.*\)/, "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();

/** The connector directory: vendors' own MCP servers you connect with your own sign-in. */
export default function ConnectorsDirectory() {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [connections, setConnections] = useState<Connection[]>(listConnections);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [tokenFor, setTokenFor] = useState("");
  const [token, setToken] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customName, setCustomName] = useState("");
  // HANNAH's own hosting: offer the Vercel + Supabase setup while this server has no database.
  const [noDatabase, setNoDatabase] = useState(false);

  useEffect(() => {
    loadCatalog().then(setCatalog).catch(() => { setCatalog([]); setLoadError("Couldn't load the connector directory. Check your connection and reload."); });
    if (IS_WEBSITE) fetch(apiUrl("/api/db/status")).then((response) => response.json()).then((body: { database?: { configured?: boolean } }) => setNoDatabase(body.database?.configured === false)).catch(() => {});
    const update = () => setConnections(listConnections());
    window.addEventListener(CONNECTORS_EVENT, update);
    // Coming back from a service's sign-in page.
    if (isSignInReturn()) {
      setBusy("sign-in");
      finishSignIn()
        .then((connection) => setNotice({ ok: true, text: `${connection.name} is connected: ${connection.tools.length} tool${connection.tools.length === 1 ? "" : "s"}. HANNAH asks you before using any of them.` }))
        .catch((error: Error) => setNotice({ ok: false, text: error.message }))
        .finally(() => { setBusy(""); window.history.replaceState(null, "", "/marketplace"); });
    }
    return () => window.removeEventListener(CONNECTORS_EVENT, update);
  }, []);

  const connected = useMemo(() => new Map(connections.map((item) => [item.id, item])), [connections]);
  const categories = useMemo(() => ["All", "Connected", ...[...new Set((catalog || []).map((entry) => entry.category))].sort()], [catalog]);
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    return (catalog || []).filter((entry) => {
      if (category === "Connected" && !connected.has(entry.id)) return false;
      if (category !== "All" && category !== "Connected" && entry.category !== category) return false;
      return !words || `${entry.name} ${entry.description} ${entry.category}`.toLowerCase().includes(words);
    });
  }, [catalog, category, connected, query]);
  const customs = connections.filter((item) => item.custom);

  const run = async (id: string, action: () => Promise<string | null>) => {
    setBusy(id);
    setNotice(null);
    try {
      const text = await action();
      if (text) setNotice({ ok: true, text });
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "That didn't work." });
    } finally {
      setBusy("");
    }
  };
  const start = (entry: { id: string; name: string; url: string; auth?: CatalogEntry["auth"]; custom?: boolean }, withToken?: string) => run(entry.id, async () => {
    const result = await connect(entry, { token: withToken });
    if ("redirecting" in result) return null;
    setTokenFor("");
    setToken("");
    return `${entry.name} is connected: ${result.connected.tools.length} tool${result.connected.tools.length === 1 ? "" : "s"}. HANNAH asks you before using any of them.`;
  });
  const addCustom = (event: FormEvent) => {
    event.preventDefault();
    const url = customUrl.trim();
    let host = "";
    try { host = new URL(url).host; } catch { setNotice({ ok: false, text: "Enter the connector's full URL, starting with https://." }); return; }
    const id = `custom_${host.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`.slice(0, 40);
    void start({ id, name: customName.trim() || host, url, custom: true }).then(() => { setCustomUrl(""); setCustomName(""); });
  };

  const card = (entry: CatalogEntry | Connection, about?: CatalogEntry) => {
    const connection = connected.get(entry.id);
    const auth = about?.auth || connection?.auth || "oauth";
    const working = busy === entry.id;
    const signInHere = auth !== "oauth" || canSignIn();
    return (
      <li key={entry.id} className="flex flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
        <div className="flex items-start gap-3">
          {about?.icon
            ? <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white" aria-hidden="true"><img src={about.icon} alt="" width={24} height={24} loading="lazy" className="h-6 w-6 object-contain" /></span>
            : <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-bold ${tone(entry.id)}`} aria-hidden="true">{initials(entry.name)}</span>}
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-['Manrope'] text-sm font-semibold text-ink">{entry.name}</h3>
            <p className="text-[11px] text-slate-500">{about?.category || "Custom connector"} · {AUTH_LABEL[auth]}</p>
          </div>
          {connection && <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${connection.needsSignIn ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-700"}`}>{connection.needsSignIn ? "Sign in again" : "Connected"}</span>}
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-600">{about?.description || connection?.url}</p>
        {connection && !connection.needsSignIn && (
          <details className="mt-2 text-[11px] text-slate-500">
            <summary className="cursor-pointer">{connection.tools.length} tool{connection.tools.length === 1 ? "" : "s"}{connection.tools.some((tool) => tool.readOnly) ? ` · ${connection.tools.filter((tool) => tool.readOnly).length} read-only` : ""}</summary>
            <p className="mt-1 break-words font-mono">{connection.tools.map((tool) => tool.name).join(", ") || "None"}</p>
          </details>
        )}
        {tokenFor === entry.id && (
          <form className="mt-3" onSubmit={(event) => { event.preventDefault(); void start({ ...entry, auth: "token" }, token); }}>
            {about?.tokenHelp && <p className="text-[11px] leading-5 text-slate-500">{about.tokenHelp}</p>}
            <label htmlFor={`token-${entry.id}`} className="sr-only">{entry.name} token</label>
            <div className="mt-2 flex gap-2">
              <input id={`token-${entry.id}`} type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste the token" autoComplete="off" spellCheck={false} className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs outline-none focus:border-sky-400" />
              <button type="submit" disabled={!token.trim() || working} className="btn-outline">Save</button>
            </div>
          </form>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
          {!connection || connection.needsSignIn ? (
            signInHere ? (
              <button type="button" disabled={working || busy === "sign-in"} aria-label={`Connect ${entry.name}`} onClick={() => (auth === "token" ? setTokenFor(tokenFor === entry.id ? "" : entry.id) : void start({ ...entry, auth }))} className="btn-primary inline-flex items-center gap-1.5 !px-3.5 !py-2 text-xs">
                {auth === "token" ? <KeyRound size={13} /> : <Plug size={13} />} {working ? "Connecting…" : connection?.needsSignIn ? "Sign in again" : "Connect"}
              </button>
            ) : (
              <a href={`${SITE_URL}/marketplace`} target="_blank" rel="noreferrer" className="btn-outline inline-flex items-center gap-1.5 !px-3.5 !py-2 text-xs">Connect on the website <ExternalLink size={12} /></a>
            )
          ) : (
            <>
              <button type="button" disabled={working} aria-label={`Refresh ${entry.name}`} onClick={() => void run(entry.id, async () => { const updated = await refreshConnection(entry.id); return updated ? `${entry.name}: ${updated.tools.length} tools.` : null; })} className="btn-ghost inline-flex items-center gap-1 !px-2.5 !py-2 text-xs"><RefreshCw size={12} /> Refresh</button>
              <button type="button" aria-label={`Disconnect ${entry.name}`} onClick={() => { disconnect(entry.id); setNotice({ ok: true, text: `${entry.name} disconnected. Its tokens were removed from this browser.` }); }} className="btn-ghost inline-flex items-center gap-1 !px-2.5 !py-2 text-xs text-rose-600"><Trash2 size={12} /> Disconnect</button>
            </>
          )}
          {about?.docs && <a href={about.docs} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-ink">About <ExternalLink size={11} /></a>}
        </div>
      </li>
    );
  };

  return (
    <section aria-label="Connectors" className="mt-8">
      <div className="flex flex-col gap-4 rounded-2xl border border-sky-100 bg-sky-50 p-4 sm:flex-row sm:items-start sm:p-5">
        <ShieldCheck size={17} className="mt-0.5 shrink-0 text-sky-700" />
        <p className="text-xs leading-5 text-slate-600">
          Each connector is the service's own MCP server, and you connect with your own account. Your tokens stay in this browser; HANNAH's server stores none of them. HANNAH asks you before every action a connector takes. Asana, Box, Figma, HubSpot and Slack aren't listed: their servers accept only apps they've approved. Vercel, Intercom and Square appear only on a local install, because they register local addresses only.
        </p>
      </div>

      {noDatabase && (
        <details className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
          <summary className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-ink"><img src="/connectors/vercel.png" alt="" className="h-4 w-4" /><img src="/connectors/supabase.png" alt="" className="h-4 w-4" /> HANNAH's own hosting: connect it to Vercel and Supabase</summary>
          <div className="mt-3"><HostingSetup /></div>
        </details>
      )}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1 sm:max-w-md">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search connectors" aria-label="Search connectors" className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-xs text-ink outline-none placeholder:text-slate-400 focus:border-sky-300" />
        </div>
        <p className="text-[11px] text-slate-500">{catalog ? `${catalog.length} connectors · ${connections.length} connected` : "Loading…"}</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Connector categories">
        {categories.map((name) => (
          <button key={name} type="button" aria-pressed={category === name} onClick={() => setCategory(name)} className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition ${category === name ? "border-sky-200 bg-sky-50 text-sky-800" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}>{name}</button>
        ))}
      </div>

      {(notice || busy === "sign-in") && <p role="status" className={`mt-4 rounded-xl px-3 py-2 text-xs ${busy === "sign-in" ? "bg-slate-50 text-slate-600" : notice?.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>{busy === "sign-in" ? "Finishing the sign-in…" : notice?.text}</p>}
      {loadError && <p role="alert" className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">{loadError}</p>}

      <ul className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Connector directory">
        {shown.map((entry) => card(entry, entry))}
        {(category === "All" || category === "Connected") && customs.filter((item) => !query.trim() || `${item.name} ${item.url}`.toLowerCase().includes(query.trim().toLowerCase())).map((item) => card(item))}
      </ul>
      {catalog && !shown.length && !(category === "Connected" && customs.length) && <p className="mt-5 rounded-2xl border border-slate-200 bg-white px-5 py-10 text-center text-xs text-slate-500">{category === "Connected" ? "Nothing connected yet." : "No connectors match that search."}</p>}

      <ChatChannels />

      <form onSubmit={addCustom} className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-soft" aria-label="Add a custom connector">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-ink"><Link2 size={13} /> Add a custom connector</p>
        <p className="mt-1 text-[11px] leading-5 text-slate-500">Any remote MCP server (Streamable HTTP, https). HANNAH finds out how it signs in: no sign-in, or OAuth with self-registration.</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <label htmlFor="custom-connector-url" className="sr-only">Connector URL</label>
          <input id="custom-connector-url" value={customUrl} onChange={(event) => setCustomUrl(event.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} className="min-w-0 flex-[2] rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs outline-none focus:border-sky-400" />
          <label htmlFor="custom-connector-name" className="sr-only">Name (optional)</label>
          <input id="custom-connector-name" value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="Name (optional)" className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs outline-none focus:border-sky-400" />
          <button type="submit" disabled={!customUrl.trim() || Boolean(busy)} className="btn-outline">Add</button>
        </div>
      </form>
    </section>
  );
}
