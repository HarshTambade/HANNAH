import { useEffect, useState, type FormEvent } from "react";
import { Check, Clipboard, Database, PlugZap } from "lucide-react";
import { apiFetch, apiUrl, getApiAccessToken } from "../services/api";
import { databaseLabel } from "../services/Account";

type DbStatus = { database: { configured: boolean; ready: boolean; kind: string | null; provider: string | null; schemaVersion?: number; error?: string }; vault: boolean };

const PRESETS = [
  {
    id: "supabase",
    label: "Supabase",
    steps: [
      "Create a project at supabase.com (the free plan works).",
      "Open Project Settings → Database → Connection string, and copy the URI. On Vercel or other serverless hosts use the pooler (port 6543).",
      "Replace [YOUR-PASSWORD] with your database password.",
    ],
    url: "postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres",
    note: "If the connection fails with a certificate error, add DATABASE_SSL=no-verify or set DATABASE_CA_CERT to Supabase's CA certificate.",
  },
  {
    id: "neon",
    label: "Neon",
    steps: [
      "Create a project at neon.tech (the free plan works).",
      "On the dashboard, open Connect, turn on Connection pooling and copy the connection string.",
    ],
    url: "postgresql://<user>:<password>@ep-<name>-pooler.<region>.aws.neon.tech/neondb?sslmode=require",
    note: "Neon suspends idle databases, so the first request after a pause can take a second or two.",
  },
  {
    id: "postgres",
    label: "Any Postgres",
    steps: [
      "Use any Postgres 13 or newer: Amazon RDS, Cloud SQL, Azure, Railway, Render, Aiven, or your own server.",
      "Create a database and a user that can create tables in it.",
      "Allow connections from your HANNAH server's IP address.",
    ],
    url: "postgresql://<user>:<password>@<host>:5432/<database>?sslmode=require",
    note: "Remote hosts are reached over verified TLS by default. Plain connections are only used for localhost.",
  },
  {
    id: "sqlite",
    label: "SQLite",
    steps: [
      "For one self-hosted server or the desktop app. Needs Node.js 22.5 or newer.",
      "Not for Vercel or other serverless hosts: their disks are temporary, so data would be lost.",
    ],
    url: "sqlite:./data/hannah.db",
    note: "Back up the file (and the -wal file next to it) like any other database.",
  },
] as const;

