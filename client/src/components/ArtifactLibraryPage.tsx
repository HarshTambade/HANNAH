/**
 * Artifact Library — the files your teammates deliver: reports, documents,
 * spreadsheets, logs, screenshots, source changes. Each artifact is a
 * versioned record; downloads point at the server's copy of the content.
 */
import { useCallback, useEffect, useState } from "react";
import { FileDown, FileSearch2, RefreshCw, Trash2, Upload, X, Zap } from "lucide-react";
import workforce, { type Artifact } from "../services/Workforce";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const Notice = ({ tone = "slate", role, children }: { tone?: "slate" | "rose" | "amber" | "emerald"; role?: "alert" | "status"; children: React.ReactNode }) => {
  const tones = { slate: "border-slate-200 bg-slate-50 text-slate-800", rose: "border-rose-200 bg-rose-50 text-rose-900", amber: "border-amber-200 bg-amber-50 text-amber-900", emerald: "border-emerald-200 bg-emerald-50 text-emerald-900" };
  return <p className={`rounded-lg border px-3 py-2 text-sm ${tones[tone]}`} role={role || (tone === "rose" ? "alert" : "status")}>{children}</p>;
};
const formatTime = (at: number | null | undefined) => (at ? new Date(at).toLocaleString() : "never");
const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const TEXTISH = /\.(txt|md|csv|json|yaml|yml|xml|html|tsx?|jsx?|py|sh)$/i;

function NewArtifact({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState({ name: "", type: "text/plain", content: "", source: "" });
  const [error, setError] = useState("");
  const submit = async () => {
    setError("");
    try {
      await workforce.artifactCreate({ name: form.name.trim(), type: form.type, content: form.content, source: form.source || undefined });
      onDone();
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); }
  };
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-2 sm:p-6" data-testid="new-artifact-modal">
      <div className={card} style={{ maxWidth: "34rem" }}>
        <h2 className="text-base font-semibold text-ink">Add artifact</h2>
        <div className="mt-3 grid gap-3">
          <label className="block"><span className={heading}>Name</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className={input} required /></label>
          <label className="block"><span className={heading}>Type</span><input value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })} className={input} placeholder="text/plain, application/pdf, …" /></label>
          <label className="block"><span className={heading}>Content</span><textarea value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} className={input} rows={6} /></label>
          <label className="block"><span className={heading}>Source</span><input value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} className={input} placeholder="Task id, teammate name, or a URL" /></label>
        </div>
        {error && <Notice tone="rose">{error}</Notice>}
        <div className="mt-4 flex justify-end gap-2"><button type="button" className={button} onClick={onCancel}>Cancel</button><button type="button" className={primary} onClick={() => void submit()}><Zap size={13} /> Add artifact</button></div>
      </div>
    </div>
  );
}

