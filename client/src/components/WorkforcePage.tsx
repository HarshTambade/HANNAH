/**
 * AI Workforce (the teammates) — create, edit and manage your bots.
 *
 * Every control does a real server action through `services/Workforce.ts`.
 * Bot status, versions, templates, tasks, memories and events are the
 * server's records; they refresh on a timer and after every action.
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { Bot as BotIcon, Copy, Eye, Pause as PauseIcon, Pencil, Play as PlayIcon, Plus, RefreshCw, Upload, Users, X } from "lucide-react";
import workforce, { type Bot, type BotTemplate, type BotVersion, type Computer, type MemoryRecord, type Task, type WorkforceEvent } from "../services/Workforce";
import { ACCOUNT_EVENT, isAccountSession } from "../services/api";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const statusTones: Record<string, string> = {
  draft: "border-slate-200 bg-slate-100 text-slate-700",
  active: "border-emerald-200 bg-emerald-50 text-emerald-800",
  paused: "border-amber-200 bg-amber-50 text-amber-900",
  archived: "border-rose-200 bg-rose-50 text-rose-800",
};
const statusLabel: Record<string, string> = { draft: "Draft", active: "Active", paused: "Paused", archived: "Archived" };
const autonomyTones: Record<string, string> = {
  observe: "border-slate-200 bg-slate-100 text-slate-700",
  suggest: "border-blue-200 bg-blue-50 text-blue-800",
  approval: "border-amber-200 bg-amber-50 text-amber-900",
  scoped: "border-violet-200 bg-violet-50 text-violet-800",
  autonomous: "border-emerald-200 bg-emerald-50 text-emerald-800",
};
const autonomyLabel: Record<string, string> = {
  observe: "Observe only", suggest: "Suggest", approval: "Ask before acting", scoped: "Scoped autonomy", autonomous: "Autonomous",
};
const Notice = ({ tone = "slate", role, children }: { tone?: "slate" | "rose" | "amber" | "emerald"; role?: "alert" | "status"; children: React.ReactNode }) => {
  const tones = { slate: "border-slate-200 bg-slate-50 text-slate-800", rose: "border-rose-200 bg-rose-50 text-rose-900", amber: "border-amber-200 bg-amber-50 text-amber-900", emerald: "border-emerald-200 bg-emerald-50 text-emerald-900" };
  return <p className={`rounded-lg border px-3 py-2 text-sm ${tones[tone]}`} role={role || (tone === "rose" ? "alert" : "status")}>{children}</p>;
};
const textarea = "min-h-20 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900";

/** Textareas hold lists as one item per line. */
const toText = (value?: string[]) => (value ?? []).join("\n");
const toList = (text?: string) => String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

type FormDraft = {
  name: string; avatar: string; role: string; description: string; personality: string; instructions: string;
  responsibilities: string; skills: string; apps: string; tools: string;
  autonomy: string; visibility: string; memoryScopes: string[]; model: string; computerIds: string[];
};

function draftFromBot(bot: Bot): FormDraft {
  const scopes = (bot.memoryConfig?.scopes as string[] | undefined) || ["user", "bot"];
  const computerIds = (bot.computerAccess?.computerIds as string[] | undefined) || [];
  return {
    name: bot.name, avatar: bot.avatar || "", role: bot.role, description: bot.description || "",
    personality: bot.personality || "", instructions: bot.instructions || "",
    responsibilities: toText(bot.responsibilities), skills: toText(bot.skills), apps: toText(bot.apps),
    tools: toText(bot.tools), autonomy: bot.autonomy || "approval", visibility: bot.visibility || "private",
    memoryScopes: scopes.filter((scope) => ["user", "bot", "project", "team", "device"].includes(scope)),
    model: (bot.modelPrefs?.model as string) || "", computerIds,
  };
}

