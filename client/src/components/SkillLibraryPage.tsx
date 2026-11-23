/**
 * Skill Library — your skills. A skill is a reusable procedure; a routine is
 * the schedule that runs it. Skills can come from approval, from teaching a
 * human how to do something, or from manual creation here.
 *
 * Teach mode: start a session, demonstrate, record, then compile. A compiled
 * skill starts as a draft — review it, test it, approve it, and publish it.
 */
import { useCallback, useEffect, useState } from "react";
import { BookOpen, CheckCircle2, PlayCircle, Plus, RefreshCw, Star, Trash2, Upload, X } from "lucide-react";
import workforce, { shortDate, type Skill, type SkillVersion } from "../services/Workforce";

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
const STATUS_LABEL: Record<string, string> = { draft: "Draft", testing: "Testing", approved: "Approved", published: "Published", archived: "Archived" };
const STATUS_TONES: Record<string, string> = {
  draft: "border-slate-200 bg-slate-50 text-slate-700",
  testing: "border-sky-200 bg-sky-50 text-sky-800",
  approved: "border-violet-200 bg-violet-50 text-violet-800",
  published: "border-emerald-200 bg-emerald-50 text-emerald-800",
  archived: "border-slate-200 bg-slate-100 text-slate-700",
};
const toList = (text?: string) => String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const stepText = (step: unknown): string => typeof step === "string" ? step : (step && typeof step === "object" && "title" in step ? String((step as { title?: string }).title) : JSON.stringify(step));

type SkillForm = {
  name: string; description: string; whenToUse: string;
  inputs: string; apps: string; permissions: string;
  steps: string; decisionRules: string; outputs: string; failureHandling: string; safety: string;
};
const emptyForm: SkillForm = { name: "", description: "", whenToUse: "", inputs: "", apps: "", permissions: "", steps: "", decisionRules: "", outputs: "", failureHandling: "", safety: "" };

