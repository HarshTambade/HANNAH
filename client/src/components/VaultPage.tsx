/**
 * Secure Vault — application credentials live here, masked. Bots get a
 * reference and the server injects the value; the raw value never enters
 * chat or memory. Values are never returned: add and edit are the only
 * places they are typed, and they are masked as bullets.
 */
import { useCallback, useEffect, useState } from "react";
import { KeyRound, Pencil, Plus, RefreshCw, Upload, X } from "lucide-react";
import workforce, { type Secret } from "../services/Workforce";

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
const KINDS = ["password", "token", "oauth", "pin", "other"] as const;
const SCOPES = ["user", "team", "device", "bot", "project"] as const;

type SecretForm = { id: string; name: string; application: string; kind: string; value: string; botIds: string[]; scopes: string[] };
const emptyForm: SecretForm = { id: "", name: "", application: "", kind: "password", value: "", botIds: [], scopes: ["user", "team"] };

/** Add or edit a credential. The value is typed once and never re-displayed. */
function SecretForm({ form, setForm, onSave, onCancel, saving }: {
  form: SecretForm; setForm: (value: SecretForm | null) => void; onSave: () => void; onCancel: () => void; saving?: string;
}) {
  return (
    <form className={card} onSubmit={(event) => { event.preventDefault(); onSave(); }} data-testid="secret-form">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">{form.id ? "Edit credential" : "Add a credential"}</h2>
        <button type="button" onClick={onCancel} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X size={16} /></button>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block"><span className={heading}>Name</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className={input} required placeholder="Stripe API key" /></label>
        <label className="block"><span className={heading}>Application</span><input value={form.application} onChange={(event) => setForm({ ...form, application: event.target.value })} className={input} required placeholder="stripe" /></label>
        <label className="block"><span className={heading}>Kind</span>
          <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })} className={input}>{KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select>
        </label>
        <label className="block"><span className={heading}>Value</span><input type="password" autoComplete="off" value={form.value} onChange={(event) => setForm({ ...form, value: event.target.value })} className={input} required={!form.id} placeholder={form.id ? "Change value — leave empty to keep it" : "Enter the credential value"} /></label>
        <label className="block sm:col-span-2"><span className={heading}>Scopes (where teammates may use it)</span>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">{SCOPES.map((scope) => <label key={scope} className="flex items-center gap-1.5 text-sm text-slate-700"><input type="checkbox" checked={form.scopes.includes(scope)} onChange={() => setForm({ ...form, scopes: form.scopes.includes(scope) ? form.scopes.filter((item) => item !== scope) : [...form.scopes, scope] })} /> {scope}</label>)}</div>
        </label>
      </div>
      {saving && <p className="mt-3 text-sm text-slate-700">{saving}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={button} onClick={onCancel}>Cancel</button>
        <button type="submit" className={primary} disabled={Boolean(saving) || !form.name.trim() || !form.application.trim() || (!form.id && !form.value.trim())}><Upload size={13} /> {form.id ? "Save changes" : "Add credential"}</button>
      </div>
    </form>
  );
}

