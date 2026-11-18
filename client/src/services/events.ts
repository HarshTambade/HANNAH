import { apiFetch, apiUrl, hasApiSession } from "./api";

const ALLOWED_EVENTS = new Set([
  "first_message_sent",
  "third_message_sent",
  "session_duration",
  "chat_opened",
  "voice_used",
  "tool_confirmation_approved",
  "tool_confirmation_rejected",
  "app_foregrounded",
]);

export function trackEvent(name: string, properties: Record<string, unknown> = {}) {
  if (!ALLOWED_EVENTS.has(name)) return;
  // Before connecting there's nothing to send them with; the server would refuse.
  if (!hasApiSession()) return;
  const payload = {
    event: name,
    ...Object.fromEntries(Object.entries(properties).slice(0, 12)),
    appVersion: (window as any).__HANNAH_APP_VERSION__ || "1.0.0",
    platform: navigator.userAgent.includes("Capacitor") ? "mobile" : "web",
    timestamp: new Date().toISOString(),
  };
  void apiFetch(apiUrl("/api/events"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Telemetry is best effort and must never block the UI.
  });
}