/** Create or edit a skill. */
function SkillFormView({ form, setForm, onSave, onCancel, saving, title }: {
  form: SkillForm; setForm: (value: SkillForm) => void; onSave: () => void; onCancel: () => void; saving: string; title: string;
}) {
  return (
    <form className={card} onSubmit={(event) => { event.preventDefault(); onSave(); }} data-testid="skill-form">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block"><span className={heading}>Name</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className={input} required /></label>
        <label className="block sm:col-span-2"><span className={heading}>Description</span><input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className={input} /></label>
        <label className="block sm:col-span-2"><span className={heading}>When to use (natural language)</span><textarea value={form.whenToUse} onChange={(event) => setForm({ ...form, whenToUse: event.target.value })} className={input} rows={2} /></label>
        <label className="block"><span className={heading}>Steps (one per line)</span><textarea value={form.steps} onChange={(event) => setForm({ ...form, steps: event.target.value })} className={input} rows={4} /></label>
        <label className="block"><span className={heading}>Inputs (JSON array of objects with name/label/type/required)</span><textarea value={form.inputs} onChange={(event) => setForm({ ...form, inputs: event.target.value })} className={input} rows={3} /></label>
        <label className="block"><span className={heading}>Outputs (one per line)</span><textarea value={form.outputs} onChange={(event) => setForm({ ...form, outputs: event.target.value })} className={input} rows={2} /></label>
        <label className="block"><span className={heading}>Permissions (one per line, e.g. browser.navigate, connector.call)</span><textarea value={form.permissions} onChange={(event) => setForm({ ...form, permissions: event.target.value })} className={input} rows={2} /></label>
        <label className="block"><span className={heading}>Safety rules (one per line)</span><textarea value={form.safety} onChange={(event) => setForm({ ...form, safety: event.target.value })} className={input} rows={2} /></label>
        <label className="block sm:col-span-2"><span className={heading}>Failure handling (one per line)</span><textarea value={form.failureHandling} onChange={(event) => setForm({ ...form, failureHandling: event.target.value })} className={input} rows={2} /></label>
        <label className="block sm:col-span-2"><span className={heading}>Decision rules (one per line)</span><textarea value={form.decisionRules} onChange={(event) => setForm({ ...form, decisionRules: event.target.value })} className={input} rows={2} /></label>
      </div>
      {saving && <p className="mt-3 text-sm text-slate-700">{saving}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={button} onClick={onCancel}>Cancel</button>
        <button type="submit" className={primary} disabled={Boolean(saving) || !form.name.trim() || !form.steps.trim()} data-testid="skill-form-save"><Plus size={13} /> {title.startsWith("Add") ? "Create skill" : "Save skill"}</button>
      </div>
    </form>
  );
}

/** Skill detail: config, versions, dry-run test, status transitions, export. */
function SkillPanel({ skill, onClose, refresh }: { skill: Skill; onClose: () => void; refresh: () => Promise<void> }) {
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [tests, setTests] = useState<Array<Record<string, unknown>>>([]);
  const [testOutput, setTestOutput] = useState<Record<string, unknown> | null>(null);
  const [testInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    void workforce.skill(skill.id).then((data) => { setVersions(data.versions); setTests(data.skill.tests.slice(0, 10)); }).catch((e) => setError(e.message));
  }, [skill.id]);
  const act = async (label: string, action: () => Promise<unknown>) => { setError(""); try { const result = await action(); setError(`${label} done.`); if (label === "Test") { const test = ((result as { test?: Record<string, unknown> })?.test); if (test) { setTests((current) => [test as Record<string, unknown>, ...current].slice(0, 10)); setTestOutput(test as Record<string, unknown>); } } } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); } finally { void workforce.skill(skill.id).then((data) => { setVersions(data.versions); setTests(data.skill.tests.slice(0, 10)); }).catch(() => undefined); } };
  const setStatus = (status: string) => workforce.skillSetStatus(skill.id, status).then(() => { void refresh(); setError(`Status set to ${status}.`); }).catch((e) => setError(e instanceof Error ? e.message : "That didn't work."));
  return (
    <section className={card} data-testid={`skill-${skill.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div><h2 className="text-base font-semibold text-slate-900">{skill.name}</h2><p className="mt-1 text-xs text-slate-500">{skill.description}{skill.whenToUse ? ` · ${skill.whenToUse}` : ""}</p></div>
        <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X size={16} /></button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <div><span className={heading}>Status</span><p className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_TONES[skill.status] || ""}`}>{STATUS_LABEL[skill.status] || skill.status}</p></div>
        <div><span className={heading}>Version</span><p className="text-sm text-slate-700">v{skill.version} · {shortDate(skill.publishedAt || skill.createdAt)}</p></div>
        <div><span className={heading}>Source</span><p className="text-sm text-slate-700">{skill.source}</p></div>
      </div>
      <div className="mt-4" data-testid="skill-steps">
        <span className={heading}>Steps</span>
        <ol className="mt-2 list-decimal space-y-1 pl-5">{skill.steps.slice(0, 20).map((step, index) => <li key={index} className="text-sm text-slate-700">{stepText(step)}</li>)}</ol>
      </div>
      {error && <Notice tone="rose">{error}</Notice>}
      {testOutput && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3" data-testid="skill-test-result">
          <span className={heading}>Dry-run test</span>
          <p className={`mt-1 text-sm font-semibold ${testOutput.ready ? "text-emerald-700" : "text-rose-700"}`}>{testOutput.ready ? "Ready — every required input is present." : "Blocked."}</p>
          {(testOutput.issues as string[] | undefined)?.map((issue, index) => <p key={index} className="text-xs text-rose-700">{String(issue)}</p>)}
          {(testOutput.missing as string[] | undefined)?.map((missing, index) => <p key={index} className="text-xs text-amber-900">Missing: {String(missing)}</p>)}
          {Array.isArray(testOutput.actions) && testOutput.actions.length > 0 && <p className="mt-1 text-xs text-slate-600">{String(((testOutput.actions as Array<Record<string, unknown>>)[0]?.action) ?? "")}… would be the first action ({(testOutput.actions as unknown[]).length} planned).</p>}
        </div>
      )}
      <div className="mt-4">
        <span className={heading}>Tests</span>
        <ul className="mt-1 space-y-1">
          {tests.map((test, index) => (
            <li key={index} className="rounded-lg bg-white p-2 text-xs text-slate-700" data-testid="skill-test-row">
              {(test as { ready?: boolean }).ready ? "✓" : "✗"} {(test as { at?: number }).at ? formatTime((test as { at?: number }).at) : ""}
            </li>
          ))}
          {!tests.length && <li className="text-xs text-slate-500">No dry-run tests yet.</li>}
        </ul>
      </div>
      <div className="mt-4">
        <span className={heading}>Versions</span>
        <ul className="mt-2 space-y-1">
          {versions.slice(0, 15).map((version) => <li key={version.version} className="text-xs text-slate-600">v{version.version} — {version.note || "saved"} · {formatTime(version.createdAt)}</li>)}
        </ul>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => void act("Testing", () => workforce.skillTest(skill.id, testInputs))} className={button} data-testid="skill-test"><PlayCircle size={13} /> Dry-run test</button>
        <button type="button" onClick={() => void setStatus("testing")} className={button} data-testid="skill-set-testing">Set to testing</button>
        {skill.status === "testing" && <button type="button" onClick={() => void setStatus("approved")} className={button} data-testid="skill-approve"><CheckCircle2 size={13} /> Approve</button>}
        {skill.status === "approved" && <button type="button" onClick={() => void setStatus("published")} className={primary} data-testid="skill-publish"><Star size={13} /> Publish</button>}
        <button type="button" onClick={() => void workforce.skillExport(skill.id).then((data) => { const text = JSON.stringify(data, null, 2); void navigator.clipboard?.writeText(text).catch(() => undefined); setError("Skill export copied to the clipboard."); }).catch((e) => setError(e instanceof Error ? e.message : "That didn't work."))} className={button} data-testid="skill-export"><Upload size={13} /> Export</button>
        <button type="button" onClick={() => void workforce.skillDelete(skill.id).then(() => { onClose(); void refresh(); }).catch((e) => setError(e instanceof Error ? e.message : "That didn't work."))} className="btn-ghost text-rose-600"><Trash2 size={13} /> Delete</button>
      </div>
    </section>
  );
}

