import type { ReactNode } from "react";
import { Brain, LayoutDashboard, MessageSquare, Settings2, Sparkles, Workflow } from "lucide-react";

export type AppSection = "conversation" | "companion" | "accountability" | "automations" | "settings";

const navItems: Array<{ id: AppSection; label: string; Icon: typeof MessageSquare }> = [
  { id: "conversation", label: "Chat", Icon: MessageSquare },
  { id: "companion", label: "Dashboard", Icon: LayoutDashboard },
  { id: "accountability", label: "Memory & style", Icon: Brain },
  { id: "automations", label: "Automations", Icon: Workflow },
  { id: "settings", label: "Settings", Icon: Settings2 },
];

type AppShellProps = {
  active: AppSection;
  onNavigate: (section: AppSection) => void;
  onHome: () => void;
  children: ReactNode;
  /** Chat fills the viewport; other screens scroll. */
  fill?: boolean;
};

export default function AppShell({ active, onNavigate, onHome, children, fill = false }: AppShellProps) {
  return (
    <div className={`relative flex flex-col bg-slate-50 ${fill ? "h-[100dvh]" : "h-[100dvh] overflow-y-auto"}`}>
      <div className="pointer-events-none fixed inset-0 bg-mesh-pastel opacity-50" aria-hidden="true" />
      <header className="sticky top-0 z-30 shrink-0 border-b border-slate-200/80 bg-white/85 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-3 sm:px-6">
          <button type="button" onClick={onHome} className="flex shrink-0 items-center gap-2 rounded-xl px-1.5 py-1 transition hover:bg-slate-100" aria-label="HANNAH home page">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-brand-100 bg-brand-50 text-brand-600"><Sparkles size={15} /></span>
            <span className="hidden font-display text-sm font-extrabold tracking-[0.16em] text-ink sm:inline">HANNAH</span>
          </button>
          <nav aria-label="App navigation" className="-mx-1 flex min-w-0 flex-1 items-center justify-end gap-0.5 overflow-x-auto px-1 sm:justify-center">
            {navItems.map(({ id, label, Icon }) => {
              const selected = id === active;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onNavigate(id)}
                  aria-current={selected ? "page" : undefined}
                  aria-label={label}
                  title={label}
                  className={`flex shrink-0 items-center gap-1.5 rounded-xl px-2.5 py-2 text-[13px] font-medium transition md:px-3 ${selected ? "bg-brand-50 text-brand-700" : "text-slate-500 hover:bg-slate-100 hover:text-ink"}`}
                >
                  <Icon size={16} />
                  <span className="hidden md:inline">{label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </header>
      <div className={`relative z-10 ${fill ? "flex min-h-0 flex-1 flex-col" : ""}`}>{children}</div>
    </div>
  );
}
