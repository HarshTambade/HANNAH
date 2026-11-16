import { detectPlatform } from "./appInfo";

type AnalyticsEvent =
  | "app_opened"
  | "chat_message_sent"
  | "tool_approved"
  | "local_model_downloaded"
  | "api_key_connected";

type EventProperties = Record<string, string | number | boolean | null>;

const ALLOWED_EVENTS = new Set<AnalyticsEvent>([
  "app_opened",
  "chat_message_sent",
  "tool_approved",
  "local_model_downloaded",
  "api_key_connected",
]);

let initialized = false;
let posthogReady = false;

function posthogKey() {
  return import.meta.env.VITE_POSTHOG_KEY?.trim();
}

function umamiWebsiteId() {
  return import.meta.env.VITE_UMAMI_WEBSITE_ID?.trim();
}

export function initAnalytics(): void {
  if (initialized) return;
  initialized = true;

  const posthog = posthogKey();
  if (posthog) {
    const host = import.meta.env.VITE_POSTHOG_HOST?.trim() || "https://us.i.posthog.com";
    void import("posthog-js")
      .then((module) => {
        const client = module.default;
        client.init(posthog, {
          api_host: host,
          capture_pageview: false,
          autocapture: false,
          disable_session_recording: true,
          person_profiles: "identified_only",
        });
        posthogReady = true;
      })
      .catch(() => {
        posthogReady = false;
      });
  }

  const umamiId = umamiWebsiteId();
  const umamiSrc = import.meta.env.VITE_UMAMI_SRC?.trim();
  if (umamiId && umamiSrc && typeof document !== "undefined") {
    const script = document.createElement("script");
    script.defer = true;
    script.async = true;
    script.src = umamiSrc;
    script.dataset.websiteId = umamiId;
    document.head.appendChild(script);
  }
}

export function trackEvent(event: AnalyticsEvent, properties: EventProperties = {}): void {
  if (!ALLOWED_EVENTS.has(event)) return;

  const safe: EventProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === "string" && value.length > 64) continue;
    safe[key] = value;
  }

  if (posthogReady) {
    void import("posthog-js").then((module) => {
      module.default.capture(event, safe);
    }).catch(() => undefined);
  }

  if (umamiWebsiteId() && typeof window !== "undefined" && typeof (window as any).umami?.track === "function") {
    (window as any).umami.track(event, safe);
  }
}

export function trackAppOpened() {
  trackEvent("app_opened", { platform: detectPlatform() });
}