export default function SkillLibraryPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [detail, setDetail] = useState<Skill | null>(null);
  const [createDraft, setCreateDraft] = useState<SkillForm | null>(null);
  const [error, setError] = useState("");
  const [testInputs, setTestInputs] = useState<Record<string, string>>({});
  const [teachEvents, setTeachEvents] = useState<Array<{ id: string; kind: string; createdAt: number; title: string; teachId: string }>>([]);

  const refresh = useCallback(async () => { const data = await workforce.skills(); setSkills(data.skills); }, []);
  useEffect(() => {
    void workforce.events().then((data) => setTeachEvents(data.events.filter((event) => event.kind.startsWith("teach.")).map((event) => ({ id: event.id, kind: event.kind, createdAt: event.createdAt, title: String((event.detail?.title as string) || event.kind), teachId: String(event.detail?.teachId || "") })))).catch(() => undefined);
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(e instanceof Error ? e.message : "That didn't work."));
    const timer = setInterval(() => void workforce.skills().then((data) => setSkills(data.skills)).catch(() => undefined), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const createSkill = async () => {
    setError("");
    try {
      let inputs: unknown[] = [];
      try { inputs = JSON.parse(createDraft!.inputs || "[]") as unknown[]; } catch { setError("Inputs must be a JSON array."); return; }
      const steps = toList(createDraft!.steps);
      if (!steps.length) { setError("A skill needs at least one step."); return; }
      const { skill } = await workforce.skillCreate({
        name: createDraft!.name.trim(), description: createDraft!.description, whenToUse: createDraft!.whenToUse,
        inputs: inputs as never, apps: toList(createDraft!.apps), permissions: toList(createDraft!.permissions),
        steps: steps.map((text) => text.replace(/^\s*\d+[.)]\s*/, "")),
        decisionRules: toList(createDraft!.decisionRules), outputs: toList(createDraft!.outputs),
        failureHandling: createDraft!.failureHandling, safety: toList(createDraft!.safety),
      });
      setCreateDraft(null); setDetail(skill); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); }
  };

  return (
    <main className="mx-auto max-w-6xl px-3 pb-12 pt-5 sm:px-6 sm:pt-8" data-testid="skill-library">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display-title text-[clamp(2.2rem,5vw,3.5rem)]">Skill Library</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">Skills are reusable procedures. Routines run them on a schedule; teammates use them in the Computer Center and the Browser. Create a skill, or teach one from your screen and compile the demonstration.</p>
        </div>
        <button type="button" onClick={() => setCreateDraft(emptyForm)} className={primary} data-testid="new-skill"><Plus size={16} /> New skill</button>
      </div>
      {error && <Notice tone="rose" role="alert">{error}</Notice>}

      <section className="mb-6" aria-label="Skills">
        <div className="mb-3 flex items-center justify-between"><span className={heading}>Skills</span><button type="button" onClick={() => void refresh()} className="btn-outline text-xs"><RefreshCw size={12} /> Refresh</button></div>
        {skills.length === 0 ? (
          <div className={card} data-testid="skills-empty"><p className="text-sm text-slate-500">No skills yet. Skills come from your teammates' templates, learned demonstrations and manual creation here.</p></div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {skills.map((skill) => (
              <li key={skill.id} className={card} data-testid={`skill-${skill.id}`}>
                <div className="flex items-center gap-2"><BookOpen size={18} className="text-slate-900" /><h3 className="text-sm font-semibold text-slate-900 truncate">{skill.name}</h3></div>
                <p className="mt-1 text-xs text-slate-500">{skill.description}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_TONES[skill.status] || ""}`}>{STATUS_LABEL[skill.status] || skill.status}</span>
                  <span className="pill-badge" data-status={skill.status}>v{skill.version}</span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600">{skill.steps.length} steps</span>
                  {skill.source !== "manual" && <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600">{skill.source}</span>}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" onClick={() => setDetail(skill)} className={button} data-testid={`skill-open-${skill.id}`}><CheckCircle2 size={13} /> Open</button>
                  <button type="button" onClick={() => workforce.skillTest(skill.id).then((result) => setError(result.test ? `Dry-run: ${(result.test.ready ? "ready" : "blocked")}` : "Test ran.")).catch((e) => setError(e.message))} className={button} data-testid={`skill-test-quick-${skill.id}`}><PlayCircle size={13} /> Test</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Teach a skill from a demonstration">
        <span className={heading}>Teach mode — from your screen</span>
        <p className="mt-1 text-sm text-slate-500">Start a demonstration, do the steps in the Computer Center, then compile. Compiled skills are drafts until you test and approve them. Audio and form values are never recorded.</p>
        <form className="mt-3 grid gap-2 sm:grid-cols-[1fr_120px] sm:items-end" onSubmit={(event) => { event.preventDefault(); }}>
          <label className="block"><input value={testInputs.title || ""} onChange={(event) => setTestInputs({ ...testInputs, title: event.target.value })} placeholder="What you're teaching, e.g. the weekly report" className={input} data-testid="teach-title" required /></label>
          <button type="submit" className={primary} data-testid="teach-start" onClick={() => workforce.teachStart({ title: testInputs.title || "" }).then((r) => setError(`Teaching started (${r.session?.id || "id"}). Do the steps in the Computer Center, then compile.`)).catch((e) => setError(e instanceof Error ? e.message : "That didn't work."))}><PlayCircle size={13} /> Start demo</button>
        </form>
        {teachEvents.length > 0 && (
          <ul className="mt-3 space-y-2">
            {teachEvents.map((teach) => (
              <li key={teach.id} className={card} data-testid={`teach-${teach.teachId}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">{teach.title}</span>
                  <span className="pill-badge" data-status={teach.kind}>{teach.kind.replace("teach.", "").replace(/^./, (c) => c.toUpperCase())}</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">{teach.teachId || "—"} · {formatTime(teach.createdAt)}</p>
                <div className="mt-2 flex gap-2">
                  {teach.kind === "teach.started" && teach.teachId && (
                    <>
                      <button type="button" onClick={() => workforce.teachCompile(teach.teachId).then(() => { setError("Demonstration compiled — check the skills above."); void refresh(); }).catch((e) => setError(e instanceof Error ? e.message : "That didn't work."))} className={primary} data-testid={`teach-compile-${teach.teachId}`}><Upload size={13} /> Compile skill</button>
                      <button type="button" onClick={() => workforce.teachCancel(teach.teachId).catch(() => undefined)} className="btn-ghost text-rose-600"><Trash2 size={13} /> Cancel</button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {createDraft && (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-2 sm:p-6" data-testid="skill-create-modal">
          <div className={card} style={{ maxWidth: "46rem" }}>
            <SkillFormView form={createDraft} setForm={setCreateDraft} onSave={() => void createSkill()} onCancel={() => setCreateDraft(null)} saving="" title="New skill" />
          </div>
        </div>
      )}

      {detail && <SkillPanel skill={detail} onClose={() => setDetail(null)} refresh={refresh} />}
    </main>
  );
}
