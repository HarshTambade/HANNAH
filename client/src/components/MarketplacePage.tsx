import { useMemo, useState } from "react";
import {
  ArrowLeft, Bot, Check, Download, MessageSquare, Search, ShieldCheck, Sparkles, Trash2,
} from "lucide-react";
import CommunitySkillsPanel from "./CommunitySkillsPanel";
import ConnectorsDirectory from "./ConnectorsDirectory";
import HardwarePackagesPanel from "./robotops/HardwarePackagesPanel";
import { MAX_ENABLED_SKILLS, MarketplaceService, type MarketplacePackage, type MarketplacePackageType, type MarketplaceState } from "../services/MarketplaceService";

type MarketplacePageProps = { onBack: () => void; /** Open the chat (after connecting, if the visitor hasn't yet). */ onOpenChat?: () => void };
type TypeFilter = "all" | MarketplacePackageType;

export default function MarketplacePage({ onBack, onOpenChat }: MarketplacePageProps) {
  const [state, setState] = useState(() => MarketplaceService.getState());
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  // "/marketplace#agents" opens on the agents and skills tab.
  const [tab, setTab] = useState<"connectors" | "packages" | "hardware">(() => (typeof window !== "undefined" && window.location.hash === "#agents" ? "packages" : typeof window !== "undefined" && window.location.hash === "#hardware" ? "hardware" : "connectors"));
  const allPackages = MarketplaceService.list();
  const categories = useMemo(() => ["all", ...Array.from(new Set(allPackages.map((item) => item.category))).sort()], [allPackages]);
  const packages = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return allPackages.filter((item) => {
      if (typeFilter !== "all" && item.type !== typeFilter) return false;
      if (categoryFilter !== "all" && item.category !== categoryFilter) return false;
      if (!normalizedQuery) return true;
      return [item.name, item.description, item.category, item.type, ...item.tags].join(" ").toLowerCase().includes(normalizedQuery);
    });
  }, [query, typeFilter, categoryFilter, allPackages]);
  const installedCount = state.installedIds.length;

  const update = (action: () => MarketplaceState, successMessage: string) => {
    try {
      setState(action());
      setStatus({ ok: true, text: successMessage });
      return true;
    } catch (error) {
      setStatus({ ok: false, text: error instanceof Error ? error.message : "The marketplace action could not be completed." });
      return false;
    }
  };
  const openChat = (draft?: string) => {
    if (draft) MarketplaceService.setChatDraft(draft);
    onOpenChat?.();
  };
  /** Turn the package on and open the chat with one of its prompts in the message box. */
  const tryIt = (item: MarketplacePackage, starter: string) => {
    if (update(() => MarketplaceService.turnOn(item.id), `${item.name} is on.`)) openChat(starter);
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
          {([["connectors", "Connectors"], ["packages", `Agents and skills (${allPackages.length})`], ["hardware", "Hardware"]] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`rounded-lg px-4 py-2 text-xs font-semibold transition ${tab === id ? "bg-ink text-white" : "text-slate-600 hover:text-ink"}`}>{label}</button>
          ))}
        </div>

        {tab === "connectors" ? <ConnectorsDirectory /> : tab === "hardware" ? <HardwarePackagesPanel /> : (<>

        <section className="mt-8 flex flex-col gap-4 rounded-2xl border border-cyan-100 bg-cyan-50 p-4 sm:flex-row sm:items-start sm:p-5">
          <ShieldCheck size={17} className="mt-0.5 shrink-0 text-cyan-700" />
          <div>
            <h2 className="text-[13px] font-semibold text-cyan-900">What agents and skills change</h2>
            <p className="mt-1 text-xs leading-5 text-slate-600">An <strong>agent</strong> sets how HANNAH works for a whole conversation: its method, the tools it keeps to hand, and the prompts it suggests. One agent is on at a time, and you can switch in chat. A <strong>skill</strong> adjusts every reply, and up to {MAX_ENABLED_SKILLS} can be on together. Neither runs code or adds permissions: tools still ask you first. They're built into the app and saved on this device.</p>
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

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-violet-100 bg-gradient-to-r from-violet-50/80 via-white to-cyan-50/60 px-4 py-3 text-[12px] text-slate-600">
          <span className="inline-flex items-center gap-1.5"><Bot size={12} className="text-violet-600" /> Active agent: <strong className="font-semibold text-ink">{state.activeAgentId ? MarketplaceService.getPackage(state.activeAgentId)?.name : "HANNAH (no agent)"}</strong></span>
          <span className="inline-flex items-center gap-1.5"><Check size={12} className="text-cyan-600" /> Skills on: <strong className="font-semibold text-ink">{state.enabledSkillIds.length} of {MAX_ENABLED_SKILLS}</strong></span>
          <button type="button" onClick={() => openChat()} className="ml-auto inline-flex items-center gap-1 font-semibold text-violet-700 hover:underline"><MessageSquare size={12} /> Open chat</button>
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5" aria-label="Filter by category">
          {categories.map((category) => (
            <button
              key={category}
              type="button"
              onClick={() => setCategoryFilter(category)}
              aria-pressed={categoryFilter === category}
              className={`rounded-full border px-3 py-1 text-[11px] font-medium transition ${categoryFilter === category ? "border-violet-200 bg-violet-50 text-violet-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-ink"}`}
            >
              {category === "all" ? "All categories" : category}
            </button>
          ))}
        </div>

        {status && <p role="status" className={`mt-3 text-xs ${status.ok ? "text-emerald-700" : "text-rose-700"}`}>{status.text}</p>}

        {packages.length ? (
          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {packages.map((item) => {
              const installed = isInstalled(item.id);
              const active = item.type === "agent" && state.activeAgentId === item.id;
              const enabled = item.type === "skill" && state.enabledSkillIds.includes(item.id);
              const on = active || enabled;
              return (
                <article key={item.id} className={`group relative flex flex-col overflow-hidden rounded-2xl border bg-white transition hover:-translate-y-0.5 hover:shadow-[0_18px_40px_-24px_rgba(15,23,42,0.35)] ${on ? (item.type === "agent" ? "border-violet-300 ring-1 ring-violet-200" : "border-cyan-300 ring-1 ring-cyan-200") : "border-slate-200/80"}`}><span aria-hidden="true" className={`absolute inset-x-0 top-0 h-1 ${item.type === "agent" ? "bg-gradient-to-r from-violet-400 to-fuchsia-300" : "bg-gradient-to-r from-cyan-400 to-emerald-300"}`} /><div className="flex flex-1 flex-col p-5">
                  <div className="flex items-start justify-between gap-3">
                    <span className={`flex h-11 w-11 items-center justify-center rounded-2xl border shadow-sm ${item.type === "agent" ? "border-violet-100 bg-gradient-to-br from-violet-50 to-white text-violet-700" : "border-cyan-100 bg-gradient-to-br from-cyan-50 to-white text-cyan-700"}`}>
                      {item.type === "agent" ? <Bot size={20} /> : <Sparkles size={19} />}
                    </span>
                    <div className="flex flex-col items-end gap-1">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${item.type === "agent" ? "bg-violet-50 text-violet-700" : "bg-cyan-50 text-cyan-800"}`}>{item.type} · {item.category}</span>
                      {item.tools?.length ? <span className="text-[10px] text-slate-500">{item.tools.length} tool{item.tools.length === 1 ? "" : "s"}</span> : null}
                    </div>
                  </div>
                  <div className="mt-4 flex items-center gap-2">
                    <h2 className="font-['Manrope'] text-[15px] font-semibold text-ink">{item.name}</h2>
                    {on && <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${item.type === "agent" ? "bg-violet-100 text-violet-700" : "bg-cyan-100 text-cyan-700"}`}>On</span>}
                  </div>
                  <p className="mt-1.5 line-clamp-3 text-[13px] leading-5 text-slate-600">{item.description}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {item.tags.map((tag) => <span key={tag} className="rounded-md bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600 ring-1 ring-slate-200/70">{tag}</span>)}
                  </div>
                  {item.starters.length > 0 && (
                    <div className="mt-3">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Try it with</p>
                      <ul className="mt-1.5 space-y-1">
                        {item.starters.slice(0, 2).map((starter) => (
                          <li key={starter}>
                            <button type="button" onClick={() => tryIt(item, starter)} aria-label={`Try ${item.name}: ${starter.trim()}`} className="w-full rounded-lg border border-slate-200/80 bg-slate-50/70 px-2.5 py-1.5 text-left text-[12px] leading-4 text-slate-700 transition hover:border-violet-200 hover:bg-white">
                              “{starter.trim().replace(/[:\s]+$/, "…")}”
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <details className="mt-3 text-[11px] text-slate-500">
                    <summary className="cursor-pointer">What it tells HANNAH{item.tools?.length ? ` · keeps ${item.tools.length} tool${item.tools.length === 1 ? "" : "s"} to hand` : ""}</summary>
                    <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-slate-50 p-2 leading-4 text-slate-600">{item.instructions}</p>
                    {item.tools?.length ? <p className="mt-1.5 break-words font-mono text-[10px]">{item.tools.join(", ")}</p> : null}
                  </details>
                  <div className="mt-auto flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
                    <span className="text-[10px] text-slate-500">{item.publisher} · v{item.version}</span>
                    <div className="flex items-center gap-2">
                      {item.type === "agent" ? (
                        <button type="button" aria-label={`${active ? "Turn off" : "Use"} ${item.name}`} aria-pressed={active} onClick={() => (active
                          ? update(() => MarketplaceService.activateAgent(null), `${item.name} is off. HANNAH answers as herself again.`)
                          : update(() => MarketplaceService.turnOn(item.id), `${item.name} is on. It answers your next message in chat.`))} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[11px] font-semibold transition ${active ? "border-violet-200 bg-white text-violet-700 hover:bg-violet-50" : "border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100"}`}>
                          {active ? "Turn off" : <><Download size={12} /> {installed ? "Use" : "Add"}</>}
                        </button>
                      ) : (
                        <button type="button" role="switch" aria-label={`${enabled ? "Turn off" : "Turn on"} ${item.name}`} aria-checked={enabled} onClick={() => (enabled
                          ? update(() => MarketplaceService.setSkillEnabled(item.id, false), `${item.name} is off.`)
                          : update(() => MarketplaceService.turnOn(item.id), `${item.name} is on. It applies from your next message.`))} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[11px] font-semibold transition ${enabled ? "border-cyan-200 bg-white text-cyan-700 hover:bg-cyan-50" : "border-cyan-200 bg-cyan-50 text-cyan-800 hover:bg-cyan-100"}`}>
                          {enabled ? "Turn off" : <><Download size={12} /> {installed ? "Turn on" : "Add"}</>}
                        </button>
                      )}
                      {installed && (
                        <button type="button" aria-label={`Remove ${item.name}`} onClick={() => update(() => MarketplaceService.uninstall(item.id), `${item.name} removed.`)} className="rounded-lg p-2 text-slate-500 transition hover:bg-rose-50 hover:text-rose-700">
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
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
