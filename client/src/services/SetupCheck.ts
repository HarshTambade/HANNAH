/**
 * Setup check: one pass over everything HANNAH needs on this device, with a
 * plain verdict per item and what to do about it. Nothing is changed, and
 * nothing leaves the device except the server's own health request.
 */
import { Capacitor } from "@capacitor/core";
import { apiFetch, apiUrl, getAccountHint, hasApiSession, isGuestSession } from "./api";
import { Connections } from "./Connections";
import { Diagnostics } from "./Diagnostics";
import { desktopFilesAvailable, hannahDesktop } from "./DesktopFiles";
import { Knowledge } from "./Knowledge";
import { Briefing } from "./Briefing";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";
export type CheckResult = { id: string; label: string; status: CheckStatus; detail: string; fix?: string };
export type SetupReport = { at: string; results: CheckResult[]; counts: Record<CheckStatus, number> };

const LOCAL_STORAGE_BUDGET = 5 * 1024 * 1024;

function setting(key: string) {
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`No answer within ${Math.round(ms / 1000)} seconds.`)), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Check = () => Promise<CheckResult> | CheckResult;

const checks: Record<string, Check> = {
  async network() {
    const online = typeof navigator === "undefined" ? true : navigator.onLine;
    return { id: "network", label: "Network", status: online ? "ok" : "warn", detail: online ? "This device is online." : "This device is offline. Cloud models and sync wait until it's back; on-device models still work." };
  },

  async server() {
    const started = Date.now();
    try {
      const response = await withTimeout(apiFetch(apiUrl("/api/health")), 10_000);
      const latency = Date.now() - started;
      if (!response.ok) return { id: "server", label: "HANNAH server", status: "fail", detail: `The server answered with HTTP ${response.status}.`, fix: "If this keeps happening, the server's logs say why; the website usually recovers on its own." };
      const body = (await response.json().catch(() => ({}))) as { provider?: string; ready?: boolean };
      return { id: "server", label: "HANNAH server", status: body.ready === false ? "warn" : "ok", detail: `Reachable in ${latency} ms${body.provider ? `, default provider ${body.provider}` : ""}${body.ready === false ? ", but it has no configured model of its own" : ""}.`, ...(body.ready === false ? { fix: "You can still use your own key: Settings → Connection." } : {}) };
    } catch (error) {
      return { id: "server", label: "HANNAH server", status: "fail", detail: error instanceof Error ? error.message : "The server couldn't be reached.", fix: "Check the connection, or the API URL in the app's settings if you self-host." };
    }
  },

  async ai() {
    const mode = setting("hannah.chat.mode") || "cloud";
    if (mode === "ollama") {
      try {
        const response = await withTimeout(apiFetch(apiUrl("/api/health/agent")), 15_000);
        const body = (await response.json().catch(() => ({}))) as { checks?: { ollama?: { ready?: boolean; model?: string; error?: string } } };
        const ollama = body.checks?.ollama;
        if (ollama?.ready) return { id: "ai", label: "AI model", status: "ok", detail: `Ollama is answering${ollama.model ? ` with ${ollama.model}` : ""}.` };
        return { id: "ai", label: "AI model", status: "fail", detail: `Ollama isn't ready${ollama?.error === "model_missing" ? ": the chosen model isn't pulled" : ""}.`, fix: "Start Ollama, pull the model, or choose another in Models." };
      } catch {
        return { id: "ai", label: "AI model", status: "fail", detail: "The Ollama probe didn't answer.", fix: "Start Ollama on the machine running the server, or choose a cloud model." };
      }
    }
    if (mode === "webllm" || mode === "native") return { id: "ai", label: "AI model", status: "ok", detail: mode === "webllm" ? "On-device model in this browser (WebGPU). Automations and background tasks need a cloud model or Ollama." : "On-device model in the app. Automations and background tasks need a cloud model or Ollama." };
    if (!hasApiSession()) return { id: "ai", label: "AI model", status: "fail", detail: "No key or access token for this session.", fix: "Connect with your Groq key or sign in: Settings → Connection." };
    const provider = setting("hannah.cloudProvider") || "groq";
    const model = setting(`hannah.cloudModel:${provider}`);
    return { id: "ai", label: "AI model", status: "ok", detail: `${isGuestSession() ? "Your own key" : "Access token"} with ${provider}${model ? `, model ${model}` : ", the provider's default model"}.` };
  },

  async account() {
    const hint = getAccountHint();
    if (hint) return { id: "account", label: "Account", status: "ok", detail: `Signed in${hint.displayName ? ` as ${hint.displayName}` : ""}. Memories, reminders and tasks follow you across devices.` };
    return { id: "account", label: "Account", status: "skip", detail: "Not signed in. Everything stays on this device; that's fine.", fix: "Sign in from Settings → Account to use HANNAH on more than one device." };
  },

  async connections() {
    const connected = Connections.connectedProviders();
    if (!getAccountHint()) return { id: "connections", label: "Calendar and email", status: "skip", detail: "Needs an account." };
    if (!connected.length) return { id: "connections", label: "Calendar and email", status: "skip", detail: "Nothing connected. HANNAH can't read your calendar or mail until you connect Google or Microsoft.", fix: "Settings → Calendar and email." };
    return { id: "connections", label: "Calendar and email", status: "ok", detail: `Connected: ${connected.map((item) => item.label).join(", ")}.` };
  },

  async voice() {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return { id: "voice", label: "Voice output", status: "warn", detail: "This browser has no speech synthesis. Hosted voices (OpenAI, Mithi) still work when configured.", fix: "Settings → Voice." };
    const voices = window.speechSynthesis.getVoices();
    return { id: "voice", label: "Voice output", status: "ok", detail: voices.length ? `${voices.length} device voice${voices.length === 1 ? "" : "s"} available.` : "Device speech is available; voices load on first use." };
  },

  async microphone() {
    try {
      if (typeof navigator === "undefined" || !navigator.permissions?.query) return { id: "microphone", label: "Microphone", status: "skip", detail: "This platform doesn't report microphone permission ahead of time; HANNAH asks when you press Speak." };
      const result = await navigator.permissions.query({ name: "microphone" as PermissionName });
      if (result.state === "granted") return { id: "microphone", label: "Microphone", status: "ok", detail: "Allowed." };
      if (result.state === "denied") return { id: "microphone", label: "Microphone", status: "warn", detail: "Blocked for this site, so voice input and the wake word can't listen.", fix: "Allow the microphone in the browser's site settings." };
      return { id: "microphone", label: "Microphone", status: "ok", detail: "Not asked yet. HANNAH asks the first time you press Speak." };
    } catch {
      return { id: "microphone", label: "Microphone", status: "skip", detail: "Permission can't be checked here; HANNAH asks when you press Speak." };
    }
  },

  async notifications() {
    if (typeof Notification === "undefined") return { id: "notifications", label: "Notifications", status: "skip", detail: "Not supported here. Reminders and automations still show inside HANNAH." };
    if (Notification.permission === "granted") return { id: "notifications", label: "Notifications", status: "ok", detail: "Allowed, so reminders and automation results can reach you in the background." };
    if (Notification.permission === "denied") return { id: "notifications", label: "Notifications", status: "warn", detail: "Blocked. Reminders and automation results show only while HANNAH is open.", fix: "Allow notifications in the browser's site settings." };
    return { id: "notifications", label: "Notifications", status: "warn", detail: "Not allowed yet.", fix: "Press Allow when a reminder first asks, or enable them from the Dashboard's reminders." };
  },

  async storage() {
    let bytes = 0;
    try {
      const store = window.localStorage;
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (key) bytes += ((store.getItem(key)?.length ?? 0) + key.length) * 2;
      }
    } catch {
      return { id: "storage", label: "Storage", status: "fail", detail: "This browser blocks local storage, so HANNAH can't keep anything between visits.", fix: "Leave private browsing or allow site data." };
    }
    const percent = Math.round((bytes / LOCAL_STORAGE_BUDGET) * 100);
    const knowledge = Knowledge.usage();
    const detail = `${Math.round(bytes / 1024)} KB used (about ${percent}% of the usual 5 MB)${knowledge.docs ? `, ${knowledge.docs} knowledge document${knowledge.docs === 1 ? "" : "s"}` : ""}.`;
    if (percent >= 85) return { id: "storage", label: "Storage", status: "warn", detail, fix: "Remove knowledge documents or clear old conversation data in Settings → Your data." };
    return { id: "storage", label: "Storage", status: "ok", detail };
  },

  async desktop() {
    if (!desktopFilesAvailable()) return { id: "desktop", label: "Desktop app", status: "skip", detail: `Running ${Capacitor.getPlatform() === "web" ? "in a browser" : `on ${Capacitor.getPlatform()}`}. Files, terminal, tray and the global shortcut are desktop-app features.` };
    try {
      const info = await withTimeout(hannahDesktop().desktopInfo(), 5_000);
      const problems = [!info.shortcut?.registered ? "the global shortcut isn't registered" : "", !info.tray ? "the tray icon is missing" : ""].filter(Boolean);
      return { id: "desktop", label: "Desktop app", status: problems.length ? "warn" : "ok", detail: `Version ${info.version}, ${info.channel} channel${problems.length ? `; ${problems.join(" and ")}` : "; tray and shortcut are in place"}.` };
    } catch {
      return { id: "desktop", label: "Desktop app", status: "warn", detail: "The desktop bridge didn't answer.", fix: "Restart the app. If it keeps happening, export diagnostics and send feedback." };
    }
  },

  async briefing() {
    const settings = Briefing.settings();
    const on = Object.entries(settings.sections).filter(([, enabled]) => enabled).map(([id]) => id);
    if (settings.sections.weather && !settings.location) return { id: "briefing", label: "Daily briefing", status: "warn", detail: "Weather is on but no place is chosen.", fix: "Settings → Daily briefing → choose a place." };
    return { id: "briefing", label: "Daily briefing", status: "ok", detail: `Sections: ${on.join(", ") || "none"}.` };
  },

  async diagnostics() {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recent = Diagnostics.list({ level: "error" }).filter((entry) => entry.at >= since);
    if (!recent.length) return { id: "diagnostics", label: "Recent errors", status: "ok", detail: "No errors recorded in the last 24 hours." };
    return { id: "diagnostics", label: "Recent errors", status: "warn", detail: `${recent.length} error${recent.length === 1 ? "" : "s"} in the last 24 hours; the newest: ${recent[recent.length - 1]!.message.slice(0, 120)}`, fix: "See Settings → Diagnostics." };
  },
};

export const CHECK_IDS = Object.keys(checks);

/** Run every check; one that throws becomes a failed item instead of stopping the rest. */
export async function runSetupCheck(only: string[] = CHECK_IDS): Promise<SetupReport> {
  const results = await Promise.all(
    only.filter((id) => checks[id]).map(async (id) => {
      try {
        return await checks[id]!();
      } catch (error) {
        return { id, label: id, status: "fail" as CheckStatus, detail: error instanceof Error ? error.message : "The check failed." };
      }
    }),
  );
  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const result of results) counts[result.status] += 1;
  return { at: new Date().toISOString(), results, counts };
}
