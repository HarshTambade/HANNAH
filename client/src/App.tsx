import { useCallback, useEffect, useState } from "react";
import IntegrationsPage from "./components/IntegrationsPage";
import LandingPage from "./components/LandingPage";
import MarketplacePage from "./components/MarketplacePage";
import ModelsPage from "./components/ModelsPage";
import AgentsPage from "./components/AgentsPage";
import WorkflowBuilder from "./components/WorkflowBuilder";
import AgentAccountabilityDashboard from "./components/AgentAccountabilityDashboard";
import ChatUI from "./components/ChatUI";
import AvatarScene, { type AvatarActivity, type AvatarMotion } from "./components/AvatarScene";
import AppShell, { type AppSection } from "./components/AppShell";
import Dashboard from "./components/Dashboard";
import SettingsPage from "./components/SettingsPage";
import { REMINDER_FIRED_EVENT, startReminderScheduler, type Reminder } from "./services/ReminderService";
import { startNativeReminders } from "./services/NativeReminders";
import { clearApiSession, getAccountHint, getSessionGroqKey, hasApiSession, setApiAccessToken, setSessionGroqKey } from "./services/api";
import { Account } from "./services/Account";
import { resetSyncState, startAccountSync } from "./services/AccountSync";
import { refreshMcpTools } from "./services/McpTools";
import type { Emotion, InferenceMode } from "./types";

type Screen = "landing" | "integrations" | "marketplace" | AppSection;

const routes: Record<Screen, string> = {
  landing: "",
  conversation: "#/chat",
  companion: "#/dashboard",
  agents: "#/agents",
  models: "#/models",
  accountability: "#/memory",
  automations: "#/automations",
  settings: "#/settings",
  integrations: "#/integrations",
  marketplace: "#/marketplace",
};

const appSections = new Set<Screen>(["conversation", "companion", "agents", "models", "accountability", "automations", "settings"]);

