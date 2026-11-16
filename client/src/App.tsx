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
import NotFoundPage from "./components/NotFoundPage";
import { legacyHashRedirect, pathForScreen, ROUTE_TITLES, screenForLocation, type AppScreen, type Screen } from "./routes";

const appSections = new Set<Screen>(["conversation", "companion", "agents", "models", "accountability", "automations", "settings"]);
const base = import.meta.env.BASE_URL;

function currentScreen(): Screen {
  return screenForLocation(window.location, base);
}

export default function App() {
  // Old "#/chat" links become "/chat" before anything renders.
  const [screen, setScreen] = useState<Screen>(() => {
    const redirect = legacyHashRedirect(window.location, base);
    if (redirect) window.history.replaceState(null, "", redirect);
    const initial = currentScreen();
    return appSections.has(initial) && !hasApiSession() ? "landing" : initial;
  });
  const [connectRequested, setConnectRequested] = useState(() => appSections.has(currentScreen()) && !hasApiSession());
  // Where a signed-out visitor was going; they land there after connecting.
  const [pendingScreen, setPendingScreen] = useState<AppScreen | null>(() => {
    const initial = currentScreen();
    return appSections.has(initial) && !hasApiSession() ? initial as AppScreen : null;
  });
  const [groqApiKey, setGroqApiKey] = useState(getSessionGroqKey);
  const [emotion, setEmotion] = useState<Emotion>("neutral");
  const [avatarMotion, setAvatarMotion] = useState<AvatarMotion>("loading");
  const [avatarActivity, setAvatarActivity] = useState<AvatarActivity>("idle");
  const [returnScreen, setReturnScreen] = useState<AppScreen>("landing");
  const preferredMode: InferenceMode = "cloud";

  const navigate = useCallback((next: AppScreen) => {
    // App screens need a connection; ask for one and come back afterwards.
    if (appSections.has(next) && !hasApiSession()) {
      setConnectRequested(true);
      setPendingScreen(next);
      next = "landing";
    }
    setScreen(next);
    const target = pathForScreen(next, base);
    if (window.location.pathname !== target || window.location.hash) {
      window.history.pushState(null, "", `${target}${window.location.search}`);
    }
    // A new screen starts at the top, like a page load.
    window.scrollTo?.(0, 0);
  }, []);

  useEffect(() => {
    document.title = ROUTE_TITLES[screen];
  }, [screen]);

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
      const next = currentScreen();
      if (appSections.has(next) && !hasApiSession()) {
        setConnectRequested(true);
        setScreen("landing");
      } else {
        setScreen(next);
      }
    };
    // Landing-page "#section" anchors change only the hash; they stay on the landing page.
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
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
    setReturnScreen(screen === "not-found" ? "landing" : screen);
    navigate(target);
  };

  if (screen === "integrations") return <IntegrationsPage onBack={() => navigate(returnScreen === "integrations" ? "landing" : returnScreen)} />;
  if (screen === "marketplace") return <MarketplacePage onBack={() => navigate(returnScreen === "marketplace" ? "landing" : returnScreen)} />;

  if (screen === "not-found") return <NotFoundPage onHome={() => navigate("landing")} onChat={() => navigate("conversation")} />;

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
          navigate(pendingScreen ?? "conversation");
          setPendingScreen(null);
        }}
        onResume={() => { navigate(pendingScreen ?? "conversation"); setPendingScreen(null); }}
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
