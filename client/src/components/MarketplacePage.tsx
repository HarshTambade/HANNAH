import { useMemo, useState } from "react";
import {
  ArrowLeft, Bot, Check, Download, Search, ShieldCheck, Sparkles, Trash2,
} from "lucide-react";
import CommunitySkillsPanel from "./CommunitySkillsPanel";
import ConnectorsDirectory from "./ConnectorsDirectory";
import { MarketplaceService, type MarketplacePackageType, type MarketplaceState } from "../services/MarketplaceService";

type MarketplacePageProps = { onBack: () => void };
type TypeFilter = "all" | MarketplacePackageType;

export default function MarketplacePage({ onBack }: MarketplacePageProps) {
  const [state, setState] = useState(() => MarketplaceService.getState());
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [status, setStatus] = useState("");
  const [tab, setTab] = useState<"connectors" | "packages">("connectors");
  const packages = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return MarketplaceService.list().filter((item) => {
      if (typeFilter !== "all" && item.type !== typeFilter) return false;
      if (!normalizedQuery) return true;
      return [item.name, item.description, item.category, ...item.tags].join(" ").toLowerCase().includes(normalizedQuery);
    });
  }, [query, typeFilter]);
  const installedCount = state.installedIds.length;

  const update = (action: () => MarketplaceState, successMessage: string) => {
    try {
      setState(action());
      setStatus(successMessage);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The marketplace action could not be completed.");
    }
  };

  const isInstalled = (id: string) => state.installedIds.includes(id);

  return (
    <main className="landing-page deck-shell-bg relative h-[100dvh] overflow-y-auto text-ink selection:bg-brand-200/30">
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -left-40 top-32 h-[32rem] w-[32rem] rounded-full bg-violet-600/[0.07] blur-[140px]" />
        <div className="absolute -right-40 top-[38rem] h-[32rem] w-[32rem] rounded-full bg-cyan-500/[0.06] blur-[150px]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex h-[4.25rem] max-w-6xl items-center justify-between px-5 sm:px-8">
          <button type="button" onClick={onBack} className="inline-flex items-center gap-2 text-xs font-medium text-slate-600 transition hover:text-ink">
            <ArrowLeft size={15} /> Back
          </button>
          <span className="flex items-center gap-2 text-sm font-medium text-ink"><span className="logo-ring" aria-hidden="true" /> HANNAH Marketplace</span>
          <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-500">{installedCount} installed</span>
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-6xl px-5 pb-16 pt-10 sm:px-8 sm:pt-14">
        <section className="max-w-3xl">
          <p className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-violet-700"><Sparkles size={13} /> Make HANNAH yours</p>
          <h1 className="display-title mt-4 text-[clamp(2.4rem,5.5vw,4rem)]">Connect your tools. Shape how she works.</h1>
          <p className="mt-5 max-w-2xl text-sm leading-7 text-slate-500">Connect the services you use, so HANNAH can work with them for you, or add a focused agent or conversation skill. Her safety rules apply throughout, and she asks before acting.</p>
        </section>

        <div role="tablist" aria-label="Marketplace sections" className="mt-8 inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-soft">
          {([["connectors", "Connectors"], ["packages", "Agents and skills"]] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`rounded-lg px-4 py-2 text-xs font-semibold transition ${tab === id ? "bg-ink text-white" : "text-slate-600 hover:text-ink"}`}>{label}</button>
          ))}
        </div>

        {tab === "connectors" ? <ConnectorsDirectory /> : (<>

        <section className="mt-8 flex flex-col gap-4 rounded-2xl border border-cyan-100 bg-cyan-50 p-4 sm:flex-row sm:items-start sm:p-5">
          <ShieldCheck size={17} className="mt-0.5 shrink-0 text-cyan-700" />
          <div>
            <h2 className="text-[13px] font-semibold text-cyan-900">Bundled packages, no new device access</h2>
            <p className="mt-1 text-xs leading-5 text-slate-600">This first-party catalog is included with the app and works offline. Packages add written guidance only: they do not download or run code, add tools, or request device permissions. Installs are saved on this device.</p>
          </div>
        </section>

        <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search agents and skills"
              aria-label="Search agents and skills"
              className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-xs text-ink outline-none placeholder:text-slate-400 focus:border-violet-300"
            />
          </div>
          <div className="flex gap-1.5" aria-label="Filter packages by type">
            {(["all", "agent", "skill"] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setTypeFilter(filter)}
                aria-pressed={typeFilter === filter}
                className={`rounded-lg border px-3 py-2 text-xs font-medium capitalize transition ${typeFilter === filter ? "border-violet-200 bg-violet-50 text-violet-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-ink"}`}
              >{filter === "all" ? "All packages" : `${filter}s`}</button>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-[11px] text-slate-500 shadow-soft">
          <span className="inline-flex items-center gap-1.5"><Bot size={12} className="text-violet-600" /> Active agent: <strong className="font-semibold text-ink">{state.activeAgentId ? MarketplaceService.getPackage(state.activeAgentId)?.name : "HANNAH default"}</strong></span>
          <span className="inline-flex items-center gap-1.5"><Check size={12} className="text-cyan-600" /> Enabled skills: <strong className="font-semibold text-ink">{state.enabledSkillIds.length}</strong></span>
        </div>

        {status && <p role="status" className="mt-3 text-xs text-emerald-700">{status}</p>}

        {packages.length ? (
          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {packages.map((item) => {
              const installed = isInstalled(item.id);
              const active = item.type === "agent" && state.activeAgentId === item.id;
              const enabled = item.type === "skill" && state.enabledSkillIds.includes(item.id);
              return (
                <article key={item.id} className={`deck-frame flex min-h-[15.5rem] flex-col`}><div className={`deck-card flex flex-1 flex-col ${item.type === "agent" ? "tone-lavender" : "tone-mint"}`}>
                  <div className="flex items-start justify-between gap-3">
                    <span className={`flex h-10 w-10 items-center justify-center rounded-xl border ${item.type === "agent" ? "border-violet-100 bg-violet-50 text-violet-700" : "border-cyan-100 bg-cyan-50 text-cyan-700"}`}>
                      {item.type === "agent" ? <Bot size={18} /> : <Sparkles size={17} />}
                    </span>
                    <span className="rounded-full border border-slate-200 px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-slate-500">{item.category}</span>
                  </div>
                  <div className="mt-4 flex items-center gap-2">
                    <h2 className="font-['Manrope'] text-sm font-semibold text-ink">{item.name}</h2>
                    {active && <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700">Active</span>}
                    {enabled && <span className="rounded-full bg-cyan-50 px-2 py-0.5 text-[10px] font-semibold text-cyan-700">Enabled</span>}
                  </div>
                  <p className="mt-2 text-xs leading-5 text-slate-500">{item.description}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {item.tags.map((tag) => <span key={tag} className="rounded-md bg-slate-100 px-2 py-1 text-[10px] text-slate-600">{tag}</span>)}
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-3 pt-5">
                    <span className="text-[10px] text-slate-500">{item.publisher} · v{item.version}</span>
                    {!installed ? (
                      <button type="button" onClick={() => update(() => MarketplaceService.install(item.id), `${item.name} installed on this device.`)} className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-[11px] font-semibold text-violet-700 transition hover:bg-violet-100">
                        <Download size={12} /> Install
                      </button>
                    ) : (
                      <div className="flex items-center gap-2">
                        {item.type === "agent" ? (
                          <button type="button" aria-label={`${active ? "Deactivate" : "Activate"} ${item.name}`} aria-pressed={active} onClick={() => update(() => MarketplaceService.activateAgent(active ? null : item.id), active ? `${item.name} deactivated.` : `${item.name} is now active.`)} className={`rounded-lg border px-3 py-2 text-[11px] font-semibold transition ${active ? "border-violet-200 bg-white text-violet-700 hover:bg-violet-50" : "border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100"}`}>
                            {active ? "Deactivate" : "Activate"}
                          </button>
                        ) : (
                          <button type="button" role="switch" aria-label={`${enabled ? "Disable" : "Enable"} ${item.name}`} aria-checked={enabled} onClick={() => update(() => MarketplaceService.setSkillEnabled(item.id, !enabled), `${item.name} ${enabled ? "disabled" : "enabled"}.`)} className={`rounded-lg border px-3 py-2 text-[11px] font-semibold transition ${enabled ? "border-cyan-200 bg-white text-cyan-700 hover:bg-cyan-50" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
                            {enabled ? "Disable" : "Enable"}
                          </button>
                        )}
                        <button type="button" aria-label={`Uninstall ${item.name}`} onClick={() => update(() => MarketplaceService.uninstall(item.id), `${item.name} uninstalled.`)} className="rounded-lg p-2 text-slate-500 transition hover:bg-rose-50 hover:text-rose-700">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                </div></article>
              );
            })}
          </div>
        ) : (
          <div className="mt-5 rounded-2xl border border-slate-200 bg-white px-5 py-12 text-center text-xs text-slate-500">No packages match that search.</div>
        )}
        <CommunitySkillsPanel />
        </>)}
      </div>
    </main>
  );
}
