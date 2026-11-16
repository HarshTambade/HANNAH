import { useEffect, useState, type ChangeEvent } from "react";
import { AlertTriangle, Check, FileJson, ShieldCheck, Trash2 } from "lucide-react";
import { COMMUNITY_SKILLS_EVENT, CommunitySkills, MAX_ENABLED, validateManifest, type InstalledSkill, type ValidationResult } from "../services/CommunitySkills";

const EXAMPLE = JSON.stringify({
  manifestVersion: 1,
  id: "dev.example.meeting-notes",
  type: "instruction-skill",
  name: "Meeting notes",
  description: "Turns rough notes into decisions, owners and next steps.",
  version: "1.0.0",
  publisher: { name: "Example Labs", url: "https://example.dev" },
  category: "Productivity",
  license: "MIT",
  permissions: [],
  privacy: { dataLeavesDevice: false, notes: "Adds guidance text only." },
  instructions: "When the user shares meeting notes, reply with three short sections: Decisions, Owners and Next steps. Keep each item to one line and ask before inventing missing owners.",
}, null, 2);

/** Install community instruction skills from a manifest. Nothing executable is accepted. */
export default function CommunitySkillsPanel() {
  const [source, setSource] = useState("");
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [installed, setInstalled] = useState<InstalledSkill[]>(() => CommunitySkills.list());
  const [message, setMessage] = useState("");

  useEffect(() => {
    const refresh = () => setInstalled(CommunitySkills.list());
    window.addEventListener(COMMUNITY_SKILLS_EVENT, refresh);
    return () => window.removeEventListener(COMMUNITY_SKILLS_EVENT, refresh);
  }, []);

  const check = async (text = source) => {
    setMessage("");
    setResult(await validateManifest(text));
  };
  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 32_000) { setResult({ ok: false, errors: ["Manifest files must be under 32 KB."] }); return; }
    const text = await file.text();
    setSource(text);
    await check(text);
  };

  return (
    <section className="deck-frame mt-8" aria-label="Community skills">
      <div className="deck-card tone-mint">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-xl font-medium tracking-tight text-ink">Community skills</h2>
          <span className="pill-badge"><ShieldCheck size={13} className="text-teal-600" /> Instruction skills only</span>
        </div>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-700">
          Install a skill someone shared as a HANNAH manifest. Skills add guidance text that shapes replies. They can't run code, use tools or request permissions, and they never override the Guardian or your approvals. Executable plugins aren't accepted until signing and sandboxing are in place.
        </p>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            <label htmlFor="skill-manifest" className="mb-1.5 block text-xs font-medium text-slate-600">Manifest JSON</label>
            <textarea id="skill-manifest" value={source} onChange={(event) => { setSource(event.target.value); setResult(null); }} rows={10} spellCheck={false} placeholder="Paste a skill manifest…"
              className="w-full rounded-2xl border border-white/80 bg-white/80 p-3 font-mono text-xs text-ink outline-none focus:border-teal-400" />
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="btn-primary" disabled={!source.trim()} onClick={() => void check()}>Check manifest</button>
              <label className="btn-outline cursor-pointer"><FileJson size={14} /> Open file<input type="file" accept="application/json,.json" className="sr-only" onChange={(event) => void loadFile(event)} /></label>
              <button type="button" className="btn-ghost" onClick={() => { setSource(EXAMPLE); setResult(null); }}>Load an example</button>
            </div>
          </div>

          <div className="rounded-2xl bg-white/70 p-4 text-sm" aria-live="polite">
            {!result && <p className="text-slate-500">Check a manifest to see its publisher, permissions and privacy before installing.</p>}
            {result && !result.ok && (
              <div role="alert">
                <p className="flex items-center gap-1.5 font-medium text-rose-700"><AlertTriangle size={15} /> Can't install this skill</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-rose-800">{result.errors.map((error) => <li key={error}>{error}</li>)}</ul>
              </div>
            )}
            {result?.ok && (
              <div>
                <p className="font-display text-base font-medium text-ink">{result.manifest.name} <span className="text-xs font-normal text-slate-500">v{result.manifest.version}</span></p>
                <p className="mt-1 text-slate-700">{result.manifest.description}</p>
                <dl className="mt-3 grid grid-cols-[8rem_minmax(0,1fr)] gap-y-1.5 text-xs">
                  <dt className="text-slate-500">Publisher</dt><dd className="text-ink">{result.manifest.publisher.name}{result.manifest.publisher.url ? ` · ${result.manifest.publisher.url}` : ""} {result.signature.status === "trusted" ? `(verified: ${result.signature.trustedName})` : "(not verified)"}</dd>
                  <dt className="text-slate-500">Signature</dt><dd className="text-ink">{result.signature.status === "trusted" ? "Signed by a trusted publisher" : result.signature.status === "signed" ? `Signed by an unknown key · ${result.signature.fingerprint}` : result.signature.status === "unverifiable" ? "Signed, but this browser can't check it" : "Not signed"}</dd>
                  <dt className="text-slate-500">Permissions</dt><dd className="text-ink">None: guidance text only</dd>
                  <dt className="text-slate-500">Privacy</dt><dd className="text-ink">{result.manifest.privacy.dataLeavesDevice ? "Publisher says data leaves the device" : "No data leaves your device because of this skill"}{result.manifest.privacy.notes ? `. ${result.manifest.privacy.notes}` : ""}</dd>
                  <dt className="text-slate-500">License</dt><dd className="text-ink">{result.manifest.license}</dd>
                  <dt className="text-slate-500">Integrity</dt><dd className="text-ink">{result.integrity === "verified" ? "SHA-256 matches the instructions" : "No hash provided"}</dd>
                </dl>
                <details className="mt-3 text-xs"><summary className="cursor-pointer text-slate-600">Read the instructions</summary><p className="mt-1.5 whitespace-pre-wrap rounded-xl bg-slate-50 p-2 text-slate-700">{result.manifest.instructions}</p></details>
                {result.warnings.map((warning) => <p key={warning} className="mt-2 text-xs text-amber-800">{warning}</p>)}
                <button type="button" className="btn-primary mt-3" onClick={() => { CommunitySkills.install(result.manifest, result.integrity, result.signature); setMessage(`${result.manifest.name} installed. Turn it on below.`); setResult(null); setSource(""); }}>Install skill</button>
              </div>
            )}
            {message && <p role="status" className="mt-2 text-xs text-teal-800">{message}</p>}
          </div>
        </div>

        {installed.length > 0 && (
          <ul className="mt-4 space-y-2" aria-label="Installed community skills">
            {installed.map((item) => (
              <li key={item.manifest.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white/80 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{item.manifest.name} <span className="text-xs font-normal text-slate-500">v{item.manifest.version} · {item.manifest.publisher.name}</span></p>
                  <p className="text-xs text-slate-500">{item.signature?.status === "trusted" ? `Trusted publisher: ${item.signature.trustedName}` : item.signature?.status === "signed" ? "Signed (unknown key)" : item.integrity === "verified" ? "Integrity hash matches" : "Unsigned"} · installed {new Date(item.installedAt).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" role="switch" aria-checked={item.enabled} aria-label={`${item.enabled ? "Turn off" : "Turn on"} ${item.manifest.name}`}
                    onClick={() => { try { CommunitySkills.setEnabled(item.manifest.id, !item.enabled); setMessage(""); } catch (error) { setMessage(error instanceof Error ? error.message : `Up to ${MAX_ENABLED} skills can be on.`); } }}
                    className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${item.enabled ? "bg-emerald-100 text-emerald-800" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}>
                    {item.enabled && <Check size={12} />}{item.enabled ? "On" : "Off"}
                  </button>
                  <button type="button" aria-label={`Remove ${item.manifest.name}`} onClick={() => CommunitySkills.uninstall(item.manifest.id)} className="rounded-lg p-2 text-slate-500 transition hover:bg-rose-50 hover:text-rose-700"><Trash2 size={13} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
