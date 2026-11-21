import type { MouseEvent, ReactNode } from "react";
import { Bot, Brain, Cpu, LayoutDashboard, MessageSquare, Settings2, ShieldCheck, Users, Workflow } from "lucide-react";
import { ReminderToasts } from "./Reminders";
import { AutomationToasts } from "./AutomationToasts";
import { RemoteApprovalToasts } from "./DeviceTasksPanel";
import { ScreenWatchIndicator } from "./DesktopControlSections";
import { desktopFilesAvailable } from "../services/DesktopFiles";
import { pathForScreen } from "../routes";

export type AppSection = "conversation" | "companion" | "agents" | "models" | "accountability" | "automations" | "actions" | "robotics" | "settings";

const navItems: Array<{ id: AppSection; label: string; shortLabel: string; Icon: typeof MessageSquare }> = [
  { id: "conversation", label: "Chat", shortLabel: "Chat", Icon: MessageSquare },
  { id: "companion", label: "Dashboard", shortLabel: "Home", Icon: LayoutDashboard },
  { id: "agents", label: "Agents", shortLabel: "Agents", Icon: Users },
  { id: "models", label: "Models", shortLabel: "Models", Icon: Cpu },
  { id: "accountability", label: "Memory & style", shortLabel: "Memory", Icon: Brain },
  { id: "automations", label: "Automations", shortLabel: "Flows", Icon: Workflow },
  { id: "actions", label: "Actions", shortLabel: "Actions", Icon: ShieldCheck },
  { id: "robotics", label: "Robots", shortLabel: "Robots", Icon: Bot },
  { id: "settings", label: "Settings", shortLabel: "Settings", Icon: Settings2 },
];

type AppShellProps = {
  active: AppSection;
  onNavigate: (section: AppSection) => void;
  onHome: () => void;
  children: ReactNode;
  /** Chat fills the viewport; other screens scroll. */
  fill?: boolean;
};

/** Open the link in the app unless the user asked for a new tab or window. */
function handleLink(event: MouseEvent<HTMLAnchorElement>, go: () => void) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  go();
}

const base = import.meta.env.BASE_URL;

export default function AppShell({ active, onNavigate, onHome, children, fill = false }: AppShellProps) {
  const current = navItems.find((item) => item.id === active);
  return (
    <div className={`deck-shell-bg relative flex flex-col ${fill ? "h-[100dvh]" : "h-[100dvh] overflow-y-auto"}`}>
      <header className="sticky top-0 z-30 shrink-0 bg-gradient-to-b from-[#eef0f4] via-[#eef0f4]/95 to-[#eef0f4]/0 px-3 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 rounded-2xl border border-white/70 bg-white/75 px-3 shadow-[0_12px_30px_-20px_rgba(38,44,74,0.45)] backdrop-blur-xl sm:px-4">
          <a href={pathForScreen("landing", base)} onClick={(event) => handleLink(event, onHome)} className="flex shrink-0 items-center gap-2 rounded-xl px-1.5 py-1 transition hover:bg-white" aria-label="HANNAH home page">
            <span className="logo-ring" aria-hidden="true" />
            <span className="hidden text-sm font-medium text-ink sm:inline">HANNAH</span>
          </a>
          {/* Phones: the current section's name; the tabs live at the bottom. */}
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink md:hidden">{current?.label}</span>
          <nav aria-label="App navigation" className="hidden min-w-0 flex-1 items-center justify-center gap-0.5 md:flex">
            {navItems.map(({ id, label, Icon }) => {
              const selected = id === active;
              return (
                <a
                  key={id}
                  href={pathForScreen(id, base)}
                  onClick={(event) => handleLink(event, () => onNavigate(id))}
                  aria-current={selected ? "page" : undefined}
                  title={label}
                  className={`flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] font-medium transition ${selected ? "bg-ink text-white shadow-sm" : "text-slate-500 hover:bg-white hover:text-ink"}`}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{label}</span>
                </a>
              );
            })}
          </nav>
          <span className="hidden shrink-0 text-xs text-slate-500 lg:inline">{new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
        </div>
      </header>
      <div className={`relative z-10 ${fill ? "flex min-h-0 flex-1 flex-col" : "flex-1"}`}>{children}</div>
      {/* Phones and small tablets: a bottom tab bar, as on iOS and Android. */}
      <nav aria-label="App navigation" className="sticky bottom-0 z-30 shrink-0 border-t border-slate-200/80 bg-white/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
        <div className="mx-auto grid max-w-2xl grid-cols-9">
          {navItems.map(({ id, label, shortLabel, Icon }) => {
            const selected = id === active;
            return (
              <a
                key={id}
                href={pathForScreen(id, base)}
                onClick={(event) => handleLink(event, () => onNavigate(id))}
                aria-current={selected ? "page" : undefined}
                // The accessible name keeps the short visible text, so screen readers and the label agree.
                aria-label={shortLabel === label ? undefined : `${shortLabel} (${label})`}
                className={`flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 px-0.5 text-[10px] font-medium transition ${selected ? "text-brand-700" : "text-slate-600 active:text-ink"}`}
              >
                <Icon size={20} strokeWidth={selected ? 2.4 : 2} aria-hidden="true" />
                <span className="max-w-full truncate">{shortLabel}</span>
              </a>
            );
          })}
        </div>
      </nav>
      <ReminderToasts />
      <AutomationToasts onOpen={() => onNavigate("automations")} onAutomationsScreen={active === "automations"} />
      <RemoteApprovalToasts />
      {desktopFilesAvailable() && <ScreenWatchIndicator />}
    </div>
  );
}
