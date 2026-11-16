import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Clipboard, Cpu, ExternalLink, RefreshCw, Sparkles } from "lucide-react";
import { apiFetch, apiUrl, isLocalDevelopmentHost } from "../services/api";
import {
  PROFILES_REVIEWED, TIER_DESCRIPTIONS, applyToChat, defaultHardware, detectHardware, loadHardware, recommend, saveHardware, suggestedReserveGB,
  type AdvisorNeeds, type Budget, type GpuKind, type HardwareProfile, type ModelCatalog, type OperatingSystem, type Priority, type Recommendation, type Task,
} from "../services/ModelAdvisor";

const tasks: Array<[Task, string]> = [
  ["chat", "Everyday chat"], ["coding", "Coding"], ["reasoning", "Reasoning"], ["research", "Research"],
  ["vision", "Images"], ["private-docs", "Private documents"], ["agentic", "Multi-step tasks"],
];
const priorities: Array<[Priority, string]> = [
  ["best", "Best overall"], ["cheapest", "Cheapest"], ["fastest", "Fastest"], ["coding", "Best coding"],
  ["reasoning", "Best reasoning"], ["local", "Best local"], ["privacy", "Privacy-first"], ["multimodal", "Best multimodal"],
];
const budgets: Array<[Budget, string, string]> = [
  ["free-local", "Free · open-weight", "Open models on your own device. Open weights don't always mean unrestricted commercial use."],
  ["free-hosted", "Free hosted tiers", "Providers' free tiers. Rate limits apply and may change."],
  ["low-cost", "Low-cost API", `Paid models up to $2 per million output tokens.`],
  ["professional", "Professional", "Any model, including premium reasoning and coding models."],
  ["personal-compute", "My own computer", "Run on your hardware with no per-token charges."],
  ["hybrid", "Hybrid", "Local for routine and private work, cloud for demanding tasks."],
];
const contexts: Array<[number, string]> = [[4096, "4K"], [8192, "8K"], [32768, "32K"], [131072, "128K"]];
const osOptions: Array<[OperatingSystem, string]> = [["macos", "macOS"], ["windows", "Windows"], ["linux", "Linux"], ["chromeos", "ChromeOS"], ["android", "Android"], ["ios", "iOS"], ["unknown", "Other"]];
const gpuOptions: Array<[GpuKind, string]> = [["none", "No GPU / unsure"], ["integrated", "Integrated GPU"], ["discrete", "Dedicated GPU (NVIDIA/AMD)"], ["apple", "Apple Silicon"]];
const NEEDS_KEY = "hannah.advisor.needs.v1";