// Only "#/..." hashes are routes; "#experience" etc. are landing-page anchors.
function screenFromHash(): Screen {
  const hash = window.location.hash;
  if (!hash.startsWith("#/")) return "landing";
  const match = (Object.entries(routes) as Array<[Screen, string]>).find(([, value]) => value === hash);
  return match?.[0] ?? "landing";
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(() => {
    const initial = screenFromHash();
    return appSections.has(initial) && !hasApiSession() ? "landing" : initial;
  });
  const [connectRequested, setConnectRequested] = useState(() => appSections.has(screenFromHash()) && !hasApiSession());
  const [groqApiKey, setGroqApiKey] = useState(getSessionGroqKey);
  const [emotion, setEmotion] = useState<Emotion>("neutral");
  const [avatarMotion, setAvatarMotion] = useState<AvatarMotion>("loading");
  const [avatarActivity, setAvatarActivity] = useState<AvatarActivity>("idle");
  const [returnScreen, setReturnScreen] = useState<Screen>("landing");
  const preferredMode: InferenceMode = "cloud";

  const navigate = useCallback((next: Screen) => {
    if (appSections.has(next) && !hasApiSession()) {
      setConnectRequested(true);
      next = "landing";
    }
    setScreen(next);
    const target = routes[next];
    if (window.location.hash !== target) {
      const url = `${window.location.pathname}${window.location.search}${target}`;
      window.history.pushState(null, "", url);
    }
  }, []);

  // Reminders fire while the app is open, on any screen.
  useEffect(() => startReminderScheduler(), []);
  useEffect(() => startNativeReminders(), []);
  // Signed-in users can have reminders reach their own webhooks.
  useEffect(() => {
    const onFired = (event: Event) => {
      const reminder = (event as CustomEvent<Reminder>).detail;
      if (reminder) Account.emitEvent("reminder.fired", { id: reminder.id, text: reminder.text, dueAt: new Date(reminder.dueAt).toISOString() });
    };
    window.addEventListener(REMINDER_FIRED_EVENT, onFired);
    return () => window.removeEventListener(REMINDER_FIRED_EVENT, onFired);
  }, []);
  // Confirm a remembered account session is still valid, then keep data in sync.
  useEffect(() => {
    void Account.refresh();
    return startAccountSync();
  }, []);
  // Outside MCP tools (operator sessions only), refreshed when the screen changes.
  useEffect(() => {
    if (screen !== "landing") void refreshMcpTools();
  }, [screen]);

  useEffect(() => {
    const onPop = () => {
      const next = screenFromHash();
      if (appSections.has(next) && !hasApiSession()) {
        setConnectRequested(true);
        setScreen("landing");
      } else {
        setScreen(next);
      }
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
    };
  }, []);

  const disconnect = useCallback(() => {
    if (getAccountHint()) {
      void Account.logout().catch(() => {});
      resetSyncState();
    }
    clearApiSession();
    setGroqApiKey("");
    navigate("landing");
  }, [navigate]);

  const reconnect = useCallback(() => {
    clearApiSession();
    setConnectRequested(true);
    navigate("landing");
  }, [navigate]);

  const openSecondary = (target: "integrations" | "marketplace") => {
    setReturnScreen(screen);
    navigate(target);
  };

  if (screen === "integrations") return <IntegrationsPage onBack={() => navigate(returnScreen === "integrations" ? "landing" : returnScreen)} />;
  if (screen === "marketplace") return <MarketplacePage onBack={() => navigate(returnScreen === "marketplace" ? "landing" : returnScreen)} />;

  if (screen === "landing") {
    return (
      <LandingPage
        hasSession={hasApiSession()}
        openConnect={connectRequested}
        onConnectHandled={() => setConnectRequested(false)}
        onStart={({ apiToken, groqApiKey: providerKey }) => {
          setApiAccessToken(apiToken);
          setSessionGroqKey(providerKey);
          setGroqApiKey(providerKey);
          navigate("conversation");
        }}
        onResume={() => navigate("conversation")}
        onIntegrations={() => openSecondary("integrations")}
        onMarketplace={() => openSecondary("marketplace")}
      />
    );
  }

  const shellProps = { active: screen as AppSection, onNavigate: navigate, onHome: () => navigate("landing") };

  if (screen === "conversation") {
    return (
      <AppShell {...shellProps} fill>
        <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col p-2 sm:p-4">
          <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-2 sm:gap-3 lg:grid-cols-[minmax(260px,0.7fr)_minmax(0,1.3fr)] lg:grid-rows-1">
            <section
              role="region"
              aria-label="HANNAH avatar"
              data-emotion={emotion}
              data-avatar-motion={avatarMotion}
              data-avatar-activity={avatarActivity}
              className="tone-lavender relative h-36 overflow-hidden rounded-[1.75rem] border-[6px] border-white/90 shadow-[0_24px_60px_-30px_rgba(38,44,74,0.45)] sm:h-48 lg:h-auto lg:min-h-0"
            >
              <AvatarScene emotion={emotion} activity={avatarActivity} onMotionChange={setAvatarMotion} />
            </section>
            <div className="min-h-0 min-w-0">
              <ChatUI onEmotionChange={setEmotion} onActivityChange={setAvatarActivity} panel groqApiKey={groqApiKey} initialMode={preferredMode} onSessionExpired={reconnect} />
            </div>
          </div>
        </div>
      </AppShell>
    );
  }

  if (screen === "accountability") {
    return (
      <AppShell {...shellProps}>
        <div className="mx-auto max-w-6xl px-3 pb-12 pt-5 sm:px-6 sm:pt-8"><AgentAccountabilityDashboard /></div>
      </AppShell>
    );
  }

  if (screen === "agents") {
    return (
      <AppShell {...shellProps}>
        <AgentsPage />
      </AppShell>
    );
  }

  if (screen === "models") {
    return (
      <AppShell {...shellProps}>
        <ModelsPage onOpenChat={() => navigate("conversation")} />
      </AppShell>
    );
  }

  if (screen === "automations") {
    return (
      <AppShell {...shellProps}>
        <WorkflowBuilder />
      </AppShell>
    );
  }

  if (screen === "settings") {
    return (
      <AppShell {...shellProps}>
        <SettingsPage onDisconnect={disconnect} onGroqKeyChange={setGroqApiKey} />
      </AppShell>
    );
  }

  return (
    <AppShell {...shellProps}>
      <Dashboard
        onOpenChat={() => navigate("conversation")}
        onOpenMemory={() => navigate("accountability")}
        onOpenAutomations={() => navigate("automations")}
        onOpenMarketplace={() => openSecondary("marketplace")}
        onOpenIntegrations={() => openSecondary("integrations")}
      />
    </AppShell>
  );
}
