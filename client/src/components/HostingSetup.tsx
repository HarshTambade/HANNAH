import { useState, type FormEvent } from "react";
import { Check, CircleAlert, Clipboard, ExternalLink, Loader2, Rocket } from "lucide-react";
import { apiFetch, apiUrl } from "../services/api";
import { copyText } from "../services/clipboard";

type VercelProject = { id: string; name: string; teamId: string | null; team: string; domains: string[]; serves: boolean; git: boolean };
type Discovery = { host: string; vercel: { projects: VercelProject[] }; supabase: { organizations: Array<{ slug: string; name: string }>; projects: Array<{ ref: string; name: string; region: string; status: string }> } };
type Finish = { saved: string[]; deployment: { url: string | null; inspector: string | null } | null; secrets: { HANNAH_VAULT_KEY: string; CRON_SECRET: string } };
type StepState = "waiting" | "running" | "done" | "failed";

const REGIONS: Array<[string, string]> = [["ap-south-1", "Mumbai"], ["ap-southeast-1", "Singapore"], ["eu-central-1", "Frankfurt"], ["eu-west-2", "London"], ["us-east-1", "N. Virginia"], ["us-west-1", "N. California"], ["ap-northeast-1", "Tokyo"], ["ap-southeast-2", "Sydney"], ["sa-east-1", "São Paulo"], ["ca-central-1", "Canada"]];
const STEPS = ["Database", "Waiting for the database", "Connecting and saving settings in Vercel", "Deploying"];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class SetupError extends Error {
  constructor(message: string, readonly reason?: string, readonly body?: Record<string, unknown>) { super(message); }
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(apiUrl(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  const data = await response.json().catch(() => ({})) as T & { error?: string; reason?: string };
  if (!response.ok) throw new SetupError(data.error || `The server answered ${response.status}.`, data.reason, data as Record<string, unknown>);
  return data;
}

/**
 * Connect this HANNAH deployment to Vercel and Supabase with your own tokens:
 * it creates the database, saves the settings in Vercel and deploys (server/hosting-setup.js).
 * The tokens live only in this page's memory.
 */
export default function HostingSetup() {
  const [vercelToken, setVercelToken] = useState("");
  const [supabaseToken, setSupabaseToken] = useState("");
  const [found, setFound] = useState<Discovery | null>(null);
  const [projectId, setProjectId] = useState("");
  const [mode, setMode] = useState<"new" | "reset">("new");
  const [organization, setOrganization] = useState("");
  const [region, setRegion] = useState("ap-south-1");
  const [existingRef, setExistingRef] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [steps, setSteps] = useState<StepState[] | null>(null);
  const [needsReplace, setNeedsReplace] = useState<{ message: string; resume: () => void } | null>(null);
  const [done, setDone] = useState<Finish | null>(null);
  const [copied, setCopied] = useState("");

  const discover = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await post<Discovery>("/api/setup/hosting/discover", { vercelToken: vercelToken.trim(), supabaseToken: supabaseToken.trim() });
      setFound(result);
      setProjectId(result.vercel.projects.find((project) => project.serves)?.id || result.vercel.projects[0]?.id || "");
      setOrganization(result.supabase.organizations[0]?.slug || "");
      setExistingRef(result.supabase.projects[0]?.ref || "");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const mark = (index: number, state: StepState) => setSteps((current) => (current || STEPS.map(() => "waiting" as StepState)).map((value, at) => (at === index ? state : value)));

  const run = async () => {
    const project = found?.vercel.projects.find((item) => item.id === projectId);
    if (!project) return;
    setBusy(true);
    setError("");
    setSteps(STEPS.map(() => "waiting"));
    let step = 0;
    try {
      mark(0, "running");
      const database = await post<{ projectRef: string; databasePassword: string }>("/api/setup/hosting/database", mode === "new"
        ? { supabaseToken, mode, organizationSlug: organization, region }
        : { supabaseToken, mode, projectRef: existingRef, confirmReset });
      mark(0, "done");
      step = 1;
      mark(1, "running");
      for (let tries = 0; ; tries += 1) {
        const status = await post<{ ready: boolean; status: string }>("/api/setup/hosting/status", { supabaseToken, projectRef: database.projectRef });
        if (status.ready) break;
        if (tries > 60) throw new SetupError(`The database is still starting (${status.status}). Run the setup again in a few minutes; it picks up where it stopped.`);
        await pause(5_000);
      }
      mark(1, "done");
      step = 2;
      mark(2, "running");
      const finish = async (replace: boolean): Promise<Finish> => {
        // Supabase's pooler can take a minute after the database is up.
        for (let tries = 0; ; tries += 1) {
          try {
            return await post<Finish>("/api/setup/hosting/finish", { vercelToken, teamId: project.teamId, projectId: project.id, supabaseToken, projectRef: database.projectRef, databasePassword: database.databasePassword, replace });
          } catch (failure) {
            if (failure instanceof SetupError && ["database-not-ready", "pooler-not-ready"].includes(failure.reason || "") && tries < 12) { await pause(10_000); continue; }
            throw failure;
          }
        }
      };
      let result: Finish;
      try {
        result = await finish(false);
      } catch (failure) {
        if (!(failure instanceof SetupError) || failure.reason !== "exists") throw failure;
        // Ask before replacing existing settings.
        result = await new Promise<Finish>((resolve, reject) => setNeedsReplace({ message: failure.message, resume: () => { setNeedsReplace(null); finish(true).then(resolve, reject); } }));
      }
      mark(2, "done");
      step = 3;
      mark(3, result.deployment ? "done" : "failed");
      setDone(result);
      setVercelToken("");
      setSupabaseToken("");
    } catch (failure) {
      mark(step, "failed");
      setError(failure instanceof Error ? failure.message : "Setup didn't complete.");
    } finally {
      setBusy(false);
    }
  };

  const copy = (label: string, value: string) => { void copyText(value).then((copied) => copied && setCopied(label)); };
  const field = "min-w-0 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-ink outline-none focus:border-sky-400";
  const project = found?.vercel.projects.find((item) => item.id === projectId);

  return (
    <section aria-label="Set up HANNAH on Vercel and Supabase" className="rounded-2xl border border-sky-200 bg-sky-50/60 p-4 sm:p-5">
      <p className="flex items-center gap-2 text-sm font-semibold text-ink"><Rocket size={15} className="text-sky-700" /> Set up HANNAH on Vercel and Supabase</p>
      <p className="mt-1 text-xs leading-5 text-slate-600">HANNAH creates its database in your Supabase account, saves the settings in your Vercel project and deploys. Your tokens stay in this page and go only to Vercel and Supabase; nothing is stored.</p>

      {!found && (
        <form onSubmit={discover} className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-slate-700">
            Vercel token <a href="https://vercel.com/account/settings/tokens" target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-0.5 font-normal text-sky-700 underline">create one <ExternalLink size={10} /></a>
            <input type="password" value={vercelToken} onChange={(event) => setVercelToken(event.target.value)} autoComplete="off" spellCheck={false} className={`${field} mt-1 font-mono`} placeholder="Full access to the team with HANNAH" />
          </label>
          <label className="text-xs font-medium text-slate-700">
            Supabase token <a href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-0.5 font-normal text-sky-700 underline">create one <ExternalLink size={10} /></a>
            <input type="password" value={supabaseToken} onChange={(event) => setSupabaseToken(event.target.value)} autoComplete="off" spellCheck={false} className={`${field} mt-1 font-mono`} placeholder="sbp_…" />
          </label>
          <button type="submit" disabled={busy || !vercelToken.trim() || !supabaseToken.trim()} className="btn-primary !py-2 text-xs sm:col-span-2 sm:justify-self-start">{busy ? "Looking…" : "Find my projects"}</button>
        </form>
      )}

      {found && !done && (
        <div className="mt-3 space-y-3 text-xs text-slate-700">
          <label className="block font-medium">
            Vercel project
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={busy} className={`${field} mt-1`}>
              {found.vercel.projects.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.team}{item.serves ? ` · serves ${found.host}` : ""}</option>)}
            </select>
          </label>
          {project && !project.serves && <p className="flex items-start gap-1.5 text-amber-800"><CircleAlert size={13} className="mt-0.5 shrink-0" /> This project doesn't serve {found.host}. Check it's the one running HANNAH.</p>}
          {project && !project.git && <p className="flex items-start gap-1.5 text-amber-800"><CircleAlert size={13} className="mt-0.5 shrink-0" /> It isn't linked to GitHub, so HANNAH can't deploy it: redeploy from Vercel after the setup.</p>}
          <fieldset className="space-y-2">
            <legend className="font-medium">Supabase database</legend>
            <label className="flex items-start gap-2"><input type="radio" checked={mode === "new"} onChange={() => setMode("new")} disabled={busy} className="mt-0.5" /> <span><strong>A new project for HANNAH</strong> (recommended; Supabase's free plan allows two)</span></label>
            {mode === "new" && (
              <div className="ml-6 grid gap-2 sm:grid-cols-2">
                <select aria-label="Supabase organization" value={organization} onChange={(event) => setOrganization(event.target.value)} disabled={busy} className={field}>
                  {found.supabase.organizations.map((org) => <option key={org.slug} value={org.slug}>{org.name}</option>)}
                </select>
                <select aria-label="Region" value={region} onChange={(event) => setRegion(event.target.value)} disabled={busy} className={field}>
                  {REGIONS.map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
                </select>
              </div>
            )}
            {found.supabase.projects.length > 0 && <label className="flex items-start gap-2"><input type="radio" checked={mode === "reset"} onChange={() => setMode("reset")} disabled={busy} className="mt-0.5" /> <span>An existing project</span></label>}
            {mode === "reset" && (
              <div className="ml-6 space-y-2">
                <select aria-label="Existing Supabase project" value={existingRef} onChange={(event) => setExistingRef(event.target.value)} disabled={busy} className={field}>
                  {found.supabase.projects.map((item) => <option key={item.ref} value={item.ref}>{item.name} · {item.region}</option>)}
                </select>
                <label className="flex items-start gap-2 text-amber-900"><input type="checkbox" checked={confirmReset} onChange={(event) => setConfirmReset(event.target.checked)} disabled={busy} className="mt-0.5" /> HANNAH sets a new database password for it. Anything else using the old password stops connecting.</label>
              </div>
            )}
          </fieldset>
          {!steps && <button type="button" onClick={() => void run()} disabled={busy || !project || (mode === "new" ? !organization : !existingRef || !confirmReset)} className="btn-primary !py-2 text-xs">Set up HANNAH</button>}
        </div>
      )}

      {steps && (
        <ol className="mt-3 space-y-1.5 text-xs" aria-label="Setup progress">
          {STEPS.map((label, index) => (
            <li key={label} className="flex items-center gap-2">
              {steps[index] === "running" ? <Loader2 size={13} className="animate-spin text-sky-700" /> : steps[index] === "done" ? <Check size={13} className="text-emerald-600" /> : steps[index] === "failed" ? <CircleAlert size={13} className="text-rose-600" /> : <span className="h-3 w-3 rounded-full border border-slate-300" />}
              <span className={steps[index] === "waiting" ? "text-slate-400" : "text-slate-700"}>{index === 0 ? (mode === "new" ? "Creating the Supabase project" : "Setting a new database password") : label}{index === 1 && steps[index] === "running" ? " (usually 1–2 minutes)" : ""}</span>
            </li>
          ))}
        </ol>
      )}
      {needsReplace && (
        <div role="alertdialog" aria-label="Replace existing settings" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <p>{needsReplace.message}</p>
          <button type="button" onClick={needsReplace.resume} className="btn-outline mt-2 !py-1.5 text-xs">Replace them</button>
        </div>
      )}
      {error && <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</p>}

      {done && (
        <div role="status" className="mt-3 space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
          <p className="font-semibold">HANNAH's database is ready and its settings are saved in Vercel.</p>
          <p>{done.deployment ? <>It's deploying now{done.deployment.inspector ? <> (<a href={done.deployment.inspector} target="_blank" rel="noreferrer" className="underline">follow it on Vercel</a>)</> : null}. In a minute or two, reload: Settings → Account will offer sign-up.</> : "Redeploy the project from Vercel's dashboard so the settings apply."}</p>
          <p>Keep a copy of these; they're shown only now.</p>
          {(["HANNAH_VAULT_KEY", "CRON_SECRET"] as const).map((key) => (
            <div key={key} className="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5 font-mono text-[11px] text-slate-700">
              <span className="min-w-0 flex-1 break-all">{key}={done.secrets[key]}</span>
              <button type="button" aria-label={`Copy ${key}`} onClick={() => copy(key, done.secrets[key])} className="rounded p-1 text-slate-500 hover:text-ink">{copied === key ? <Check size={12} /> : <Clipboard size={12} />}</button>
            </div>
          ))}
          <p>For schedules and long workflows, add <code>CRON_SECRET</code> and <code>HANNAH_PRODUCTION_URL</code> (https://{found?.host}) as GitHub repository secrets: the repository's scheduled tick then runs every 5 minutes.</p>
        </div>
      )}
    </section>
  );
}
