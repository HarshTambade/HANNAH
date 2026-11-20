/**
 * Actions: what HANNAH is allowed to do for you, what it is waiting to do,
 * what it did and how that was confirmed, and the code it works on.
 *
 * Everything on this screen is the server's own record (services/Operator.ts
 * → server/actions, server/coding). An action shows as done only when the
 * service it went to confirmed it.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleSlash, Clock, GitBranch, GitPullRequest, Loader2, OctagonX, Play, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { ACCOUNT_EVENT, isAccountSession } from "../services/api";
import { OPERATOR_EVENT, Operator, type ActionRecord, type CodeRepo, type CodingTask, type Finding, type Integration, type PermissionView, type TaskEvent } from "../services/Operator";

type Tab = "activity" | "permissions" | "connections" | "code";
const TABS: Array<{ id: Tab; label: string }> = [{ id: "activity", label: "Activity" }, { id: "permissions", label: "Permissions" }, { id: "connections", label: "Connections" }, { id: "code", label: "Code" }];
const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const when = (at: number | null | undefined) => (at ? new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "never");
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");

const STATUS: Record<string, { label: string; tone: string; Icon: typeof Clock }> = {
  done: { label: "Done, confirmed", tone: "bg-emerald-50 text-emerald-800 border-emerald-200", Icon: CheckCircle2 },
  unverified: { label: "Accepted, not confirmed", tone: "bg-amber-50 text-amber-900 border-amber-200", Icon: AlertTriangle },
  failed: { label: "Failed", tone: "bg-rose-50 text-rose-800 border-rose-200", Icon: XCircle },
  "waiting-approval": { label: "Waiting for you", tone: "bg-sky-50 text-sky-900 border-sky-200", Icon: Clock },
  authorized: { label: "Approved, on the device", tone: "bg-sky-50 text-sky-900 border-sky-200", Icon: Clock },
  executing: { label: "Running", tone: "bg-sky-50 text-sky-900 border-sky-200", Icon: Loader2 },
  suggested: { label: "Prepared, not submitted", tone: "bg-slate-100 text-slate-800 border-slate-200", Icon: CircleSlash },
  denied: { label: "Not allowed", tone: "bg-slate-100 text-slate-800 border-slate-200", Icon: CircleSlash },
  declined: { label: "You declined", tone: "bg-slate-100 text-slate-800 border-slate-200", Icon: CircleSlash },
  expired: { label: "Expired", tone: "bg-slate-100 text-slate-800 border-slate-200", Icon: CircleSlash },
  cancelled: { label: "Cancelled", tone: "bg-slate-100 text-slate-800 border-slate-200", Icon: CircleSlash },
  unknown: { label: "Outcome unknown", tone: "bg-amber-50 text-amber-900 border-amber-200", Icon: AlertTriangle },
};
function Badge({ status }: { status: string }) {
  const item = STATUS[status] || { label: status, tone: "bg-slate-100 text-slate-800 border-slate-200", Icon: Clock };
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${item.tone}`}><item.Icon className="h-3.5 w-3.5" aria-hidden="true" />{item.label}</span>;
}
function Notice({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "rose" | "amber" }) {
  const tones = { slate: "border-slate-200 bg-slate-50 text-slate-700", rose: "border-rose-200 bg-rose-50 text-rose-800", amber: "border-amber-200 bg-amber-50 text-amber-900" };
  return <p role={tone === "rose" ? "alert" : "status"} className={`rounded-xl border px-3 py-2 text-sm ${tones[tone]}`}>{children}</p>;
}
function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const refresh = useCallback(async () => { try { setData(await load()); setError(""); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }, deps);
  useEffect(() => {
    void refresh();
    const listener = () => { void refresh(); };
    window.addEventListener(OPERATOR_EVENT, listener);
    return () => window.removeEventListener(OPERATOR_EVENT, listener);
  }, [refresh]);
  return { data, error, busy, refresh, setData };
}

// ---------- Activity ----------

function ActionCard({ record, onChanged }: { record: ActionRecord; onChanged: () => void }) {
  const [open, setOpen] = useState(record.status === "waiting-approval");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answer = async (approve: boolean) => {
    setBusy(true); setError("");
    try { await Operator.decide(record.id, approve); onChanged(); } catch (reason) { setError(message(reason)); onChanged(); } finally { setBusy(false); }
  };
  const preview = record.preview;
  return (
    <li className={card} data-testid="action-card" data-status={record.status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-slate-900">{preview?.title || record.action}</p>
          <p className="mt-0.5 text-xs text-slate-600">{when(record.createdAt)} · {record.agent || record.source || "HANNAH"}{record.account ? ` · ${record.account}` : ""}</p>
        </div>
        <Badge status={record.status} />
      </div>
      <p className="mt-2 text-sm text-slate-700">{record.outcome}</p>
      {record.status === "waiting-approval" && (
        <div className="mt-3 space-y-2">
          {preview?.lines?.filter((line) => line.value).map((line) => <p key={line.label} className="text-sm text-slate-800"><span className="font-medium">{line.label}:</span> {line.value}</p>)}
          {preview?.body && <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-sm text-slate-800">{preview.body}</pre>}
          {preview?.warnings?.map((warning) => <Notice key={warning} tone="amber">{warning}</Notice>)}
          <p className="text-xs text-slate-600">{record.permission?.reason}</p>
          <div className="flex gap-2">
            <button type="button" className={primary} disabled={busy} onClick={() => void answer(true)}>Approve</button>
            <button type="button" className={button} disabled={busy} onClick={() => void answer(false)}>Decline</button>
          </div>
        </div>
      )}
      {error && <div className="mt-2"><Notice tone="rose">{error}</Notice></div>}
      {record.status !== "waiting-approval" && (
        <button type="button" className="mt-2 text-xs font-medium text-slate-700 underline" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide details" : "Details"}</button>
      )}
      {open && record.status !== "waiting-approval" && (
        <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm text-slate-700 sm:grid-cols-[9rem_1fr]">
          {record.request && <><dt className="font-medium">You asked</dt><dd>{record.request}</dd></>}
          <dt className="font-medium">Action</dt><dd>{record.action} ({record.kind}){record.resource ? ` on ${record.resource.id}` : ""}</dd>
          <dt className="font-medium">Permission</dt><dd>{record.permission?.levelName ? `${record.permission.levelName}. ` : ""}{record.permission?.reason}</dd>
          <dt className="font-medium">Approval</dt><dd>{record.approval?.status === "approved" ? `Approved ${when(record.approval.at)}` : record.approval?.status === "declined" ? `Declined ${when(record.approval.at)}` : record.approval?.status === "not-needed" ? "Not needed" : "Not given"}</dd>
          <dt className="font-medium">Checked afterwards</dt><dd>{record.verification ? `${record.verification.confirmed ? "Confirmed" : "Not confirmed"}: ${record.verification.evidence}` : "Not run"}</dd>
          {record.error && <><dt className="font-medium">Error</dt><dd>{record.error}</dd></>}
          {preview?.lines?.filter((line) => line.value).map((line) => <div key={line.label} className="contents"><dt className="font-medium">{line.label}</dt><dd className="break-words">{line.value}</dd></div>)}
        </dl>
      )}
    </li>
  );
}

function Activity() {
  const { data, error, busy, refresh } = useLoad(() => Operator.list({ limit: 80 }));
  const [filter, setFilter] = useState<"all" | "changes">("changes");
  const [stopping, setStopping] = useState(false);
  useEffect(() => { const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 20_000); return () => window.clearInterval(timer); }, [refresh]);
  const records = data?.actions || [];
  const waiting = records.filter((record) => record.status === "waiting-approval");
  const rest = records.filter((record) => record.status !== "waiting-approval" && (filter === "all" || record.kind !== "read"));
  const toggle = async () => { setStopping(true); try { await (data?.stoppedAt ? Operator.resume() : Operator.stop()); } finally { setStopping(false); void refresh(); } };
  return (
    <div className="space-y-4">
      <section className={`${card} flex flex-wrap items-center justify-between gap-3`} aria-label="Emergency stop">
        <div>
          <h2 className="font-semibold text-slate-900">{data?.stoppedAt ? "Everything is stopped" : "Emergency stop"}</h2>
          <p className="text-sm text-slate-700">{data?.stoppedAt ? `Since ${when(data.stoppedAt)}, HANNAH only reads. Nothing is sent, changed or run.` : "Cancels everything waiting, pauses coding tasks, and lets HANNAH only read until you turn it off."}</p>
        </div>
        <button type="button" className={data?.stoppedAt ? button : "inline-flex items-center gap-1.5 rounded-lg bg-rose-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-800 disabled:opacity-50"} disabled={stopping} onClick={() => void toggle()}>
          {data?.stoppedAt ? <><Play className="h-4 w-4" aria-hidden="true" />Let HANNAH act again</> : <><OctagonX className="h-4 w-4" aria-hidden="true" />Stop everything</>}
        </button>
      </section>
      {error && <Notice tone="rose">{error}</Notice>}
      <section aria-label="Waiting for your approval">
        <h2 className="mb-2 font-semibold text-slate-900">Waiting for your approval ({waiting.length})</h2>
        {waiting.length ? <ul className="space-y-3">{waiting.map((record) => <ActionCard key={record.id} record={record} onChanged={() => void refresh()} />)}</ul> : <Notice>{busy ? "Loading…" : "Nothing is waiting."}</Notice>}
      </section>
      <section aria-label="History">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-slate-900">History</h2>
          <div className="flex items-center gap-2">
            <label className="text-sm text-slate-700" htmlFor="action-filter">Show</label>
            <select id="action-filter" className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900" value={filter} onChange={(event) => setFilter(event.target.value as "all" | "changes")}><option value="changes">Changes and messages</option><option value="all">Everything, reads too</option></select>
            <button type="button" className={button} onClick={() => void refresh()}><RefreshCw className="h-4 w-4" aria-hidden="true" />Refresh</button>
          </div>
        </div>
        {rest.length ? <ul className="space-y-3">{rest.map((record) => <ActionCard key={record.id} record={record} onChanged={() => void refresh()} />)}</ul> : <Notice>{busy ? "Loading…" : "HANNAH hasn't done anything for this account yet. When it does, each action appears here with how it was confirmed."}</Notice>}
      </section>
    </div>
  );
}

// ---------- Permissions ----------

function Permissions() {
  const { data, error, refresh, setData } = useLoad<PermissionView>(() => Operator.permissions());
  const [problem, setProblem] = useState("");
  const [draft, setDraft] = useState({ service: "mail", actions: [] as string[], match: "", days: "30", perDay: "", note: "" });
  if (!data) return error ? <Notice tone="rose">{error}</Notice> : <Notice>Loading…</Notice>;
  const service = data.services.find((item) => item.id === draft.service) || data.services[0];
  const standing = service.actions.filter((action) => action.standing);
  const setLevel = async (id: string, level: number) => { setProblem(""); try { setData(await Operator.setLevels({ [id]: level })); } catch (reason) { setProblem(message(reason)); } };
  const add = async () => {
    setProblem("");
    try {
      const view = await Operator.addGrant({ service: draft.service, actions: draft.actions, ...(draft.match.trim() ? { resource: { type: "any", match: draft.match.trim() } } : {}), ...(draft.perDay ? { limits: { perDay: Number(draft.perDay) } } : {}), ...(draft.days ? { expiresAt: new Date(Date.now() + Number(draft.days) * 86_400_000).toISOString() } : {}), note: draft.note });
      setData(view); setDraft({ ...draft, actions: [], match: "", note: "" });
    } catch (reason) { setProblem(message(reason)); }
  };
  const actionTitle = (id: string) => data.services.flatMap((item) => item.actions).find((action) => action.id === id)?.title || (id === "*" ? "Every action of the service" : id);
  return (
    <div className="space-y-4">
      {data.stoppedAt && <Notice tone="amber">The emergency stop is on. These settings apply again when you turn it off in Activity.</Notice>}
      {problem && <Notice tone="rose">{problem}</Notice>}
      <section className={card} aria-label="Levels">
        <h2 className="font-semibold text-slate-900">How much HANNAH may do, per service</h2>
        <p className="mt-1 text-sm text-slate-700">Whatever the level, these always ask first: {data.always.join("; ")}.</p>
        <ul className="mt-3 divide-y divide-slate-100">
          {data.services.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div className="min-w-0">
                <label htmlFor={`level-${item.id}`} className="font-medium text-slate-900">{item.label}</label>
                <p className="text-xs text-slate-600">{item.description} Last used: {item.lastUsed ? `${when(item.lastUsed.at)} (${actionTitle(item.lastUsed.action)})` : "never"}.</p>
              </div>
              <select id={`level-${item.id}`} className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900" value={item.level} onChange={(event) => void setLevel(item.id, Number(event.target.value))}>
                {data.levels.map((level) => <option key={level.level} value={level.level}>{level.level} · {level.name}</option>)}
              </select>
            </li>
          ))}
        </ul>
        <ul className="mt-3 space-y-1 text-xs text-slate-600">{data.levels.map((level) => <li key={level.level}><span className="font-medium text-slate-800">{level.level} · {level.name}:</span> {level.description}</li>)}</ul>
      </section>
      <section className={card} aria-label="Standing permissions">
        <h2 className="font-semibold text-slate-900">Standing permissions</h2>
        <p className="mt-1 text-sm text-slate-700">Things HANNAH may do without asking each time. Each names the action, what it applies to, and when it ends. Revoking takes effect with HANNAH's next action.</p>
        {data.grants.length ? (
          <ul className="mt-3 space-y-2">
            {data.grants.map((grant) => (
              <li key={grant.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-3" data-testid="grant">
                <div className="min-w-0 text-sm text-slate-800">
                  <p className="font-medium">{grant.actions.map(actionTitle).join(", ")}{grant.resource ? ` — only for ${grant.resource.match}` : ""}</p>
                  <p className="text-xs text-slate-600">{grant.note ? `${grant.note} · ` : ""}{grant.limits?.perDay ? `up to ${grant.limits.perDay} a day · ` : ""}{grant.expiresAt ? `until ${when(grant.expiresAt)}` : "no end date"} · used {grant.uses} time{grant.uses === 1 ? "" : "s"}, last {when(grant.lastUsedAt)}</p>
                </div>
                {grant.active ? <button type="button" className={button} onClick={() => void Operator.revokeGrant(grant.id).then(setData).catch((reason) => setProblem(message(reason)))}>Revoke</button> : <span className="text-xs font-medium text-slate-600">{grant.revokedAt ? "Revoked" : "Ended"}</span>}
              </li>
            ))}
          </ul>
        ) : <p className="mt-3 text-sm text-slate-600">None. HANNAH asks before every change.</p>}
        <form className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void add(); }}>
          <div><label className="text-sm font-medium text-slate-800" htmlFor="grant-service">Service</label>
            <select id="grant-service" className={input} value={draft.service} onChange={(event) => setDraft({ ...draft, service: event.target.value, actions: [] })}>{data.services.map((item) => <option key={item.id} value={item.id}>{item.label} (level {item.level})</option>)}</select></div>
          <fieldset><legend className="text-sm font-medium text-slate-800">May do without asking</legend>
            {standing.length ? standing.map((action) => (
              <label key={action.id} className="mt-1 flex items-center gap-2 text-sm text-slate-800"><input type="checkbox" checked={draft.actions.includes(action.id)} onChange={(event) => setDraft({ ...draft, actions: event.target.checked ? [...draft.actions, action.id] : draft.actions.filter((id) => id !== action.id) })} />{action.title}</label>
            )) : <p className="text-sm text-slate-600">This service has no action a standing permission can cover.</p>}</fieldset>
          <div><label className="text-sm font-medium text-slate-800" htmlFor="grant-match">Only for (optional)</label>
            <input id="grant-match" className={input} placeholder="owner/repo, name@company.com or *@company.com" value={draft.match} onChange={(event) => setDraft({ ...draft, match: event.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-sm font-medium text-slate-800" htmlFor="grant-days">Ends after (days)</label><input id="grant-days" className={input} inputMode="numeric" value={draft.days} onChange={(event) => setDraft({ ...draft, days: event.target.value.replace(/\D/g, "") })} /></div>
            <div><label className="text-sm font-medium text-slate-800" htmlFor="grant-perday">At most a day</label><input id="grant-perday" className={input} inputMode="numeric" value={draft.perDay} onChange={(event) => setDraft({ ...draft, perDay: event.target.value.replace(/\D/g, "") })} /></div>
          </div>
          <div className="sm:col-span-2"><label className="text-sm font-medium text-slate-800" htmlFor="grant-note">Note to yourself (optional)</label><input id="grant-note" className={input} value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></div>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-3"><button type="submit" className={primary} disabled={!draft.actions.length}>Add permission</button><p className="text-xs text-slate-600">Needs level 4 or 5 for the service. {service.level < 4 ? `${service.label} is at level ${service.level}.` : ""}</p></div>
        </form>
      </section>
      <button type="button" className={button} onClick={() => void refresh()}><RefreshCw className="h-4 w-4" aria-hidden="true" />Refresh</button>
    </div>
  );
}

// ---------- Connections ----------

function Connections() {
  const { data, error } = useLoad<Integration[]>(() => Operator.integrations());
  const groups = useMemo(() => { const out = new Map<string, Integration[]>(); for (const item of data || []) out.set(item.category, [...(out.get(item.category) || []), item]); return [...out.entries()]; }, [data]);
  if (!data) return error ? <Notice tone="rose">{error}</Notice> : <Notice>Loading…</Notice>;
  return (
    <div className="space-y-5">
      <Notice>What each connection really allows, and what it doesn't. Connect and disconnect accounts in Settings; GitHub in the Code tab. More services (Notion, Linear and others) are under Marketplace → Connectors.</Notice>
      {groups.map(([category, items]) => (
        <section key={category} aria-label={category}>
          <h2 className="mb-2 font-semibold text-slate-900">{category}</h2>
          <ul className="grid gap-3 lg:grid-cols-2">
            {items.map((item) => (
              <li key={item.id} className={card} data-testid="integration">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div><p className="font-medium text-slate-900">{item.name}</p><p className="text-xs text-slate-600">{item.account || (item.connected ? "Connected" : "")}</p></div>
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${item.connected ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-slate-100 text-slate-700"}`}>{item.connected === null ? "Per device" : item.connected ? "Connected" : "Not connected"}</span>
                </div>
                {item.setup && <p className="mt-2 text-sm text-slate-700">{item.setup}</p>}
                {item.permissions.length > 0 && <p className="mt-2 text-xs text-slate-600"><span className="font-medium text-slate-800">Granted:</span> {item.permissions.join(", ")}</p>}
                <p className="mt-2 text-xs font-medium text-slate-800">Can do</p>
                <ul className="list-disc pl-5 text-xs text-slate-700">{item.supported.map((line) => <li key={line}>{line}</li>)}</ul>
                <p className="mt-2 text-xs font-medium text-slate-800">Can't do</p>
                <ul className="list-disc pl-5 text-xs text-slate-700">{item.unsupported.map((line) => <li key={line}>{line}</li>)}</ul>
                <p className="mt-2 text-xs text-slate-600">Last worked: {when(item.lastOkAt)}{item.lastAction ? ` · last action ${when(item.lastAction.at)}` : ""}{item.expires ? ` · token expires ${item.expires}` : ""}</p>
                {item.lastError && <div className="mt-2"><Notice tone="rose">Last error: {item.lastError}</Notice></div>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ---------- Code ----------

const SEVERITY: Record<string, string> = { critical: "bg-rose-100 text-rose-900", high: "bg-orange-100 text-orange-900", medium: "bg-amber-100 text-amber-900", low: "bg-slate-100 text-slate-800" };
const KNOWN: Record<string, string> = { certain: "A fact about the text", likely: "Very likely, from the text", suspected: "Suspected by a model reading the code; not reproduced" };

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <li className="rounded-xl border border-slate-200 p-3" data-testid="finding">
      <div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${SEVERITY[finding.severity]}`}>{finding.severity}</span><p className="font-medium text-slate-900">{finding.title}</p></div>
      <p className="mt-1 font-mono text-xs text-slate-700">{finding.file}:{finding.line}</p>
      <p className="mt-1 text-sm text-slate-700">{finding.detail}</p>
      {finding.evidence && <pre className="mt-1 overflow-auto rounded-lg bg-slate-50 p-2 text-xs text-slate-800">{finding.evidence}</pre>}
      {finding.fix && <p className="mt-1 text-sm text-slate-700"><span className="font-medium">Fix:</span> {finding.fix}</p>}
      <p className="mt-1 text-xs text-slate-600">{KNOWN[finding.confidence]}</p>
    </li>
  );
}

function Diff({ text }: { text: string }) {
  return (
    <pre className="overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-5" data-testid="diff">
      {text.split("\n").map((line, index) => <span key={index} className={`block ${line.startsWith("+") && !line.startsWith("+++") ? "bg-emerald-100 text-emerald-950" : line.startsWith("-") && !line.startsWith("---") ? "bg-rose-100 text-rose-950" : line.startsWith("@@") ? "text-sky-800" : "text-slate-800"}`}>{line || " "}</span>)}
    </pre>
  );
}

function TaskView({ task, onChanged }: { task: CodingTask; onChanged: (task: CodingTask) => void }) {
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [live, setLive] = useState<string[]>([]);
  const act = async (label: string, work: () => Promise<CodingTask | void>) => {
    setBusy(label); setNote("");
    try { const next = await work(); if (next) onChanged(next); } catch (reason) { setNote(message(reason)); } finally { setBusy(""); }
  };
  const onEvent = (event: TaskEvent) => { if (event.message) setLive((lines) => [...lines.slice(-5), event.message as string]); };
  const publish = () => act("publish", async () => {
    const { record } = await Operator.code.publish(task.id);
    if (record.status === "waiting-approval") { setNote("Approve the publish in the Activity tab (or the card that appeared). The exact branch, files and check results are shown there."); return Operator.code.task(task.id); }
    setNote(record.outcome);
    return Operator.code.task(task.id);
  });
  const moving = ["running", "queued", "paused", "watching-ci", "published", "waiting-approval"].includes(task.status);
  return (
    <article className={`${card} space-y-3`} aria-label={task.title} data-testid="coding-task" data-status={task.status}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0"><h3 className="font-semibold text-slate-900">{task.title}</h3><p className="text-xs text-slate-600">{task.repo}{task.base ? ` at ${task.base.sha.slice(0, 7)} (${task.base.branch})` : ""} · {task.status}{task.stage !== "done" ? `, stage: ${task.stage}` : ""}</p></div>
        <div className="flex flex-wrap gap-2">
          {moving && <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void act("continue", () => Operator.code.drive(Operator.code.continue(task.id, onEvent), onEvent, { maxRounds: 12 }))}>{busy === "continue" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}{task.status === "watching-ci" || task.status === "published" ? "Check CI" : "Continue"}</button>}
          {task.status === "ready" && !task.publish && <button type="button" className={primary} disabled={Boolean(busy)} onClick={() => void publish()}><GitPullRequest className="h-4 w-4" aria-hidden="true" />Publish…</button>}
          {!["completed", "failed", "cancelled"].includes(task.status) && <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void act("cancel", () => Operator.code.cancel(task.id))}>Cancel</button>}
        </div>
      </header>
      {task.summary && <p className="text-sm text-slate-800">{task.summary}</p>}
      {task.error && <Notice tone={task.error.transient ? "amber" : "rose"}>{task.error.message}{task.error.transient ? " The task is saved where it stopped; choose Continue." : ""}</Notice>}
      {note && <Notice>{note}</Notice>}
      {busy && live.length > 0 && <ul className="text-xs text-slate-600" aria-live="polite">{live.map((line, index) => <li key={index}>{line}</li>)}</ul>}
      {task.workingTree?.note && <Notice>{task.workingTree.note}</Notice>}
      {task.pending && task.status === "waiting-approval" && <Notice tone="amber">Waiting for your approval to {task.pending.what}. It is in the Activity tab.</Notice>}
      {task.plan && (
        <section aria-label="Plan" className="space-y-1 text-sm text-slate-800">
          <h4 className="font-semibold text-slate-900">Plan</h4>
          {task.plan.rootCause && <p><span className="font-medium">Cause:</span> {task.plan.rootCause}</p>}
          <p><span className="font-medium">Change:</span> {task.plan.approach}</p>
          {task.plan.needsInfo && <Notice tone="amber">HANNAH needs to know: {task.plan.needsInfo}</Notice>}
          {task.plan.risks.length > 0 && <p><span className="font-medium">Risks:</span> {task.plan.risks.join("; ")}</p>}
        </section>
      )}
      {task.review && (
        <section aria-label="Changes" className="space-y-2">
          <h4 className="font-semibold text-slate-900">Changes: {task.review.stat.files} file{task.review.stat.files === 1 ? "" : "s"}, +{task.review.stat.added} −{task.review.stat.removed}</h4>
          {task.review.attention.map((line) => <Notice key={line} tone="amber">{line}</Notice>)}
          {task.review.parses.filter((item) => !item.ok).map((item) => <Notice key={item.path} tone="rose">{item.path} no longer parses: {item.problem}</Notice>)}
          {task.refused && task.refused.length > 0 && <Notice tone="amber">{task.refused.length} proposed edit{task.refused.length === 1 ? " was" : "s were"} refused: {task.refused.map((item) => `${item.path} (${item.reason})`).join("; ")}</Notice>}
          {task.review.diffs.map((item) => <div key={item.path}><p className="mb-1 font-mono text-xs text-slate-700">{item.path} (+{item.added} −{item.removed})</p><Diff text={item.diff} /></div>)}
        </section>
      )}
      {(task.runs?.length || task.verify?.note) && (
        <section aria-label="Checks" className="space-y-1 text-sm text-slate-800">
          <h4 className="font-semibold text-slate-900">Checks</h4>
          {task.verify?.note && <p>{task.verify.note}</p>}
          {task.runs?.map((run) => <details key={run.script} className="rounded-lg border border-slate-200 p-2"><summary className="cursor-pointer"><span className="font-mono text-xs">{run.command || run.script}</span>: {run.skipped ? `not run (${run.reason})` : run.passed ? "passed" : run.preexisting ? "fails, and failed before the change too" : `failed (exit ${run.exitCode})`}</summary>{run.output && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-slate-700">{run.output}</pre>}</details>)}
        </section>
      )}
      {task.publish && <p className="flex flex-wrap items-center gap-2 text-sm text-slate-800"><GitBranch className="h-4 w-4" aria-hidden="true" />Commit {task.publish.commit.slice(0, 7)} on {task.publish.branch}{task.publish.pushed ? ", pushed" : ", not pushed"}{task.publish.pull && <a className="font-medium text-sky-800 underline" href={task.publish.pull.url} target="_blank" rel="noreferrer">Pull request #{task.publish.pull.number}</a>}</p>}
      {task.ci && <section aria-label="CI" className="space-y-1 text-sm text-slate-800"><h4 className="font-semibold text-slate-900">The repository's CI: {task.ci.status === "none" ? "no run appeared" : task.ci.status}</h4>{task.ci.failures?.map((item) => <details key={item.job} className="rounded-lg border border-slate-200 p-2"><summary className="cursor-pointer">{item.workflow} / {item.job}: {item.steps.join(", ") || "failed"}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-slate-700">{item.log}</pre></details>)}</section>}
      {task.findings && (
        <section aria-label="Findings" className="space-y-2">
          <h4 className="font-semibold text-slate-900">Findings ({task.findings.length})</h4>
          <p className="text-xs text-slate-600">{task.coverage?.files} files read{task.coverage?.skipped ? `, ${task.coverage.skipped} skipped (binary, generated or too large)` : ""}. {task.reviewed?.files.length || 0} reviewed by a model{task.reviewed?.dropped ? `; ${task.reviewed.dropped} model finding${task.reviewed.dropped === 1 ? " was" : "s were"} dropped because the quoted line wasn't in the file` : ""}. {task.reviewed?.note} {task.dependencies?.note || (task.dependencies ? `${task.dependencies.checked} locked packages checked against published advisories.` : "")}</p>
          {task.findings.length ? <ul className="space-y-2">{task.findings.slice(0, 60).map((finding, index) => <FindingRow key={`${finding.file}:${finding.line}:${index}`} finding={finding} />)}</ul> : <Notice>Nothing was found by these checks. That covers what is listed above, not everything that could be wrong.</Notice>}
        </section>
      )}
      {task.events && <details><summary className="cursor-pointer text-sm font-medium text-slate-800">What happened, step by step</summary><ol className="mt-2 space-y-1 text-xs text-slate-700">{task.events.map((event, index) => <li key={index}><span className="text-slate-500">{when(event.at)}</span> {event.text}</li>)}</ol></details>}
    </article>
  );
}

function Code() {
  const { data, error, refresh } = useLoad(() => Operator.code.repos());
  const tasks = useLoad(() => Operator.code.tasks());
  const [token, setToken] = useState("");
  const [note, setNote] = useState("");
  const [available, setAvailable] = useState<Array<{ name: string; private: boolean }> | null>(null);
  const [repoName, setRepoName] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [draft, setDraft] = useState({ repoId: "", kind: "scan" as "scan" | "change", request: "" });
  const [current, setCurrent] = useState<CodingTask | null>(null);
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<string[]>([]);
  const [report, setReport] = useState<Awaited<ReturnType<typeof Operator.code.check>> | null>(null);
  const guard = async (work: () => Promise<unknown>) => { setNote(""); try { await work(); } catch (reason) { setNote(message(reason)); } void refresh(); };
  const repos = data?.repos || [];
  const repoId = draft.repoId || repos[0]?.id || "";
  const start = async () => {
    setRunning(true); setLive([]); setNote(""); setCurrent(null);
    const onEvent = (event: TaskEvent) => { if (event.message) setLive((lines) => [...lines.slice(-7), event.message as string]); };
    try { setCurrent(await Operator.code.drive(Operator.code.start({ repoId, kind: draft.kind, request: draft.request }, onEvent), onEvent)); } catch (reason) { setNote(message(reason)); } finally { setRunning(false); void tasks.refresh(); }
  };
  if (!data) return error ? <Notice tone="rose">{error}</Notice> : <Notice>Loading…</Notice>;
  return (
    <div className="space-y-4">
      {note && <Notice tone="rose">{note}</Notice>}
      <section className={card} aria-label="GitHub">
        <h2 className="font-semibold text-slate-900">GitHub</h2>
        {data.github.connected ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate-800">Connected as <span className="font-medium">{data.github.account}</span> ({data.github.tokenKind}). Last worked {when(data.github.lastOkAt)}.{data.github.lastError ? ` Last error: ${data.github.lastError}` : ""}</p>
            <button type="button" className={button} onClick={() => void guard(() => Operator.code.disconnectGithub())}>Disconnect</button>
          </div>
        ) : (
          <form className="mt-2 space-y-2" onSubmit={(event) => { event.preventDefault(); void guard(async () => { await Operator.code.connectGithub(token.trim()); setToken(""); }); }}>
            <p className="text-sm text-slate-700">Create a <a className="font-medium text-sky-800 underline" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">fine-grained personal access token</a> for only the repositories HANNAH should see, with: Contents (read and write), Pull requests (read and write), Issues (read and write), Actions (read), Metadata (read). HANNAH checks it with GitHub, stores it encrypted, and never shows it again. Don't paste a token into chat.</p>
            <label className="text-sm font-medium text-slate-800" htmlFor="github-token">Token</label>
            <div className="flex flex-wrap gap-2"><input id="github-token" type="password" autoComplete="off" className={`${input} max-w-md`} value={token} onChange={(event) => setToken(event.target.value)} /><button type="submit" className={primary} disabled={token.trim().length < 20}>Connect</button></div>
            {data.github.storage === false && <Notice tone="amber">This server can't store tokens yet (no key vault configured).</Notice>}
          </form>
        )}
      </section>
      <section className={card} aria-label="Repositories">
        <h2 className="font-semibold text-slate-900">Repositories</h2>
        {repos.length ? (
          <ul className="mt-2 divide-y divide-slate-100">
            {repos.map((repo: CodeRepo) => (
              <li key={repo.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5" data-testid="repo">
                <div className="min-w-0"><p className="font-medium text-slate-900">{repo.name}</p><p className="text-xs text-slate-600">{repo.host === "github" ? "GitHub" : "On this server's machine"} · default branch {repo.defaultBranch || "unknown"} · {repo.indexedAt ? `read ${when(repo.indexedAt)}` : "not read yet"}</p></div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="sr-only" htmlFor={`access-${repo.id}`}>What HANNAH may do in {repo.name}</label>
                  <select id={`access-${repo.id}`} className="max-w-[16rem] rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900" value={repo.settings.access} onChange={(event) => void guard(() => Operator.code.updateRepo(repo.id, { access: event.target.value }))}>{data.access.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
                  <button type="button" className={button} onClick={() => void guard(async () => setReport(await Operator.code.check(repo.id)))}>Check now</button>
                  <button type="button" className={button} onClick={() => void guard(() => Operator.code.removeRepo(repo.id))}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-sm text-slate-600">No repository is connected yet.</p>}
        {report && <div className="mt-3 rounded-xl border border-slate-200 p-3 text-sm text-slate-800" data-testid="repo-report"><p className="font-medium">{report.repo}: {report.summary}</p><ul className="mt-1 list-disc pl-5">{report.items.map((item) => <li key={item.title}>{item.title}{item.details.length ? `: ${item.details.slice(0, 4).join("; ")}` : ""}</li>)}</ul><p className="mt-1 text-xs text-slate-600">{report.githubNote} {report.note}</p></div>}
        <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2">
          {data.github.connected && (
            <form onSubmit={(event) => { event.preventDefault(); void guard(async () => { await Operator.code.addRepo("github", repoName.trim()); setRepoName(""); }); }}>
              <label className="text-sm font-medium text-slate-800" htmlFor="repo-name">Add a GitHub repository</label>
              <div className="mt-1 flex gap-2"><input id="repo-name" list="repo-options" className={input} placeholder="owner/name" value={repoName} onFocus={() => { if (!available) void Operator.code.repos(true).then((result) => setAvailable(result.available || [])).catch(() => setAvailable([])); }} onChange={(event) => setRepoName(event.target.value)} /><button type="submit" className={button} disabled={!/^[\w.-]+\/[\w.-]+$/.test(repoName.trim())}>Add</button></div>
              <datalist id="repo-options">{(available || []).map((item) => <option key={item.name} value={item.name} />)}</datalist>
            </form>
          )}
          {data.local.enabled ? (
            <form onSubmit={(event) => { event.preventDefault(); void guard(async () => { await Operator.code.addRepo("local", localPath.trim()); setLocalPath(""); }); }}>
              <label className="text-sm font-medium text-slate-800" htmlFor="repo-path">Add a local repository (a folder on the server's machine)</label>
              <div className="mt-1 flex gap-2"><input id="repo-path" className={input} placeholder="/path/to/repository" value={localPath} onChange={(event) => setLocalPath(event.target.value)} /><button type="submit" className={button} disabled={!localPath.trim()}>Add</button></div>
            </form>
          ) : <p className="text-xs text-slate-600">Local repositories (where HANNAH can also run the project's tests) need HANNAH's server running on your own machine with HANNAH_CODE_ROOTS set. On this server, a GitHub repository's tests run in its own CI after a push.</p>}
        </div>
      </section>
      {repos.length > 0 && (
        <section className={card} aria-label="New task">
          <h2 className="font-semibold text-slate-900">Scan or change</h2>
          <form className="mt-2 space-y-2" onSubmit={(event) => { event.preventDefault(); void start(); }}>
            <div className="grid gap-2 sm:grid-cols-2">
              <div><label className="text-sm font-medium text-slate-800" htmlFor="task-repo">Repository</label><select id="task-repo" className={input} value={repoId} onChange={(event) => setDraft({ ...draft, repoId: event.target.value })}>{repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></div>
              <div><label className="text-sm font-medium text-slate-800" htmlFor="task-kind">What</label><select id="task-kind" className={input} value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as "scan" | "change" })}><option value="scan">Scan for bugs and risks</option><option value="change">Prepare a change or a fix</option></select></div>
            </div>
            <label className="text-sm font-medium text-slate-800" htmlFor="task-request">{draft.kind === "scan" ? "Anything to look at in particular (optional)" : "What to change or fix"}</label>
            <textarea id="task-request" className={`${input} min-h-20`} value={draft.request} onChange={(event) => setDraft({ ...draft, request: event.target.value })} placeholder={draft.kind === "scan" ? "For example: why sign-in fails after the token expires" : "For example: the order average is too high; fix it and keep the tests passing"} />
            <div className="flex flex-wrap items-center gap-3"><button type="submit" className={primary} disabled={running || (draft.kind === "change" && draft.request.trim().length < 8)}>{running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="h-4 w-4" aria-hidden="true" />}{draft.kind === "scan" ? "Scan" : "Prepare the change"}</button><p className="text-xs text-slate-600">A change is prepared as a diff. Nothing is committed or pushed until you publish it and approve.</p></div>
          </form>
          {running && live.length > 0 && <ul className="mt-2 text-xs text-slate-600" aria-live="polite">{live.map((line, index) => <li key={index}>{line}</li>)}</ul>}
        </section>
      )}
      {current && <TaskView task={current} onChanged={(task) => { setCurrent(task); void tasks.refresh(); }} />}
      <section aria-label="Tasks">
        <h2 className="mb-2 font-semibold text-slate-900">Tasks</h2>
        {tasks.data?.length ? (
          <ul className="space-y-2">{tasks.data.filter((task) => task.id !== current?.id).map((task) => (
            <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3">
              <div className="min-w-0"><p className="font-medium text-slate-900">{task.title}</p><p className="text-xs text-slate-600">{task.repo} · {task.status} · {when(task.updatedAt)}{task.summary ? ` · ${task.summary}` : ""}</p></div>
              <button type="button" className={button} onClick={() => void Operator.code.task(task.id).then(setCurrent).catch((reason) => setNote(message(reason)))}>Open</button>
            </li>
          ))}</ul>
        ) : <Notice>No coding tasks yet.</Notice>}
      </section>
    </div>
  );
}

export default function OperatorPage() {
  const [tab, setTab] = useState<Tab>(() => (typeof window !== "undefined" && TABS.some((item) => item.id === window.location.hash.slice(1)) ? window.location.hash.slice(1) as Tab : "activity"));
  const [signedIn, setSignedIn] = useState(() => isAccountSession());
  useEffect(() => { const listener = () => setSignedIn(isAccountSession()); window.addEventListener(ACCOUNT_EVENT, listener); return () => window.removeEventListener(ACCOUNT_EVENT, listener); }, []);
  return (
    <main className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Actions</h1>
        <p className="mt-1 text-sm text-slate-700">What HANNAH may do for you, what is waiting for your yes, what it did and how that was confirmed.</p>
      </header>
      {!signedIn ? (
        <Notice>Sign in to an account (Settings → Account) to let HANNAH act for you. Permissions, approvals and the history of actions belong to an account, so they follow you across devices. Without one, HANNAH still asks on this device before every change.</Notice>
      ) : (
        <>
          <div role="tablist" aria-label="Sections" className="flex flex-wrap gap-2">
            {TABS.map((item) => <button key={item.id} type="button" role="tab" id={`tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`panel-${item.id}`} className={`rounded-full border px-3 py-1.5 text-sm font-medium ${tab === item.id ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50"}`} onClick={() => { setTab(item.id); window.history.replaceState(null, "", `#${item.id}`); }}>{item.label}</button>)}
          </div>
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === "activity" && <Activity />}
            {tab === "permissions" && <Permissions />}
            {tab === "connections" && <Connections />}
            {tab === "code" && <Code />}
          </div>
        </>
      )}
    </main>
  );
}
