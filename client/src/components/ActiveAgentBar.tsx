import { useEffect, useState } from "react";
import { Bot, Sparkles, Store } from "lucide-react";
import { MARKETPLACE_EVENT, MarketplaceService } from "../services/MarketplaceService";

/** What the marketplace has turned on, read again whenever it changes. */
export function useMarketplace() {
  const read = () => ({
    agent: MarketplaceService.getActiveAgent(),
    agents: MarketplaceService.getInstalledAgents(),
    skills: MarketplaceService.getEnabledSkills(),
  });
  const [value, setValue] = useState(read);
  useEffect(() => {
    const update = () => setValue(read());
    window.addEventListener(MARKETPLACE_EVENT, update);
    return () => window.removeEventListener(MARKETPLACE_EVENT, update);
  }, []);
  return value;
}

/**
 * Shown above the conversation while a marketplace agent or skill is on, so
 * it's plain who is answering and how to switch back.
 */
export default function ActiveAgentBar({ onOpenMarketplace }: { onOpenMarketplace?: () => void }) {
  const { agent, agents, skills } = useMarketplace();
  if (!agents.length && !skills.length) return null;
  return (
    <div role="group" aria-label="Marketplace agent and skills" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-violet-100 bg-violet-50/70 px-4 py-2 text-xs text-slate-700">
      {agents.length > 0 && (
        <label className="flex items-center gap-1.5 font-medium">
          <Bot size={13} className="text-violet-700" aria-hidden="true" />
          <span>Agent</span>
          <select
            value={agent?.id ?? ""}
            onChange={(event) => MarketplaceService.activateAgent(event.target.value || null)}
            className="rounded-lg border border-violet-200 bg-white px-2 py-1 text-xs font-semibold text-ink outline-none focus:border-violet-400"
          >
            <option value="">HANNAH (no agent)</option>
            {agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
      )}
      {skills.length > 0 && (
        <span className="flex min-w-0 items-center gap-1.5" title={skills.map((skill) => skill.name).join(", ")}>
          <Sparkles size={12} className="shrink-0 text-cyan-700" aria-hidden="true" />
          <span className="truncate">{skills.length === 1 ? skills[0].name : `${skills.length} skills on`}</span>
        </span>
      )}
      {onOpenMarketplace && (
        <button type="button" onClick={onOpenMarketplace} className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-violet-800 transition hover:bg-violet-100">
          <Store size={12} aria-hidden="true" /> Marketplace
        </button>
      )}
    </div>
  );
}
