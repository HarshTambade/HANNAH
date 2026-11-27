/**
 * Teammate alerts anywhere in the app: a teammate is waiting for an approval,
 * a task finished, or work is blocked. The server decides what counts
 * (GET /api/workforce/notifications); this shows new ones as a small toast
 * that links to Agent Activity.
 *
 * When the app is in the background it also shows a system notification:
 * on a phone through the app's local notifications, in a browser or the
 * desktop app through the Notification API. Only when that permission was
 * already given; this never asks for it on its own.
 */
import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { X } from "lucide-react";
import workforce, { type NotificationItem } from "../services/Workforce";
import { ACCOUNT_EVENT, isAccountSession } from "../services/api";

const POLL_MS = 30_000;
const SHOWN = new Set(["approvals", "failures", "completions"]);

async function systemNotify(item: NotificationItem) {
  const title = item.category === "approvals" ? "A teammate needs your approval" : item.category === "failures" ? "A teammate's work is blocked" : "A teammate finished a task";
  const body = item.text.split("\n")[0].slice(0, 240);
  try {
    if (Capacitor.isNativePlatform()) {
      const permission = await LocalNotifications.checkPermissions();
      if (permission.display !== "granted") return;
      // A stable id per event, so the same alert is never shown twice.
      const id = Math.abs([...item.id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7)) % 2_000_000_000;
      await LocalNotifications.schedule({ notifications: [{ id, title, body, extra: { url: "/activity" } }] });
      return;
    }
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const notification = new Notification(title, { body, tag: `hannah-workforce-${item.id}` });
    notification.onclick = () => { window.focus(); window.location.assign(item.category === "approvals" ? "/activity#approvals" : "/activity#tasks"); notification.close(); };
  } catch {
    // Some WebViews expose Notification but can't construct it.
  }
}

export default function WorkforceAlerts() {
  const [signedIn, setSignedIn] = useState(isAccountSession);
  const [alerts, setAlerts] = useState<NotificationItem[]>([]);
  const since = useRef<number | null>(null);

  useEffect(() => {
    const sync = () => setSignedIn(isAccountSession());
    window.addEventListener(ACCOUNT_EVENT, sync);
    return () => window.removeEventListener(ACCOUNT_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!signedIn) { since.current = null; setAlerts([]); return; }
    let stopped = false;
    const check = async () => {
      try {
        const result = await workforce.notifications(since.current ?? undefined);
        if (stopped) return;
        // The first check only sets the starting point: old alerts aren't replayed on every page load.
        if (since.current === null) { since.current = result.serverTime; return; }
        since.current = Math.max(since.current, ...result.notifications.map((item) => item.createdAt));
        const fresh = result.notifications.filter((item) => SHOWN.has(item.category)).reverse();
        if (!fresh.length) return;
        setAlerts((current) => [...current, ...fresh].slice(-3));
        if (document.visibilityState !== "visible") for (const item of fresh) await systemNotify(item);
      } catch {
        // Signed out, offline, or no workforce on this server: try again later.
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), POLL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [signedIn]);

  if (!alerts.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-24 left-3 z-50 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2 md:bottom-4" aria-live="polite" data-testid="workforce-alerts">
      {alerts.map((item) => (
        <div key={item.id} className="pointer-events-auto rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-lg" role="status">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-slate-800">{item.text.split("\n")[0]}</p>
            <button type="button" onClick={() => setAlerts((list) => list.filter((entry) => entry.id !== item.id))} className="rounded p-0.5 text-slate-400 hover:bg-slate-100" aria-label="Dismiss"><X size={14} /></button>
          </div>
          <a href={item.category === "approvals" ? "/activity#approvals" : "/activity#tasks"} className="mt-1 inline-block text-xs font-semibold text-slate-900 underline">{item.category === "approvals" ? "Decide in Agent Activity" : "Open in Agent Activity"}</a>
        </div>
      ))}
    </div>
  );
}