/** Artifact detail: preview, versions, source, download. */
function ArtifactPanel({ artifact, onClose, refresh }: { artifact: Artifact; onClose: () => void; refresh: () => Promise<void> }) {
  const [versions, setVersions] = useState<Artifact[]>([]);
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [data, contentText] = await Promise.all([workforce.artifact(artifact.id), workforce.artifactContent(artifact.id).catch(() => "")]);
      setVersions(data.versions);
      setContent(contentText);
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); } finally { setLoading(false); }
  }, [artifact.id]);
  useEffect(() => { void load(); }, [load]);
  const remove = async () => { setError(""); workforce.artifactDelete(artifact.id).then(() => { onClose(); void refresh(); }).catch((e: unknown) => setError(e instanceof Error ? e.message : "That didn't work.")); };
  const addVersion = async () => { setError(""); try { await workforce.artifactVersion(artifact.id, { content: content || "", source: artifact.source }); setError("New version created."); await load(); } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); } };
  return (
    <section className={card} data-testid={`artifact-${artifact.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div><h2 className="text-base font-semibold text-slate-900 flex items-center gap-2"><FileSearch2 size={16} /> {artifact.name}</h2><p className="mt-1 text-xs text-slate-500">{formatBytes(artifact.size)} · v{artifact.version} · {formatTime(artifact.createdAt)} · {artifact.source || "manual"}</p></div>
        <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X size={16} /></button>
      </div>
      {loading && <p className="mt-3 text-sm text-slate-500">Loading…</p>}
      {!loading && (TEXTISH.test(artifact.name) || artifact.type.startsWith("text/")) && (
        <pre className="mt-4 max-h-96 overflow-auto rounded-xl bg-slate-50 p-3 text-[11px] text-slate-700" data-testid="artifact-content">{content || "(empty or binary)"}</pre>
      )}
      <div className="mt-4">
        <span className={heading}>Versions</span>
        <ul className="mt-2 space-y-1">
          {versions.map((version) => <li key={version.id} className="text-xs text-slate-600">v{version.version} — {version.source || "manual"} · {formatTime(version.createdAt)} · {formatBytes(version.size)}</li>)}
          {!versions.length && <li className="text-xs text-slate-500">This artifact has no separate version records (it is the latest of its family).</li>}
        </ul>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <a href={artifact.downloadUrl} className="btn-outline"><FileDown size={13} /> Download</a>
        <button type="button" onClick={() => void addVersion()} className={button} disabled={!content}><Upload size={13} /> Add version</button>
        <button type="button" onClick={remove} className="btn-ghost text-rose-600"><Trash2 size={13} /> Delete</button>
      </div>
      {error && <Notice tone="rose">{error}</Notice>}
    </section>
  );
}

export default function ArtifactLibraryPage() {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [detail, setDetail] = useState<Artifact | null>(null);
  const [newArtifact, setNewArtifact] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => { setArtifacts((await workforce.artifacts()).artifacts); }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(e instanceof Error ? e.message : "That didn't work."));
    const timer = setInterval(() => void workforce.artifacts().then((data) => setArtifacts(data.artifacts)).catch(() => undefined), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <main className="mx-auto max-w-6xl px-3 pb-12 pt-5 sm:px-6 sm:pt-8" data-testid="artifact-library">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display-title text-[clamp(2.2rem,5vw,3.5rem)]">Artifact Library</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">The files your teammates deliver — reports, documents, spreadsheets, logs and screenshots. Every artifact is versioned and downloadable; updates create new versions of the same record.</p>
        </div>
        <button type="button" onClick={() => setNewArtifact(true)} className={primary} data-testid="new-artifact"><Zap size={16} /> Add artifact</button>
      </div>
      {error && <Notice tone="rose" role="alert">{error}</Notice>}

      <section className="mb-6" aria-label="Artifacts">
        <div className="mb-3 flex items-center justify-between"><span className={heading}>Artifacts</span><button type="button" onClick={() => void refresh()} className="btn-outline text-xs"><RefreshCw size={12} /> Refresh</button></div>
        {artifacts.length === 0 ? (
          <div className={card} data-testid="artifacts-empty"><p className="text-sm text-slate-500">No artifacts yet. Teammates produce them when they finish work; you can add your own.</p></div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {artifacts.map((artifact) => (
              <li key={artifact.id} className={card} data-testid={`artifact-${artifact.id}`}>
                <div className="flex items-center gap-2"><FileSearch2 size={18} className="text-slate-900" /><h3 className="text-sm font-semibold text-slate-900 truncate">{artifact.name}</h3></div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">v{artifact.version}</span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">{formatBytes(artifact.size)}</span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">{formatTime(artifact.createdAt)}</span>
                  {artifact.source ? <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">{artifact.source}</span> : null}
                  {artifact.botId ? <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">by a teammate</span> : null}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" onClick={() => setDetail(artifact)} className={button} data-testid={`artifact-open-${artifact.id}`}><FileDown size={13} /> Open</button>
                  <a href={artifact.downloadUrl} className={button}><FileDown size={13} /> Download</a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail && <ArtifactPanel artifact={detail} onClose={() => setDetail(null)} refresh={refresh} />}
      {newArtifact && <NewArtifact onDone={() => { setNewArtifact(false); void refresh(); }} onCancel={() => setNewArtifact(false)} />}
    </main>
  );
}