export default function VaultPage() {
  const [status, setStatus] = useState<{ configured: boolean; note: string } | null>(null);
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [teammates, setTeammates] = useState<Array<{ id: string; name: string }>>([]);
  const [form, setForm] = useState<SecretForm | null>(null);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [data, vault, bots] = await Promise.all([
      workforce.vaultSecrets(), workforce.vaultStatus(), workforce.bots(),
    ]);
    setSecrets(data.secrets);
    setStatus(vault);
    setTeammates(bots.bots.slice(0, 50).map((bot) => ({ id: bot.id, name: bot.name })));
  }, []);

  useEffect(() => {
    void refresh().catch((e) => setError(e instanceof Error ? e.message : "That didn't work."));
    const timer = setInterval(() => void workforce.vaultSecrets().then((data) => setSecrets(data.secrets)).catch(() => undefined), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const save = async () => {
    setSaving("Saving…"); setError("");
    try {
      if (form!.id) await workforce.vaultEdit(form!.id, { name: form!.name, application: form!.application, kind: form!.kind, value: form!.value || undefined, botIds: form!.botIds, scopes: form!.scopes });
      else await workforce.vaultAdd({ name: form!.name, application: form!.application, kind: form!.kind, value: form!.value, botIds: form!.botIds, scopes: form!.scopes });
      setForm(null); setError("Saved."); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); }
    finally { setSaving(""); }
  };

  const edit = (secret: Secret) => setForm({ id: secret.id, name: secret.name, application: secret.application, kind: secret.kind, value: "", botIds: secret.botIds, scopes: secret.scopes });
  const revoke = (secret: Secret) => { setSaving("Revoking…"); workforce.vaultRevoke(secret.id).then(() => { setError("Revoked."); setForm(null); void refresh(); }).catch((e) => setError(e instanceof Error ? e.message : "That didn't work.")); };
  const recordUse = (id: string) => workforce.vaultUse(id).then(() => setError("The vault recorded the use.")).catch((e) => setError(e instanceof Error ? e.message : "That didn't work."));

  return (
    <main className="mx-auto max-w-6xl px-3 pb-12 pt-5 sm:px-6 sm:pt-8" data-testid="vault-page">
      <div className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="display-title text-[clamp(2.2rem,5vw,3.5rem)]">Secure Vault</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-500">Application credentials live here, masked. Teammates reference them by name and id; the raw value never enters chat or memory, and bots can only use the scopes and teammates you assign.</p>
          </div>
          <button type="button" onClick={() => setForm(emptyForm)} className={primary} data-testid="add-secret"><Plus size={16} /> Add credential</button>
        </div>
        {status && (status.configured ? null : <Notice tone="amber">The Secure Vault isn't configured on this server yet. Configure HANNAH_VAULT_KEY (or a self-hosted key source) to store credentials.</Notice>)}
      </div>
      {error && <Notice tone="rose" role="alert">{error}</Notice>}

      <section className="mb-6" aria-label="Credentials">
        <div className="mb-3 flex items-center justify-between"><span className={heading}>Credentials</span><button type="button" onClick={() => void refresh()} className="btn-outline text-xs"><RefreshCw size={12} /> Refresh</button></div>
        {secrets.length === 0 ? (
          <div className={card} data-testid="vault-empty"><p className="text-sm text-slate-500">No credentials yet. The Vault stores passwords, tokens, pins and other application secrets.</p></div>
        ) : (
          <ul className="space-y-3" data-testid="vault-secrets">
            {secrets.map((secret) => (
              <li key={secret.id} className={card} data-testid={`secret-${secret.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <KeyRound size={18} className="text-slate-700" />
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{secret.name}{secret.revoked ? <span className="ml-2 text-xs font-normal text-slate-500">revoked</span> : null}</p>
                      <p className="text-xs text-slate-500">{secret.application} · {secret.kind} · {secret.hint ? `•••• ${secret.hint}` : "no hint"} · {secret.botIds.length ? `${secret.botIds.length} teammates` : "no teammates assigned"}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-600">used {formatTime(secret.lastUsedAt)}</span>
                    <button type="button" onClick={() => recordUse(secret.id)} disabled={secret.revoked} className={button} data-testid={`secret-use-${secret.id}`}><Upload size={12} /> Use</button>
                    <button type="button" onClick={() => edit(secret)} className={button} data-testid={`secret-edit-${secret.id}`}><Pencil size={12} /> Edit</button>
                    <button type="button" onClick={() => revoke(secret)} className="btn-ghost text-rose-600" data-testid={`secret-revoke-${secret.id}`}><X size={12} /> Revoke</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {form && (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-2 sm:p-6" data-testid="secret-modal">
          <div className={card} style={{ maxWidth: "34rem" }}>
            <SecretForm form={form} setForm={setForm as (value: SecretForm | null) => void} onSave={() => void save()} onCancel={() => setForm(null)} saving={saving} />
            {form && form.botIds.length > 0 && <p className="mt-2 text-xs text-slate-500">Assign to teammates: {form.botIds.map((id) => teammates.find((bot) => bot.id === id)?.name || id).join(", ")}</p>}
          </div>
        </div>
      )}
    </main>
  );
}
