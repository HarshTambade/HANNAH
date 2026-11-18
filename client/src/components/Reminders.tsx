import { useEffect, useState, type FormEvent } from "react";
import { Bell, BellRing, Check, Clock, X } from "lucide-react";
import {
  REMINDER_EVENT, REMINDER_FIRED_EVENT, ReminderService, notificationPermission, requestNotificationPermission, type Reminder,
} from "../services/ReminderService";
import { NATIVE_REMINDER_STATUS_EVENT, allowExactAlarms, allowReminderNotifications, nativeReminderStatus } from "../services/NativeReminders";

function formatDue(time: number) {
  const date = new Date(time);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const clock = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `Today, ${clock}`;
  if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow, ${clock}`;
  return `${date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${clock}`;
}

function localInputValue(time: number) {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** In-app alerts for reminders that come due while HANNAH is open. */
export function ReminderToasts() {
  const [fired, setFired] = useState<Reminder[]>([]);
  useEffect(() => {
    const onFired = (event: Event) => {
      const reminder = (event as CustomEvent<Reminder>).detail;
      setFired((current) => (current.some((item) => item.id === reminder.id) ? current : [...current, reminder]));
    };
    window.addEventListener(REMINDER_FIRED_EVENT, onFired);
    return () => window.removeEventListener(REMINDER_FIRED_EVENT, onFired);
  }, []);
  if (!fired.length) return null;
  const dismiss = (id: string) => setFired((current) => current.filter((item) => item.id !== id));
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-4 z-[70] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-5 sm:items-end">
      {fired.map((reminder) => (
        <section key={reminder.id} role="alert" aria-label="Reminder" className="pointer-events-auto w-full max-w-sm rounded-2xl border border-amber-200 bg-amber-50/95 p-4 shadow-[0_24px_60px_-30px_rgba(38,44,74,0.55)] backdrop-blur">
          <p className="flex items-center gap-2 text-xs font-semibold text-amber-900"><BellRing size={14} /> Reminder</p>
          <p className="mt-1 text-sm text-ink">{reminder.text}</p>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn-primary !py-1.5" onClick={() => { ReminderService.complete(reminder.id); dismiss(reminder.id); }}><Check size={14} /> Done</button>
            <button type="button" className="btn-outline !py-1.5" onClick={() => { ReminderService.complete(reminder.id); ReminderService.create(reminder.text, Date.now() + 10 * 60_000); dismiss(reminder.id); }}><Clock size={14} /> Snooze 10 min</button>
          </div>
        </section>
      ))}
    </div>
  );
}

/** Dashboard card: upcoming reminders with a quick add form. */
export function RemindersCard() {
  const [reminders, setReminders] = useState(() => ReminderService.upcoming());
  const [text, setText] = useState("");
  const [due, setDue] = useState(() => localInputValue(Date.now() + 60 * 60_000));
  const [error, setError] = useState("");
  const [permission, setPermission] = useState(notificationPermission);

  // In the Android and iOS apps reminders are handed to the phone (NativeReminders.ts); show its real state.
  const [phone, setPhone] = useState(nativeReminderStatus);
  useEffect(() => {
    const refresh = () => setReminders(ReminderService.upcoming());
    const refreshPhone = () => setPhone(nativeReminderStatus());
    window.addEventListener(REMINDER_EVENT, refresh);
    window.addEventListener(NATIVE_REMINDER_STATUS_EVENT, refreshPhone);
    return () => { window.removeEventListener(REMINDER_EVENT, refresh); window.removeEventListener(NATIVE_REMINDER_STATUS_EVENT, refreshPhone); };
  }, []);

  const add = (event: FormEvent) => {
    event.preventDefault();
    try {
      ReminderService.create(text, new Date(due).getTime());
      setText("");
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't add that reminder.");
    }
  };

  return (
    <section className="deck-frame" aria-label="Reminders">
      <div className="deck-card tone-plain">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-medium tracking-tight text-ink">Reminders</h2>
          {!phone.native && permission === "default" && (
            <button type="button" className="btn-outline !py-1.5 text-xs" onClick={async () => setPermission(await requestNotificationPermission())}><Bell size={13} /> Allow notifications</button>
          )}
          {!phone.native && permission === "denied" && <span className="text-xs text-slate-500">Notifications are blocked; alerts show in the app.</span>}
          {phone.native && phone.notifications === "denied" && (
            <button type="button" className="btn-outline !py-1.5 text-xs" onClick={() => void allowReminderNotifications()}><Bell size={13} /> Allow notifications</button>
          )}
        </div>
        {phone.native && phone.notifications === "denied" && <p role="status" className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">Notifications are off for HANNAH, so reminders can't arrive while the app is closed. Allow them here, or in the phone's Settings → Apps → HANNAH → Notifications.</p>}
        {phone.native && phone.exactAlarms === "denied" && (
          <p role="status" className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Android hasn't allowed HANNAH exact alarms, so a reminder can arrive a few minutes late. <button type="button" className="font-semibold underline" onClick={() => void allowExactAlarms()}>Allow exact alarms</button>
          </p>
        )}
        {phone.error && <p role="alert" className="mt-2 text-xs text-rose-700">Reminders couldn't be handed to the phone: {phone.error}</p>}
        {reminders.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No upcoming reminders. Add one here, or ask HANNAH: “remind me to call Mum at 6.”</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {reminders.slice(0, 6).map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{item.text}</p>
                  <p className="text-xs text-slate-500">{formatDue(item.dueAt)}</p>
                </div>
                <button type="button" aria-label={`Cancel reminder: ${item.text}`} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-rose-600" onClick={() => ReminderService.cancel(item.id)}><X size={14} /></button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={add} className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
          <label htmlFor="reminder-text" className="sr-only">Reminder</label>
          <input id="reminder-text" value={text} onChange={(event) => setText(event.target.value)} placeholder="Remind me to…" maxLength={300} className="min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-base text-ink outline-none focus:border-sky-400 sm:text-sm" />
          <label htmlFor="reminder-due" className="sr-only">When</label>
          <input id="reminder-due" type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-base text-ink outline-none focus:border-sky-400 sm:text-sm" />
          <button type="submit" className="btn-primary" disabled={!text.trim()}>Add</button>
        </form>
        {error && <p role="alert" className="mt-2 text-xs text-rose-700">{error}</p>}
        <p className="mt-2 text-xs text-slate-500">{phone.native
          ? phone.notifications === "granted" ? `Reminders arrive as phone notifications, even when HANNAH is closed (${phone.scheduled} scheduled).` : "Reminders arrive as phone notifications once you allow them."
          : "Alerts arrive while HANNAH is open in a tab or the app."}</p>
      </div>
    </section>
  );
}