export default function DatabaseIntegration() {
  const [status, setStatus] = useState<DbStatus | null>(null);
  const [preset, setPreset] = useState<(typeof PRESETS)[number]["id"]>("supabase");
  const [copied, setCopied] = useState(false);
  const [testUrl, setTestUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    apiFetch(apiUrl("/api/db/status"), { signal: AbortSignal.timeout(8_000) }).then((response) => (response.ok ? response.json() : null)).then(setStatus).catch(() => setStatus(null));
  }, []);

  const active = PRESETS.find((item) => item.id === preset)!;
  const envBlock = `DATABASE_URL=${active.url}\nHANNAH_VAULT_KEY=<run: openssl rand -hex 32>`;
  const operator = Boolean(getApiAccessToken());

  const test = async (event: FormEvent) => {
    event.preventDefault();
    setTesting(true);
    setResult(null);
    try {
      const response = await apiFetch(apiUrl("/api/db/test"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: testUrl.trim() }), signal: AbortSignal.timeout(20_000) });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; provider?: string; latencyMs?: number };
      if (response.status === 401 || response.status === 403) setResult({ ok: false, text: "Only the server operator can test connections. Connect with the operator access token first." });
      else if (body.ok) setResult({ ok: true, text: `Connected to ${databaseLabel(body.provider)} in ${body.latencyMs} ms. Add it to your server environment and redeploy.` });
      else setResult({ ok: false, text: body.error || "The connection failed." });
    } catch {
      setResult({ ok: false, text: "Couldn't reach the HANNAH server." });
    } finally {
      setTesting(false);
    }
  };

  const db = status?.database;
  return (
    <section className="mt-6 rounded-[1.75rem] border-[6px] border-white/90 bg-white p-5 shadow-[0_24px_60px_-30px_rgba(38,44,74,0.35)] sm:p-7" aria-label="Database">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-100 bg-emerald-50 text-emerald-600"><Database size={19} /></span>
          <div>
            <h2 className="font-['Manrope'] text-lg font-semibold text-ink">Database</h2>
            <p className="mt-1 max-w-2xl text-[13px] leading-5 text-slate-500">Bring your own database to turn on accounts, encrypted key storage, sync across devices, developer API keys and budgets that survive restarts. Without one, HANNAH keeps everything on each device.</p>
          </div>
        </div>
        <span className={`pill-badge ${db?.ready ? "" : "opacity-80"}`} role="status">
          <span className={`h-2 w-2 rounded-full ${db?.ready ? "bg-emerald-500" : db?.configured ? "bg-amber-500" : "bg-slate-300"}`} aria-hidden="true" />
          {!status ? "Checking…" : db?.ready ? `Connected · ${databaseLabel(db.provider)} · schema v${db.schemaVersion}` : db?.configured ? "Configured but unreachable" : "Not connected"}
        </span>
      </div>
      {db?.configured && !db.ready && db.error && <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">{db.error}</p>}
      {db?.ready && !status?.vault && <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">Accounts work, but saved provider keys are off until HANNAH_VAULT_KEY is set.</p>}

      <div className="mt-5 flex flex-wrap gap-2" role="tablist" aria-label="Database provider">
        {PRESETS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={preset === item.id} onClick={() => { setPreset(item.id); setCopied(false); }} className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${preset === item.id ? "bg-ink text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>{item.label}</button>
        ))}
      </div>

      <div className="mt-4 grid gap-5 lg:grid-cols-2">
        <div>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-6 text-slate-600">
            {active.steps.map((step) => <li key={step}>{step}</li>)}
            <li>Add these to the server environment (<code className="font-mono text-xs">server/.env</code>, or your host's environment variables) and redeploy. Tables are created automatically.</li>
          </ol>
          <p className="mt-3 text-xs leading-5 text-slate-500">{active.note}</p>
        </div>
        <div>
          <div className="relative rounded-2xl bg-slate-950 p-4 pr-12 font-mono text-xs leading-6 text-slate-100">
            <pre className="whitespace-pre-wrap break-all">{envBlock}</pre>
            <button type="button" aria-label="Copy environment variables" onClick={() => { void navigator.clipboard?.writeText(envBlock).then(() => setCopied(true)); }} className="absolute right-3 top-3 rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white">{copied ? <Check size={14} /> : <Clipboard size={14} />}</button>
          </div>
          <p className="mt-2 text-xs text-slate-500">Keep HANNAH_VAULT_KEY secret and backed up: losing it makes saved provider keys unreadable. Then run <code className="font-mono">npm run db:check</code> in <code className="font-mono">server/</code> to confirm.</p>
        </div>
      </div>

      <form onSubmit={test} className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <label htmlFor="db-test-url" className="flex items-center gap-1.5 text-xs font-semibold text-slate-700"><PlugZap size={13} /> Test a connection string</label>
        <p className="mt-1 text-xs text-slate-500">{operator ? "Sent to your HANNAH server to try a connection, then discarded. Nothing is saved." : "Available to the server operator: connect with the access token to use it."}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input id="db-test-url" type="password" value={testUrl} onChange={(event) => setTestUrl(event.target.value)} placeholder={active.url} autoComplete="off" spellCheck={false} disabled={!operator} className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-ink outline-none focus:border-emerald-400 disabled:opacity-60" />
          <button type="submit" disabled={!operator || !testUrl.trim() || testing} className="btn-outline">{testing ? "Testing…" : "Test connection"}</button>
        </div>
        {result && <p role="status" className={`mt-2 text-xs ${result.ok ? "text-emerald-700" : "text-rose-700"}`}>{result.text}</p>}
      </form>
    </section>
  );
}