/** The form for creating or editing a teammate. Lists are line-based text. */
function ConfigForm({ draft, setDraft, onSave, onCancel, submitting }: {
  draft: FormDraft; setDraft: Dispatch<SetStateAction<FormDraft>> | ((value: SetStateAction<FormDraft> | null) => void); onSave: () => void; onCancel: () => void; submitting: boolean;
}) {
  const [computers, setComputers] = useState<Computer[]>([]);
  useEffect(() => { void workforce.computers().then((data) => setComputers(data.computers)).catch(() => setComputers([])); }, []);
  const toggleComputer = (id: string) => setDraft((value) => ({ ...value, computerIds: value.computerIds.includes(id) ? value.computerIds.filter((item) => item !== id) : [...value.computerIds, id] }));
  const toggleScope = (id: string) => setDraft((value) => ({ ...value, memoryScopes: value.memoryScopes.includes(id) ? value.memoryScopes.filter((scope) => scope !== id) : [...value.memoryScopes, id] }));
  const save = () => { if (draft.name.trim() && draft.role.trim()) onSave(); };
  return (
    <form className={card} onSubmit={(event) => { event.preventDefault(); save(); }}>
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">Configure your teammate</h2>
        <button type="button" onClick={onCancel} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Close teammate form"><X size={16} /></button>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block"><span className={heading}>Name</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className={input} required /></label>
        <label className="block"><span className={heading}>Avatar (lucide icon name)</span><input value={draft.avatar} onChange={(event) => setDraft({ ...draft, avatar: event.target.value })} className={input} placeholder="bot" /></label>
        <label className="block sm:col-span-2"><span className={heading}>Role</span><input value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} className={input} required placeholder="Research, engineering, …" /></label>
        <label className="block"><span className={heading}>Autonomy</span>
          <select value={draft.autonomy} onChange={(event) => setDraft({ ...draft, autonomy: event.target.value })} className={input}>
            {["observe", "suggest", "approval", "scoped", "autonomous"].map((level) => <option key={level} value={level}>{autonomyLabel[level]}</option>)}
          </select>
        </label>
        <label className="block"><span className={heading}>Visibility</span>
          <select value={draft.visibility} onChange={(event) => setDraft({ ...draft, visibility: event.target.value })} className={input}>
            <option value="private">Private — only you</option>
            <option value="team">Team — published to your team</option>
          </select>
        </label>
        <label className="block sm:col-span-2"><span className={heading}>Description</span><textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} className={textarea} rows={2} /></label>
        <label className="block sm:col-span-2"><span className={heading}>Personality</span><textarea value={draft.personality} onChange={(event) => setDraft({ ...draft, personality: event.target.value })} className={textarea} rows={2} /></label>
        <label className="block sm:col-span-2"><span className={heading}>Instructions (what it may do)</span><textarea value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} className={textarea} rows={4} /></label>
        <label className="block sm:col-span-2"><span className={heading}>Responsibilities (one per line)</span><textarea value={draft.responsibilities} onChange={(event) => setDraft({ ...draft, responsibilities: event.target.value })} className={textarea} rows={2} /></label>
        <label className="block sm:col-span-2"><span className={heading}>Skills (one per line)</span><textarea value={draft.skills} onChange={(event) => setDraft({ ...draft, skills: event.target.value })} className={textarea} rows={2} /></label>
        <label className="block sm:col-span-2"><span className={heading}>Apps it works with (one per line)</span><textarea value={draft.apps} onChange={(event) => setDraft({ ...draft, apps: event.target.value })} className={textarea} rows={2} /></label>
        <label className="block sm:col-span-2"><span className={heading}>Tools it may use (one per line, e.g. browser, terminal, files)</span><textarea value={draft.tools} onChange={(event) => setDraft({ ...draft, tools: event.target.value })} className={textarea} rows={2} /></label>
        <label className="block"><span className={heading}>Preferred model (optional)</span><input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} className={input} placeholder="e.g. claude-sonnet-4-5" /></label>
        <label className="block"><span className={heading}>Memory scopes</span>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {["user", "bot", "project", "team", "device"].map((id) => (
              <label key={id} className="flex items-center gap-1.5 text-sm text-slate-700">
                <input type="checkbox" checked={draft.memoryScopes.includes(id)} onChange={() => toggleScope(id)} /> {id}
              </label>
            ))}
          </div>
        </label>
        <label className="block sm:col-span-2"><span className={heading}>Computers it can use (its workspace lives in the Computer Center)</span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {computers.map((computer) => (
              <button type="button" key={computer.id} onClick={() => toggleComputer(computer.id)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${draft.computerIds.includes(computer.id) ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 text-slate-700 hover:bg-slate-50"}`}>{computer.name}</button>
            ))}
            {!computers.length && <span className="text-xs text-slate-500">No computers yet — create one in the Computer Center.</span>}
          </div>
        </label>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className={button} disabled={submitting}>Cancel</button>
        <button type="submit" className={primary} disabled={submitting || !draft.name.trim() || !draft.role.trim()} data-testid="bot-form-save">{submitting ? "Saving…" : "Save teammate"}</button>
      </div>
    </form>
  );
}