function Panel({ title, tone, children, aside }: { title: string; tone: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="deck-frame" aria-label={title}>
      <div className={`deck-card ${tone}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-medium tracking-tight text-ink">{title}</h2>
          {aside}
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </section>
  );
}

function Chips<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(([id, text]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} onClick={() => onChange(id)}
          className={`rounded-xl px-3 py-1.5 text-[13px] font-medium transition ${value === id ? "bg-ink text-white" : "bg-white/70 text-slate-600 hover:bg-white hover:text-ink"}`}>
          {text}
        </button>
      ))}
    </div>
  );
}

function NumberField({ id, label, value, onChange, suffix, placeholder }: { id: string; label: string; value: number | null; onChange: (value: number | null) => void; suffix: string; placeholder?: string }) {
  return (
    <label htmlFor={id} className="block text-xs font-medium text-slate-600">
      {label}
      <span className="mt-1 flex items-center rounded-xl border border-white/80 bg-white/80 pr-3 focus-within:border-sky-400">
        <input id={id} type="number" inputMode="decimal" min={0} step="any" value={value ?? ""} placeholder={placeholder}
          onChange={(event) => onChange(event.target.value === "" ? null : Math.max(0, Number(event.target.value)))}
          className="min-w-0 flex-1 bg-transparent px-3 py-2 text-base text-ink outline-none sm:text-sm" />
        <span className="text-xs text-slate-500">{suffix}</span>
      </span>
    </label>
  );
}

function SelectField<T extends string>({ id, label, value, options, onChange }: { id: string; label: string; value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  return (
    <label htmlFor={id} className="block text-xs font-medium text-slate-600">
      {label}
      <select id={id} value={value} onChange={(event) => onChange(event.target.value as T)}
        className="mt-1 w-full rounded-xl border border-white/80 bg-white/80 px-3 py-2 text-base text-ink outline-none focus:border-sky-400 sm:text-sm">
        {options.map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>)}
      </select>
    </label>
  );
}

function loadNeeds(): AdvisorNeeds {
  const fallback: AdvisorNeeds = { task: "chat", budget: "free-hosted", priority: "best", contextTokens: 8192, monthlyMessages: 600 };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(NEEDS_KEY) || "null");
    return parsed && typeof parsed === "object" ? { ...fallback, ...parsed } : fallback;
  } catch {
    return fallback;
  }
}

function RecommendationCard({ item, top, onUse, copied, onCopy }: { item: Recommendation; top: boolean; onUse: (item: Recommendation) => void; copied: string; onCopy: (text: string) => void }) {
  const rows: Array<[string, string]> = [
    ["Use case", item.useCase],
    ["Quality", item.quality],
    ["Speed", item.speed],
    ["Cost", item.cost],
    ["Local requirements", item.localRequirements],
    ["Privacy", item.privacy],
  ];
  const canUseLocal = item.kind === "local" && isLocalDevelopmentHost();
  return (
    <article className="deck-frame" aria-label={`${item.label} on ${item.providerLabel}`}>
      <div className={`deck-card ${top ? "tone-sky" : "tone-plain"}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {top && <span className="pill-badge mb-2"><span className="pill-badge-dot"><Check size={9} strokeWidth={3} /></span>Top pick</span>}
            <h3 className="font-display text-lg font-medium tracking-tight text-ink">{item.label}</h3>
            <p className="text-xs text-slate-500"><span className="font-mono">{item.model}</span> · {item.providerLabel}</p>
          </div>
          <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${item.kind === "local" ? "bg-emerald-100 text-emerald-800" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}>{item.kind === "local" ? "Local" : "Hosted"}</span>
        </div>
        <dl className="mt-4 grid gap-x-4 gap-y-2.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-xs font-medium text-slate-500 sm:pt-0.5">{label}</dt>
              <dd className="text-slate-800">{value}</dd>
            </div>
          ))}
          <dt className="text-xs font-medium text-slate-500 sm:pt-0.5">Limitations</dt>
          <dd className="text-slate-800">{item.limitations.length ? <ul className="list-disc space-y-0.5 pl-4">{item.limitations.map((line) => <li key={line}>{line}</li>)}</ul> : "None noted"}</dd>
        </dl>
        <p className={`mt-4 rounded-xl px-3 py-2 text-sm text-slate-700 ${top ? "bg-white/70" : "bg-slate-50"}`}><span className="font-medium text-ink">Why HANNAH chose it: </span>{item.reason}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {item.action.type === "use" && <button type="button" className="btn-primary" onClick={() => onUse(item)}>Use in chat</button>}
          {item.action.type === "install" && (
            <>
              <button type="button" className="btn-outline" onClick={() => onCopy((item.action as { command: string }).command)}>
                {copied === item.action.command ? <Check size={14} /> : <Clipboard size={14} />} <span className="font-mono text-xs">{item.action.command}</span>
              </button>
              {canUseLocal && <button type="button" className="btn-primary" onClick={() => onUse(item)}>Use in chat</button>}
            </>
          )}
          {item.action.type === "configure" && (
            <a className="btn-outline" href={item.action.docs || "#"} target="_blank" rel="noreferrer">Get a {item.providerLabel} key <ExternalLink size={13} /></a>
          )}
        </div>
      </div>
    </article>
  );
}

