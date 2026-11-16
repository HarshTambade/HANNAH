import type { ReactNode } from "react";
import { Brain, Cpu, LayoutDashboard, MessageSquare, Settings2, Workflow } from "lucide-react";
import { ReminderToasts } from "./Reminders";

export type AppSection = "conversation" | "companion" | "models" | "accountability" | "automations" | "settings";

const navItems: Array<{ id: AppSection; label: string; Icon: typeof MessageSquare }> = [
  { id: "conversation", label: "Chat", Icon: MessageSquare },
  { id: "companion", label: "Dashboard", Icon: LayoutDashboard },
  { id: "models", label: "Models", Icon: Cpu },
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
    <div className={`deck-shell-bg relative flex flex-col ${fill ? "h-[100dvh]" : "h-[100dvh] overflow-y-auto"}`}>
      <header className="sticky top-0 z-30 shrink-0 bg-gradient-to-b from-[#eef0f4] via-[#eef0f4]/95 to-[#eef0f4]/0 px-3 pb-2 pt-3 sm:px-6">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 rounded-2xl border border-white/70 bg-white/75 px-3 shadow-[0_12px_30px_-20px_rgba(38,44,74,0.45)] backdrop-blur-xl sm:px-4">
          <button type="button" onClick={onHome} className="flex shrink-0 items-center gap-2 rounded-xl px-1.5 py-1 transition hover:bg-white" aria-label="HANNAH home page">
            <span className="logo-ring" aria-hidden="true" />
            <span className="hidden text-sm font-medium text-ink sm:inline">HANNAH</span>
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
                  className={`flex shrink-0 items-center gap-1.5 rounded-xl px-2.5 py-2 text-[13px] font-medium transition md:px-3 ${selected ? "bg-ink text-white shadow-sm" : "text-slate-500 hover:bg-white hover:text-ink"}`}
                >
                  <Icon size={16} />
                  <span className="hidden md:inline">{label}</span>
                </button>
              );
            })}
          </nav>
          <span className="hidden shrink-0 text-xs text-slate-500 lg:inline">{new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
        </div>
      </header>
      <div className={`relative z-10 ${fill ? "flex min-h-0 flex-1 flex-col" : ""}`}>{children}</div>
      <ReminderToasts />
    </div>
  );
}