/** Bot detail panel: full configuration plus tasks, memories, versions and events. */
function BotPanel({ bot, onClose, onOpenChange, refresh }: {
  bot: Bot; onClose: () => void; onOpenChange: (bot: Bot) => void; refresh: () => Promise<void>;
}) {
  const [versions, setVersions] = useState<BotVersion[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [events, setEvents] = useState<WorkforceEvent[]>([]);
  const [draft, setDraft] = useState<FormDraft>(() => draftFromBot(bot));
  const [saving, setSaving] = useState("");
  const [status, setStatus] = useState("");

  const loadDetail = useCallback(async () => {
    const [v, t, m, e] = await Promise.all([
      workforce.botVersions(bot.id),
      workforce.tasks({ botId: bot.id }),
      workforce.memories({ botId: bot.id }),
      workforce.events({ botId: bot.id }),
    ]);
    setVersions(v.versions);
    setTasks(t.tasks.slice(0, 20));
    setMemories(m.memories.slice(0, 20));
    setEvents(e.events.slice(0, 50));
  }, [bot.id]);

  useEffect(() => { void loadDetail().catch(() => undefined); const timer = setInterval(() => void loadDetail().catch(() => undefined), 10_000); return () => clearInterval(timer); }, [loadDetail]);

  const save = async () => {
    setSaving("Saving…"); setStatus("");
    try {
      const { bot: updated } = await workforce.botUpdate(bot.id, {
        name: draft.name.trim(), avatar: draft.avatar.trim() || null, role: draft.role.trim(), description: draft.description,
        personality: draft.personality, instructions: draft.instructions,
        responsibilities: toList(draft.responsibilities), skills: toList(draft.skills), apps: toList(draft.apps), tools: toList(draft.tools),
        memoryConfig: { scopes: draft.memoryScopes },
        computerAccess: { enabled: draft.computerIds.length > 0, computerIds: draft.computerIds },
        fileAccess: { read: [], write: [] },
        autonomy: draft.autonomy, visibility: draft.visibility,
        modelPrefs: { ...(draft.model ? { model: draft.model } : {}) },
      });
      onOpenChange(updated); setStatus("Saved."); await loadDetail(); await refresh();
    } catch (error) { setStatus(error instanceof Error ? error.message : "That didn't work."); }
    finally { setSaving(""); }
  };

  const change = async (next: string) => {
    setStatus("");
    try {
      const { bot: updated } = await workforce.botSetStatus(bot.id, next);
      onOpenChange(updated); setStatus(next === "active" ? "Activated." : `Status is ${next}.`); await refresh();
    } catch (error) { setStatus(error instanceof Error ? error.message : "That didn't work."); }
  };

  const act = async (action: () => Promise<unknown>, label: string) => {
    setSaving(label); setStatus("");
    try { await action(); setStatus(`${label} done.`); await refresh(); await loadDetail(); }
    catch (error) { setStatus(error instanceof Error ? error.message : "That didn't work."); }
    finally { setSaving(""); }
  };

  return (
    <section className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-2 sm:p-6" data-testid="bot-detail">
      <div className={card} style={{ maxWidth: "42rem" }}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <BotIcon size={28} className="text-slate-900" />
            <h2 className="text-lg font-semibold text-ink">{bot.name}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div><span className={heading}>Role</span><p className="text-sm text-slate-900">{bot.role}</p></div>
          <div><span className={heading}>Autonomy</span><p className={`rounded-full px-2 py-0.5 text-xs font-semibold ${autonomyTones[bot.autonomy] || ""}`}>{autonomyLabel[bot.autonomy] || bot.autonomy}</p></div>
          <div><span className={heading}>Status</span><p className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusTones[bot.status] || ""}`}>{statusLabel[bot.status] || bot.status} · version {bot.version}</p></div>
        </div>
        <ConfigForm draft={draft} setDraft={setDraft} onSave={save} onCancel={onClose} submitting={saving !== "" || status !== ""} />
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div>
            <span className={heading}>Tasks</span>
            <ul className="mt-1 space-y-1">
              {tasks.slice(0, 8).map((task) => <li key={task.id} className="flex items-center justify-between gap-2 text-sm text-slate-700"><span className="truncate">{task.title}</span><span className="pill-badge" data-status={task.status}>{task.status}</span></li>)}
              {!tasks.length && <li className="text-xs text-slate-500">No tasks yet.</li>}
            </ul>
          </div>
          <div>
            <span className={heading}>Memory</span>
            <ul className="mt-1 space-y-1">
              {memories.slice(0, 8).map((memory) => <li key={memory.id} className="text-sm text-slate-700">{memory.kind}: {memory.content.slice(0, 80)}</li>)}
              {!memories.length && <li className="text-xs text-slate-500">No memories yet.</li>}
            </ul>
          </div>
          <div>
            <span className={heading}>Versions</span>
            <ul className="mt-1 space-y-1">
              {versions.slice(0, 10).map((version) => (
                <li key={version.version} className="flex items-center justify-between gap-2 text-sm text-slate-700">
                  <span>v{version.version} — {version.note || "saved"}</span>
                  <button type="button" onClick={() => void act(() => workforce.botRestore(bot.id, version.version), `Restoring v${version.version}`)} disabled={saving !== ""} className="btn-outline !py-1 !px-2 text-xs">Restore</button>
                </li>
              ))}
              {!versions.length && <li className="text-xs text-slate-500">No versions yet.</li>}
            </ul>
          </div>
        </div>
        <div className="mt-4">
          <span className={heading}>Recent activity</span>
          <ul className="mt-1 space-y-1">
            {events.slice(0, 10).map((event) => <li key={event.id} className="text-xs text-slate-600">{event.kind} · {new Date(event.createdAt).toLocaleString()}</li>)}
            {!events.length && <li className="text-xs text-slate-500">No activity yet.</li>}
          </ul>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => void change("active")} className={button} data-testid="bot-activate">{bot.status === "active" ? "Activate" : "Activate"}</button>
          <button type="button" onClick={() => void change("paused")} className={button} data-testid="bot-pause">{bot.status === "paused" ? "Resume" : "Pause"}</button>
          <button type="button" onClick={() => void act(() => workforce.botDuplicate(bot.id), "Duplicating")} className={button} data-testid="bot-duplicate"><Copy size={13} /> Duplicate</button>
          <button type="button" onClick={() => void act(() => workforce.botTest(bot.id), "Testing")} className={button} data-testid="bot-test"><PlayIcon size={13} /> Test</button>
          <button type="button" onClick={() => void workforce.botDelete(bot.id).then(() => { onClose(); void refresh(); }).catch((e) => setStatus(e instanceof Error ? e.message : "That didn't work."))} className="btn-ghost text-rose-600" data-testid="bot-delete"><X size={13} /> Delete</button>
        </div>
        {status && <Notice>{status}</Notice>}
      </div>
    </section>
  );
}

/** Create-modal + list. */
export default function WorkforcePage() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [templates, setTemplates] = useState<BotTemplate[]>([]);
  const [detail, setDetail] = useState<Bot | null>(null);
  const [createDraft, setCreateDraft] = useState<FormDraft | null>(null);
  const [error, setError] = useState("");
  const [signedIn, setSignedIn] = useState(isAccountSession);

  useEffect(() => {
    const syncSession = () => setSignedIn(isAccountSession());
    window.addEventListener(ACCOUNT_EVENT, syncSession);
    return () => window.removeEventListener(ACCOUNT_EVENT, syncSession);
  }, []);

  const refresh = useCallback(async () => {
    const data = await workforce.bots();
    setBots(data.bots);
  }, []);

  useEffect(() => {
    if (!signedIn) {
      setBots([]);
      setTemplates([]);
      setError("");
      return;
    }
    void refresh().catch((e) => setError(e instanceof Error ? e.message : "That didn't work."));
    void workforce.templates().then((data) => setTemplates(data.templates)).catch(() => undefined);
    const timer = setInterval(() => void refresh().catch(() => undefined), 12_000);
    return () => clearInterval(timer);
  }, [refresh, signedIn]);

  const createBot = async () => {
    setError("");
    try {
      const draft = createDraft!;
      const { bot } = await workforce.botCreate({
        name: draft.name.trim(), avatar: draft.avatar.trim() || null, role: draft.role.trim(),
        description: draft.description, personality: draft.personality, instructions: draft.instructions,
        responsibilities: toList(draft.responsibilities), skills: toList(draft.skills), apps: toList(draft.apps), tools: toList(draft.tools),
        memoryConfig: { scopes: draft.memoryScopes },
        computerAccess: { enabled: draft.computerIds.length > 0, computerIds: draft.computerIds },
        fileAccess: { read: [], write: [] },
        autonomy: draft.autonomy, visibility: draft.visibility,
        modelPrefs: { ...(draft.model ? { model: draft.model } : {}) },
      });
      setCreateDraft(null);
      setDetail(bot);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); }
  };

  const exportBot = async (bot: Bot) => {
    setError("");
    try {
      const data = await workforce.botExport(bot.id);
      const text = JSON.stringify(data, null, 2);
      const copied = await navigator.clipboard?.writeText(text).then(() => true).catch(() => false);
      setError(copied ? "Bot export copied to the clipboard." : `Export data:\n${text.slice(0, 800)}`);
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); }
  };

  const newDraft = (draft: Partial<FormDraft>): FormDraft => ({ name: "", avatar: "", role: "", description: "", personality: "", instructions: "", responsibilities: "", skills: "", apps: "", tools: "", autonomy: "approval", visibility: "private", memoryScopes: ["user", "bot"], model: "", computerIds: [], ...draft });

  return (
    <main className="mx-auto max-w-6xl px-3 pb-12 pt-5 sm:px-6 sm:pt-8" data-testid="workforce-page">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display-title text-[clamp(2rem,5vw,3rem)]">AI Workforce</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">Your teammates. Each has a role, instructions, tools and its own workspace. Give them work — the <a className="font-semibold text-slate-900 underline" href="/chat">chat</a> dispatches to them, and they act in their computers, browsers and terminals.</p>
        </div>
        <button type="button" disabled={!signedIn} onClick={() => setCreateDraft(newDraft({}))} className={primary} data-testid="create-bot"><Plus size={16} /> New teammate</button>
      </div>
      {!signedIn && (
        <Notice tone="amber" role="alert">
          <span>AI Workforce needs a signed-in HANNAH account. Your Groq key is still valid for chat, but it cannot own teammates or persistent workforce data.</span>
          {" "}
          <a className="font-semibold underline underline-offset-2" href="/settings">Open Settings → Account</a>
        </Notice>
      )}
      {error && <Notice tone="rose" role="alert">{error}</Notice>}

      <section className="mb-6" aria-label="Your teammates">
        <div className="mb-3 flex items-center justify-between"><span className={heading}>Teammates</span><button type="button" onClick={() => void refresh()} className="btn-outline text-xs"><RefreshCw size={12} /> Refresh</button></div>
        {bots.length === 0 ? (
          <div className={card} data-testid="bots-empty"><p className="text-sm text-slate-500">No teammates yet. Create one to have a teammate for research, engineering, ops, security, finance and more.</p></div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {bots.map((bot) => (
              <li key={bot.id} className={card} data-testid={`bot-${bot.id}`}>
                <div className="flex items-center gap-3">
                  <BotIcon size={22} className="text-slate-900" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-900">{bot.name}{bot.teamName ? <span className="ml-1 text-xs text-slate-500">· {bot.teamName}</span> : null}</p>
                    <p className="truncate text-xs text-slate-500">{bot.role}</p>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusTones[bot.status] || ""}`}>{statusLabel[bot.status] || bot.status}</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${autonomyTones[bot.autonomy] || ""}`}>{autonomyLabel[bot.autonomy] || bot.autonomy}</span>
                  <span className="pill-badge" data-status={bot.status}>v{bot.version}</span>
                  {bot.responsibilities.slice(0, 2).map((item, index) => <span key={index} className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600">{item}</span>)}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" onClick={() => setDetail(bot)} className={button} data-testid={`bot-open-${bot.id}`}><Eye size={13} /> Open</button>
                  <button type="button" onClick={() => setCreateDraft(draftFromBot(bot))} className={button} data-testid={`bot-configure-${bot.id}`}><Pencil size={13} /> Configure</button>
                  <button type="button" onClick={() => void workforce.botSetStatus(bot.id, bot.status === "active" ? "paused" : "active").then((r) => { void refresh(); setDetail(r.bot); }).catch((e) => setError(e instanceof Error ? e.message : "That didn't work."))} className={button} data-testid={`bot-toggle-${bot.id}`}>{bot.status === "active" ? <PauseIcon size={13} /> : <PlayIcon size={13} />} {bot.status === "active" ? "Pause" : "Activate"}</button>
                  <button type="button" onClick={() => void workforce.botDuplicate(bot.id).then(() => void refresh()).catch((e) => setError(e instanceof Error ? e.message : "That didn't work."))} className={button} data-testid={`bot-duplicate-${bot.id}`}><Copy size={13} /> Duplicate</button>
                  <button type="button" onClick={() => void exportBot(bot)} className={button} data-testid={`bot-export-${bot.id}`}><Upload size={13} /> Export</button>
                  <button type="button" onClick={() => void workforce.botDelete(bot.id).then(() => { setDetail(null); void refresh(); }).catch((e) => setError(e instanceof Error ? e.message : "That didn't work."))} className="btn-ghost text-rose-600" data-testid={`bot-delete-${bot.id}`}><X size={13} /> Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-6" aria-label="Create from a template">
        <div className="mb-3 flex items-center justify-between"><span className={heading}>Templates</span><span className="text-xs text-slate-600">Each template starts your teammate with role, instructions and tools.</span></div>
        <div className="grid gap-3 sm:grid-cols-3">
          {templates.map((template) => (
            <div key={template.id} className={card} data-testid={`template-${template.id}`}>
              <p className="flex items-center gap-2 text-sm font-semibold text-slate-900"><BotIcon size={15} className="text-slate-900" /> {template.name}</p>
              <p className="mt-1 text-xs text-slate-600">{template.description}</p>
              <button type="button" disabled={!signedIn} onClick={() => setCreateDraft(newDraft({
                name: template.name, avatar: template.avatar, role: template.role, description: template.description,
                personality: template.personality, instructions: template.instructions, responsibilities: template.responsibilities.join("\n"),
                skills: template.skills.join("\n"), apps: template.apps.join("\n"), tools: template.tools.join("\n"), autonomy: template.autonomy,
              }))} className={primary} data-testid={`create-from-${template.id}`}><Plus size={13} /> Create {template.name}</button>
            </div>
          ))}
          {!templates.length && <p className="text-sm text-slate-500">Templates are loading…</p>}
        </div>
      </section>

      <section aria-label="Teams">
        <span className={heading}>Teams — shared teammates</span>
        <p className="mt-1 text-sm text-slate-500">Publish a teammate to your team and other teammates of the same team can use it. Your private ones never leave your account.</p>
        <a href="/teams" className="mt-3 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"><Users size={14} /> Team Center</a>
      </section>

      {createDraft && (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-2 sm:p-6" data-testid="bot-create-modal">
          <div className={card} style={{ maxWidth: "46rem" }}>
            <h2 className="text-lg font-semibold text-ink">New teammate</h2>
            <ConfigForm draft={createDraft} setDraft={setCreateDraft as unknown as Dispatch<SetStateAction<FormDraft>>} onSave={() => void createBot()} onCancel={() => setCreateDraft(null)} submitting={false} />
          </div>
        </div>
      )}

      {detail && (
        <BotPanel bot={detail} onClose={() => setDetail(null)} onOpenChange={setDetail} refresh={refresh} />
      )}
    </main>
  );
}