export default function ModelsPage({ onOpenChat }: { onOpenChat?: () => void } = {}) {
  const [hardware, setHardware] = useState<HardwareProfile>(() => loadHardware() ?? defaultHardware());
  const [hints, setHints] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [needs, setNeeds] = useState<AdvisorNeeds>(loadNeeds);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState("");

  const runDetection = async () => {
    setDetecting(true);
    const detected = await detectHardware();
    setHardware((current) => {
      const next = { ...detected.profile, ramGB: detected.profile.ramGB ?? current.ramGB, vramGB: current.vramGB, reservedGB: current.reservedGB };
      saveHardware(next);
      return next;
    });
    setHints(detected.hints);
    setDetecting(false);
  };

  useEffect(() => {
    if (!loadHardware()) void runDetection();
    let active = true;
    (async () => {
      try {
        const response = await apiFetch(apiUrl("/api/catalog"), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as ModelCatalog;
        if (active) setCatalog(data);
      } catch {
        if (active) setCatalogError("Couldn't load the server's model catalog, so only local models are shown.");
      }
    })();
    const onOnline = () => setHardware((current) => ({ ...current, online: navigator.onLine }));
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOnline);
    return () => { active = false; window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOnline); };
  }, []);

  const updateHardware = (patch: Partial<HardwareProfile>) => setHardware((current) => {
    const next = { ...current, ...patch };
    saveHardware(next);
    return next;
  });
  const updateNeeds = (patch: Partial<AdvisorNeeds>) => setNeeds((current) => {
    const next = { ...current, ...patch };
    try { window.localStorage.setItem(NEEDS_KEY, JSON.stringify(next)); } catch { /* per-visit only */ }
    return next;
  });

  const advice = useMemo(() => recommend(needs, hardware, catalog), [needs, hardware, catalog]);
  const budgetHelp = budgets.find(([id]) => id === needs.budget)?.[2];

  const useModel = (item: Recommendation) => {
    const provider = item.action.type === "use" ? item.action.provider : "ollama";
    if (!applyToChat(provider, item.model)) {
      setNotice("This browser blocked saving your choice. Pick the model in chat settings instead.");
      return;
    }
    if (onOpenChat) onOpenChat();
    else setNotice(`Chat will now use ${item.label} on ${item.providerLabel}.`);
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      window.setTimeout(() => setCopied((current) => (current === text ? "" : current)), 1800);
    } catch {
      setNotice(`Copy this command: ${text}`);
    }
  };

  return (
    <main className="mx-auto w-full max-w-6xl px-3 pb-12 pt-5 sm:px-6 sm:pt-8">
      <div className="mb-5">
        <span className="pill-badge"><span className="pill-badge-dot"><Check size={9} strokeWidth={3} /></span>Models</span>
        <h1 className="display-title mt-4 text-[clamp(2.2rem,5vw,3.5rem)]">Find the right model for you.</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-slate-600">HANNAH weighs your task, budget, privacy and computer, then recommends models you can use now, with the trade-offs spelled out. Ratings are curated summaries (reviewed {PROFILES_REVIEWED}), not benchmark scores.</p>
      </div>

      {notice && <p role="status" className="mb-4 rounded-2xl border border-sky-100 bg-sky-50 px-4 py-3 text-sm text-sky-900">{notice}</p>}

      <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
        <Panel title="Your device" tone="tone-sky" aside={
          <button type="button" className="btn-outline !py-1.5" onClick={() => void runDetection()} disabled={detecting}><RefreshCw size={13} className={detecting ? "animate-spin" : ""} /> {detecting ? "Detecting…" : "Detect again"}</button>
        }>
          <div className="grid grid-cols-2 gap-3">
            <SelectField id="hw-os" label="Operating system" value={hardware.os} options={osOptions} onChange={(os) => updateHardware({ os })} />
            <SelectField id="hw-gpu" label="Graphics" value={hardware.gpuKind} options={gpuOptions} onChange={(gpuKind) => updateHardware({ gpuKind })} />
            <NumberField id="hw-ram" label={hardware.gpuKind === "apple" ? "Unified memory" : "Installed RAM"} value={hardware.ramGB} suffix="GB" placeholder="e.g. 16"
              onChange={(ramGB) => updateHardware({ ramGB, reservedGB: suggestedReserveGB(ramGB) })} />
            {hardware.gpuKind === "discrete"
              ? <NumberField id="hw-vram" label="GPU memory (VRAM)" value={hardware.vramGB} suffix="GB" placeholder="e.g. 8" onChange={(vramGB) => updateHardware({ vramGB })} />
              : <NumberField id="hw-threads" label="CPU threads" value={hardware.cpuThreads} suffix="threads" onChange={(cpuThreads) => updateHardware({ cpuThreads })} />}
            <NumberField id="hw-reserve" label="Keep free for other apps" value={hardware.reservedGB} suffix="GB" onChange={(reservedGB) => updateHardware({ reservedGB: reservedGB ?? 0 })} />
            <div className="text-xs font-medium text-slate-600">
              Connection
              <p className="mt-1 rounded-xl bg-white/60 px-3 py-2 text-sm text-ink">{hardware.online ? "Online" : "Offline"}</p>
            </div>
          </div>
          {hardware.gpuName && <p className="mt-3 text-xs text-slate-600"><Cpu size={12} className="mr-1 inline" />Detected GPU: {hardware.gpuName}</p>}
          {hints.map((hint) => <p key={hint} className="mt-2 text-xs leading-relaxed text-slate-600">{hint}</p>)}
          <p className="mt-3 text-xs leading-relaxed text-slate-500">Saved on this device only. Fit estimates include the model weights, the KV cache for your context size and runtime overhead.</p>
        </Panel>

        <Panel title="What you need" tone="tone-lavender">
          <p className="mb-2 text-xs font-medium text-slate-600">Task</p>
          <Chips label="Task" value={needs.task} options={tasks} onChange={(task) => updateNeeds({ task })} />
          <p className="mb-2 mt-4 text-xs font-medium text-slate-600">Optimize for</p>
          <Chips label="Optimize for" value={needs.priority} options={priorities} onChange={(priority) => updateNeeds({ priority })} />
          <div className="mt-4 grid grid-cols-2 gap-3">
            <SelectField id="needs-budget" label="Budget" value={needs.budget} options={budgets.map(([id, text]) => [id, text] as [Budget, string])} onChange={(budget) => updateNeeds({ budget })} />
            <SelectField id="needs-context" label="Context needed" value={String(needs.contextTokens)} options={contexts.map(([tokens, text]) => [String(tokens), text] as [string, string])} onChange={(value) => updateNeeds({ contextTokens: Number(value) })} />
            <NumberField id="needs-messages" label="Messages per month" value={needs.monthlyMessages ?? null} suffix="msgs" onChange={(monthlyMessages) => updateNeeds({ monthlyMessages: monthlyMessages ?? undefined })} />
          </div>
          {budgetHelp && <p className="mt-3 text-xs leading-relaxed text-slate-600">{budgetHelp}</p>}
          <p className="mt-2 text-xs leading-relaxed text-slate-500">Monthly costs assume about 1,500 input and 500 output tokens per message.</p>
        </Panel>
      </div>

      {(advice.notes.length > 0 || catalogError) && (
        <ul className="mt-4 space-y-1.5 rounded-2xl bg-white/70 px-4 py-3 text-sm text-slate-700" aria-label="Notes">
          {catalogError && <li>{catalogError}</li>}
          {advice.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}

      {advice.hybrid && (
        <section className="deck-frame mt-4" aria-label="Hybrid setup">
          <div className="deck-card tone-butter">
            <h2 className="font-display text-lg font-medium tracking-tight text-ink"><Sparkles size={16} className="mr-1.5 inline" />Your hybrid setup</h2>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {([["Routine & private · local", advice.hybrid.local], ["Demanding work · cloud", advice.hybrid.cloud]] as const).map(([label, pick]) => (
                <div key={label} className="glass-tile !bg-white/60 p-4">
                  <p className="text-xs font-medium text-slate-600">{label}</p>
                  {pick ? (
                    <>
                      <p className="mt-1 font-display text-base font-medium text-ink">{pick.label}</p>
                      <p className="text-xs text-slate-600">{pick.providerLabel} · {pick.cost}</p>
                    </>
                  ) : <p className="mt-1 text-sm text-slate-600">No model fits. {label.includes("local") ? "Add your RAM or pick a smaller context." : "Connect a hosted provider."}</p>}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {advice.recommendations.length > 0 && (
        <section className="deck-frame mt-4" aria-label="Comparison">
          <div className="deck-card tone-plain">
            <h2 className="font-display text-lg font-medium tracking-tight text-ink">At a glance</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-xs text-slate-500">
                  <tr>{["Model", "Quality", "Speed", "Cost", "Privacy"].map((heading) => <th key={heading} scope="col" className="pb-2 pr-4 font-medium">{heading}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {advice.recommendations.slice(0, 6).map((item) => (
                    <tr key={item.key}>
                      <td className="py-2 pr-4"><span className="font-medium text-ink">{item.label}</span><span className="block text-xs text-slate-500">{item.providerLabel}</span></td>
                      <td className="py-2 pr-4 text-slate-700">{item.quality}</td>
                      <td className="py-2 pr-4 text-slate-700">{item.speed}</td>
                      <td className="py-2 pr-4 text-slate-700">{item.cost}</td>
                      <td className="py-2 pr-4 text-slate-700">{item.kind === "local" ? "Local" : "Hosted"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-slate-500">{Object.entries(TIER_DESCRIPTIONS).map(([tier, text]) => `${tier.charAt(0).toUpperCase() + tier.slice(1)}: ${text}`).join(" ")} {catalog?.priceNote}</p>
          </div>
        </section>
      )}

      <div className="mt-4 grid gap-3 sm:gap-4 lg:grid-cols-2">
        {advice.recommendations.map((item, index) => (
          <RecommendationCard key={item.key} item={item} top={index === 0} onUse={useModel} copied={copied} onCopy={(text) => void copy(text)} />
        ))}
      </div>
    </main>
  );
}
