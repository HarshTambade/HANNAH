"use strict";

/**
 * Calendar actions (Google Calendar and Outlook, through the account's own
 * connection in server/connections.js): read events, find free time, create,
 * change and delete events. Every change is read back from the calendar before
 * it is called done.
 *
 * Times: an ISO time with an offset is an instant. A time without one
 * ("2026-11-21T15:00") is read in `timeZone` (an IANA name). Recurring events
 * keep the time zone, so "every day at 9" stays at 9 across clock changes.
 *
 * Other people's availability is only reported when their calendar answered:
 * someone whose free/busy can't be read is listed as unknown, never as free.
 */
const connections = require("../../connections");

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });
const line = (value, max) => String(value ?? "").replace(/[\r\n\u0000]+/g, " ").trim().slice(0, max);
const EMAIL = /^[^\s@<>,;"]{1,64}@[^\s@<>,;"]{1,190}\.[^\s@<>,;"]{2,63}$/;
const HAS_OFFSET = /(Z|[+-]\d\d:?\d\d)$/i;
const GOOGLE = "https://www.googleapis.com/calendar/v3";
const GRAPH = "https://graph.microsoft.com/v1.0/me";
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_NAMES = { SU: "sunday", MO: "monday", TU: "tuesday", WE: "wednesday", TH: "thursday", FR: "friday", SA: "saturday" };

function validZone(timeZone) {
  if (!timeZone) return "";
  try { new Intl.DateTimeFormat("en", { timeZone }); return String(timeZone); } catch { throw fail(400, `“${line(timeZone, 60)}” isn't a time zone. Use a name such as Asia/Kolkata.`, "bad-request"); }
}

/** The offset of a zone at an instant, in minutes east of UTC. */
function offsetMinutes(timeZone, at) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000);
}

/** A wall-clock time in a zone as an instant. */
function zonedToUtc(local, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(local));
  if (!match) throw fail(400, "Times look like 2026-11-21T15:00.", "bad-request");
  const guess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0));
  let at = guess - offsetMinutes(timeZone, guess) * 60_000;
  // Around a clock change the first guess can be an hour out; settle once more.
  at = guess - offsetMinutes(timeZone, at) * 60_000;
  return at;
}

function instant(value, label, timeZone) {
  const text = String(value ?? "").trim();
  if (!text) throw fail(400, `${label} is missing.`, "bad-request");
  if (HAS_OFFSET.test(text) || !timeZone) {
    const at = Date.parse(HAS_OFFSET.test(text) ? text : `${text}Z`);
    if (!Number.isFinite(at)) throw fail(400, `${label} must be a date and time, such as 2026-11-21T15:00:00+05:30.`, "bad-request");
    return at;
  }
  return zonedToUtc(text, timeZone);
}

const localIn = (at, timeZone) => {
  const shifted = new Date(at + offsetMinutes(timeZone || "UTC", at) * 60_000).toISOString();
  return shifted.slice(0, 19);
};
const when = (at, timeZone) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: timeZone || "UTC", timeZoneName: "short" }).format(new Date(at));

function normalizeRecurrence(raw) {
  if (!raw) return null;
  const frequency = String(raw.frequency || "").toLowerCase();
  if (!["daily", "weekly", "monthly"].includes(frequency)) throw fail(400, "A repeating event is daily, weekly or monthly.", "bad-request");
  const interval = Math.max(1, Math.min(52, Number(raw.interval) || 1));
  const days = [...new Set((Array.isArray(raw.days) ? raw.days : []).map((day) => String(day).slice(0, 2).toUpperCase()).filter((day) => DAYS.includes(day)))];
  const count = Number.isInteger(Number(raw.count)) && Number(raw.count) > 0 ? Math.min(Number(raw.count), 730) : null;
  const until = raw.until ? String(raw.until).slice(0, 10) : null;
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw fail(400, "The last date looks like 2027-03-31.", "bad-request");
  return { frequency, interval, days, count, until };
}

function rrule(recurrence) {
  const parts = [`FREQ=${recurrence.frequency.toUpperCase()}`, ...(recurrence.interval > 1 ? [`INTERVAL=${recurrence.interval}`] : []), ...(recurrence.frequency === "weekly" && recurrence.days.length ? [`BYDAY=${recurrence.days.join(",")}`] : [])];
  if (recurrence.count) parts.push(`COUNT=${recurrence.count}`);
  else if (recurrence.until) parts.push(`UNTIL=${recurrence.until.replace(/-/g, "")}T235959Z`);
  return `RRULE:${parts.join(";")}`;
}
const recurrenceText = (recurrence) => !recurrence ? "" : `Repeats ${recurrence.interval > 1 ? `every ${recurrence.interval} ${recurrence.frequency === "daily" ? "days" : recurrence.frequency === "weekly" ? "weeks" : "months"}` : recurrence.frequency}${recurrence.days.length ? ` on ${recurrence.days.join(", ")}` : ""}${recurrence.count ? `, ${recurrence.count} times` : recurrence.until ? ` until ${recurrence.until}` : ", with no end date"}`;

/** Merge busy intervals and return the free slots of `durationMs` inside working hours. */
function freeSlots({ busy, from, to, durationMs, timeZone = "UTC", hours = { from: 9, to: 18 }, stepMs = 30 * 60_000, bufferMs = 0, limit = 8, weekends = false }) {
  const merged = busy.map((item) => [item.start - bufferMs, item.end + bufferMs]).sort((a, b) => a[0] - b[0]).reduce((out, span) => {
    const last = out[out.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]); else out.push([...span]);
    return out;
  }, []);
  const slots = [];
  for (let start = Math.ceil(from / stepMs) * stepMs; start + durationMs <= to && slots.length < limit; start += stepMs) {
    const end = start + durationMs;
    const startLocal = new Date(start + offsetMinutes(timeZone, start) * 60_000);
    const endLocal = new Date(end + offsetMinutes(timeZone, end) * 60_000);
    const startHour = startLocal.getUTCHours() + startLocal.getUTCMinutes() / 60;
    const endHour = endLocal.getUTCHours() + endLocal.getUTCMinutes() / 60;
    if (startLocal.getUTCDate() !== endLocal.getUTCDate() || startHour < hours.from || endHour > hours.to || endHour === 0) continue;
    if (!weekends && [0, 6].includes(startLocal.getUTCDay())) continue;
    if (merged.some(([busyStart, busyEnd]) => start < busyEnd && end > busyStart)) continue;
    // One suggestion per hour of the day is enough to choose from.
    if (slots.length && start - slots[slots.length - 1].startAt < 60 * 60_000) continue;
    slots.push({ startAt: start, start: new Date(start).toISOString(), end: new Date(end).toISOString(), local: when(start, timeZone) });
  }
  return slots.map(({ startAt: _startAt, ...slot }) => slot);
}

function calendarActions({ fetchImpl = (...args) => fetch(...args) } = {}) {
  const call = (token, url, options) => connections.providerCall(fetchImpl, token, url, options);

  async function account(ctx, wanted) {
    const { rows } = await ctx.db.query("SELECT provider, account_email FROM hannah_connections WHERE user_id = $1", [ctx.userId]);
    if (!rows.length) throw fail(404, "No calendar is connected. Connect Google or Microsoft in Settings → Calendar and email.", "not-connected");
    let row = rows[0];
    if (wanted) {
      row = rows.find((item) => item.provider === wanted);
      if (!row) throw fail(404, `${wanted === "microsoft" ? "Microsoft" : "Google"} isn't connected.`, "not-connected");
    } else if (rows.length > 1) throw fail(400, "Both Google and Microsoft are connected. Say which one to use (provider: google or microsoft).", "choose-provider");
    return { providerId: row.provider, email: row.account_email || "", token: await connections.accessTokenFor(ctx.db, ctx.userId, row.provider, { fetchImpl, now: ctx.now }) };
  }
  async function eventsBetween(ctx, from, to, wanted) {
    const { rows } = await ctx.db.query("SELECT provider FROM hannah_connections WHERE user_id = $1", [ctx.userId]);
    const ids = rows.map((row) => row.provider).filter((id) => !wanted || id === wanted);
    if (!ids.length) throw fail(404, "No calendar is connected. Connect Google or Microsoft in Settings → Calendar and email.", "not-connected");
    const lists = await Promise.all(ids.map(async (id) => connections.listEvents(fetchImpl, id, await connections.accessTokenFor(ctx.db, ctx.userId, id, { fetchImpl, now: ctx.now }), { from: new Date(from).toISOString(), to: new Date(to).toISOString(), max: 50 })));
    return lists.flat().sort((a, b) => String(a.start).localeCompare(String(b.start)));
  }
  async function getEvent(target, id) {
    if (target.providerId === "google") {
      const item = await call(target.token, `${GOOGLE}/calendars/primary/events/${encodeURIComponent(id)}`);
      return { id: item.id, title: item.summary || "", start: item.start?.dateTime || item.start?.date || null, end: item.end?.dateTime || item.end?.date || null, status: item.status || "", link: item.htmlLink || "", attendees: (item.attendees || []).map((entry) => entry.email), meeting: item.hangoutLink || "", recurring: Boolean(item.recurrence?.length) };
    }
    const item = await call(target.token, `${GRAPH}/events/${encodeURIComponent(id)}?$select=subject,start,end,webLink,attendees,onlineMeeting,recurrence,isCancelled`, { headers: { Prefer: 'outlook.timezone="UTC"' } });
    const utc = (value) => (value?.dateTime ? new Date(`${value.dateTime.replace(/Z$/, "")}Z`).toISOString() : null);
    return { id: item.id, title: item.subject || "", start: utc(item.start), end: utc(item.end), status: item.isCancelled ? "cancelled" : "confirmed", link: item.webLink || "", attendees: (item.attendees || []).map((entry) => entry.emailAddress?.address).filter(Boolean), meeting: item.onlineMeeting?.joinUrl || "", recurring: Boolean(item.recurrence) };
  }
  /** Other people's busy time, where their calendar lets this account see it. */
  async function othersBusy(target, emails, from, to) {
    const out = [];
    if (!emails.length) return out;
    try {
      if (target.providerId === "google") {
        const data = await call(target.token, `${GOOGLE}/freeBusy`, { method: "POST", body: { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: emails.map((id) => ({ id })) } });
        for (const email of emails) {
          const entry = data.calendars?.[email];
          out.push(!entry || entry.errors?.length ? { email, known: false, busy: [] } : { email, known: true, busy: (entry.busy || []).map((span) => ({ start: Date.parse(span.start), end: Date.parse(span.end) })) });
        }
      } else {
        const data = await call(target.token, `${GRAPH}/calendar/getSchedule`, { method: "POST", headers: { Prefer: 'outlook.timezone="UTC"' }, body: { schedules: emails, startTime: { dateTime: new Date(from).toISOString().slice(0, 19), timeZone: "UTC" }, endTime: { dateTime: new Date(to).toISOString().slice(0, 19), timeZone: "UTC" }, availabilityViewInterval: 30 } });
        for (const email of emails) {
          const entry = (data.value || []).find((item) => String(item.scheduleId).toLowerCase() === email.toLowerCase());
          out.push(!entry || entry.error ? { email, known: false, busy: [] } : { email, known: true, busy: (entry.scheduleItems || []).filter((item) => item.status !== "free").map((item) => ({ start: Date.parse(`${item.start.dateTime}Z`), end: Date.parse(`${item.end.dateTime}Z`) })) });
        }
      }
    } catch {
      return emails.map((email) => ({ email, known: false, busy: [] }));
    }
    return out;
  }

  function normalizeEvent(raw, { partial = false } = {}) {
    const timeZone = validZone(raw.timeZone);
    const out = { provider: ["google", "microsoft"].includes(raw.provider) ? raw.provider : undefined, timeZone };
    if (!partial || raw.title !== undefined) { out.title = line(raw.title, 200); if (!out.title) throw fail(400, "Give the event a title.", "bad-request"); }
    if (!partial || raw.start !== undefined) {
      out.startAt = instant(raw.start, "The start time", timeZone);
      out.endAt = raw.end ? instant(raw.end, "The end time", timeZone) : out.startAt + Math.max(5, Math.min(24 * 60, Number(raw.durationMinutes) || 60)) * 60_000;
      if (out.endAt <= out.startAt) throw fail(400, "The event must end after it starts.", "bad-request");
      if (out.endAt - out.startAt > 14 * 86_400_000) throw fail(400, "An event can last two weeks at most.", "bad-request");
    }
    if (raw.location !== undefined) out.location = line(raw.location, 200);
    if (raw.description !== undefined) out.description = String(raw.description ?? "").slice(0, 4000);
    if (raw.attendees !== undefined) {
      const list = (Array.isArray(raw.attendees) ? raw.attendees : String(raw.attendees || "").split(/[,;]/)).map((item) => String(item).trim()).filter(Boolean);
      const bad = list.find((item) => !EMAIL.test(item));
      if (bad) throw fail(400, `“${line(bad, 80)}” isn't an email address. HANNAH only invites people by their full address.`, "ambiguous-recipient");
      if (list.length > 30) throw fail(400, "Up to 30 attendees.", "bad-request");
      out.attendees = [...new Set(list.map((item) => item.toLowerCase()))];
    }
    if (raw.recurrence) out.recurrence = normalizeRecurrence(raw.recurrence);
    if (raw.reminderMinutes !== undefined && raw.reminderMinutes !== null) out.reminderMinutes = Math.max(0, Math.min(40_320, Number(raw.reminderMinutes) || 0));
    if (raw.videoLink === true) out.videoLink = true;
    return out;
  }
  const times = (event, providerId) => {
    const zone = event.timeZone || "UTC";
    return providerId === "google"
      ? { start: { dateTime: localIn(event.startAt, zone), timeZone: zone }, end: { dateTime: localIn(event.endAt, zone), timeZone: zone } }
      : { start: { dateTime: localIn(event.startAt, zone), timeZone: zone }, end: { dateTime: localIn(event.endAt, zone), timeZone: zone } };
  };
  function body(event, providerId) {
    if (providerId === "google") {
      return {
        ...(event.title !== undefined ? { summary: event.title } : {}), ...(event.startAt ? times(event, providerId) : {}),
        ...(event.location !== undefined ? { location: event.location } : {}), ...(event.description !== undefined ? { description: event.description } : {}),
        ...(event.attendees ? { attendees: event.attendees.map((email) => ({ email })) } : {}),
        ...(event.recurrence ? { recurrence: [rrule(event.recurrence)] } : {}),
        ...(event.reminderMinutes !== undefined ? { reminders: { useDefault: false, overrides: [{ method: "popup", minutes: event.reminderMinutes }] } } : {}),
        ...(event.videoLink ? { conferenceData: { createRequest: { requestId: `hannah-${event.startAt}-${Math.abs(String(event.title).length)}`, conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
      };
    }
    const recurrence = event.recurrence && event.startAt ? {
      pattern: { type: event.recurrence.frequency === "monthly" ? "absoluteMonthly" : event.recurrence.frequency, interval: event.recurrence.interval,
        ...(event.recurrence.frequency === "weekly" ? { daysOfWeek: (event.recurrence.days.length ? event.recurrence.days : [DAYS[new Date(event.startAt + offsetMinutes(event.timeZone || "UTC", event.startAt) * 60_000).getUTCDay()]]).map((day) => DAY_NAMES[day]) } : {}),
        ...(event.recurrence.frequency === "monthly" ? { dayOfMonth: Number(localIn(event.startAt, event.timeZone || "UTC").slice(8, 10)) } : {}) },
      range: { startDate: localIn(event.startAt, event.timeZone || "UTC").slice(0, 10), recurrenceTimeZone: event.timeZone || "UTC",
        ...(event.recurrence.count ? { type: "numbered", numberOfOccurrences: event.recurrence.count } : event.recurrence.until ? { type: "endDate", endDate: event.recurrence.until } : { type: "noEnd" }) },
    } : null;
    return {
      ...(event.title !== undefined ? { subject: event.title } : {}), ...(event.startAt ? times(event, providerId) : {}),
      ...(event.location !== undefined ? { location: { displayName: event.location } } : {}), ...(event.description !== undefined ? { body: { contentType: "text", content: event.description } } : {}),
      ...(event.attendees ? { attendees: event.attendees.map((address) => ({ emailAddress: { address }, type: "required" })) } : {}),
      ...(recurrence ? { recurrence } : {}),
      ...(event.reminderMinutes !== undefined ? { isReminderOn: true, reminderMinutesBeforeStart: event.reminderMinutes } : {}),
      ...(event.videoLink ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
    };
  }
  const eventLines = (event) => [
    ...(event.title !== undefined ? [{ label: "Title", value: event.title }] : []),
    ...(event.startAt ? [{ label: "When", value: `${when(event.startAt, event.timeZone)} – ${when(event.endAt, event.timeZone).split(", ").pop()}` }] : []),
    ...(event.recurrence ? [{ label: "Repeats", value: recurrenceText(event.recurrence) }] : []),
    ...(event.location ? [{ label: "Where", value: event.location }] : []),
    ...(event.attendees?.length ? [{ label: "Invites", value: event.attendees.join(", ") }] : []),
    ...(event.videoLink ? [{ label: "Video link", value: "A meeting link is created" }] : []),
    ...(event.reminderMinutes !== undefined ? [{ label: "Reminder", value: `${event.reminderMinutes} minutes before` }] : []),
    ...(event.description ? [{ label: "Notes", value: event.description.slice(0, 600) }] : []),
  ];
  const providerName = (id) => (id === "microsoft" ? "Outlook" : "Google");

  return [
    {
      id: "calendar.events", service: "calendar", kind: "read", title: "Read calendar events",
      description: "Events on the connected calendars between two times (default: the next 7 days).",
      needs: "A connected Google or Microsoft account",
      input: { type: "object", properties: { from: { type: "string", description: "Start, ISO date-time." }, to: { type: "string", description: "End, ISO date-time." }, provider: { type: "string", description: "google or microsoft; omit for all connected." }, timeZone: { type: "string", description: "IANA time zone for times without an offset." } } },
      normalize(raw, ctx) {
        const timeZone = validZone(raw.timeZone);
        const from = raw.from ? instant(raw.from, "from", timeZone) : ctx.now();
        const to = raw.to ? instant(raw.to, "to", timeZone) : from + 7 * 86_400_000;
        if (to <= from) throw fail(400, "to must be after from.", "bad-request");
        if (to - from > 92 * 86_400_000) throw fail(400, "Ask for at most 92 days at a time.", "bad-request");
        return { from, to, provider: ["google", "microsoft"].includes(raw.provider) ? raw.provider : undefined };
      },
      async execute(params, ctx) {
        const events = await eventsBetween(ctx, params.from, params.to, params.provider);
        return { from: new Date(params.from).toISOString(), to: new Date(params.to).toISOString(), events };
      },
      verify: (response) => ({ confirmed: true, evidence: `The calendar returned ${response.events.length} event${response.events.length === 1 ? "" : "s"}.` }),
    },
    {
      id: "calendar.availability", service: "calendar", kind: "read", title: "Find free time",
      description: "Free slots of a given length inside working hours, from the connected calendars. Attendees' calendars are included only where they can be read; the rest are reported as unknown.",
      needs: "A connected Google or Microsoft account",
      input: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, durationMinutes: { type: "number" }, timeZone: { type: "string", description: "IANA time zone; working hours are in this zone." }, workingHours: { type: "object", properties: { from: { type: "number" }, to: { type: "number" } } }, bufferMinutes: { type: "number", description: "Travel or preparation time to keep free around existing events." }, attendees: { type: "array", items: { type: "string" } }, weekends: { type: "boolean" }, provider: { type: "string" } }, required: ["durationMinutes"] },
      normalize(raw, ctx) {
        const timeZone = validZone(raw.timeZone) || "UTC";
        const from = raw.from ? instant(raw.from, "from", timeZone) : ctx.now();
        const to = raw.to ? instant(raw.to, "to", timeZone) : from + 7 * 86_400_000;
        if (to <= from || to - from > 31 * 86_400_000) throw fail(400, "Look across at most 31 days.", "bad-request");
        const attendees = (Array.isArray(raw.attendees) ? raw.attendees : []).map((item) => String(item).trim().toLowerCase()).filter((item) => EMAIL.test(item)).slice(0, 15);
        const hoursFrom = Number.isFinite(Number(raw.workingHours?.from)) ? Math.max(0, Math.min(23, Number(raw.workingHours.from))) : 9;
        const hoursTo = Number.isFinite(Number(raw.workingHours?.to)) ? Math.max(hoursFrom + 1, Math.min(24, Number(raw.workingHours.to))) : 18;
        return { from, to, timeZone, durationMinutes: Math.max(5, Math.min(480, Number(raw.durationMinutes) || 60)), hours: { from: hoursFrom, to: hoursTo }, bufferMinutes: Math.max(0, Math.min(180, Number(raw.bufferMinutes) || 0)), attendees, weekends: raw.weekends === true, provider: ["google", "microsoft"].includes(raw.provider) ? raw.provider : undefined };
      },
      async execute(params, ctx) {
        const events = await eventsBetween(ctx, params.from, params.to, params.provider);
        const mine = events.filter((event) => event.start && event.end && !event.allDay).map((event) => ({ start: Date.parse(event.start), end: Date.parse(event.end) }));
        let people = [];
        if (params.attendees.length) {
          const target = await account(ctx, params.provider).catch(() => null);
          people = target ? await othersBusy(target, params.attendees, params.from, params.to) : params.attendees.map((email) => ({ email, known: false, busy: [] }));
        }
        const busy = [...mine, ...people.flatMap((person) => person.busy)];
        const slots = freeSlots({ busy, from: Math.max(params.from, ctx.now()), to: params.to, durationMs: params.durationMinutes * 60_000, timeZone: params.timeZone, hours: params.hours, bufferMs: params.bufferMinutes * 60_000, weekends: params.weekends });
        const unknown = people.filter((person) => !person.known).map((person) => person.email);
        return {
          timeZone: params.timeZone, durationMinutes: params.durationMinutes, slots, eventsConsidered: mine.length,
          attendees: people.map((person) => ({ email: person.email, availability: person.known ? "checked" : "unknown" })),
          note: unknown.length ? `These slots are free for you${people.some((person) => person.known) ? " and the attendees whose calendars could be read" : ""}. Availability is unknown for: ${unknown.join(", ")}.` : slots.length ? undefined : "No free slot of that length in the working hours given.",
        };
      },
      verify: (response) => ({ confirmed: true, evidence: `Checked against ${response.eventsConsidered} of your events.` }),
    },
    {
      id: "calendar.create", service: "calendar", kind: "write", title: "Add a calendar event",
      description: "Create an event, optionally repeating, with attendees, a reminder and a video link. Checks for conflicts and duplicates first.",
      needs: "A connected Google or Microsoft account",
      input: { type: "object", properties: { title: { type: "string" }, start: { type: "string", description: "ISO date-time; without an offset it is read in timeZone." }, end: { type: "string" }, durationMinutes: { type: "number" }, timeZone: { type: "string" }, location: { type: "string" }, description: { type: "string" }, attendees: { type: "array", items: { type: "string" }, description: "Full email addresses only." }, recurrence: { type: "object", properties: { frequency: { type: "string", description: "daily, weekly or monthly" }, interval: { type: "number" }, days: { type: "array", items: { type: "string" }, description: "MO TU WE TH FR SA SU" }, count: { type: "number" }, until: { type: "string" } } }, reminderMinutes: { type: "number" }, videoLink: { type: "boolean" }, provider: { type: "string" } }, required: ["title", "start"] },
      normalize: (raw) => normalizeEvent(raw),
      async assess(params, ctx) {
        const target = await account(ctx, params.provider);
        const nearby = await eventsBetween(ctx, params.startAt - 60_000, params.endAt + 60_000, target.providerId).catch(() => []);
        const flags = [];
        const duplicate = nearby.find((event) => event.title.trim().toLowerCase() === params.title.toLowerCase() && Math.abs(Date.parse(event.start) - params.startAt) < 60_000);
        if (duplicate) flags.push(`an event called “${duplicate.title}” is already at that time`);
        const conflicts = nearby.filter((event) => event !== duplicate && !event.allDay && Date.parse(event.start) < params.endAt && Date.parse(event.end) > params.startAt);
        if (conflicts.length) flags.push(`it overlaps ${conflicts.slice(0, 3).map((event) => `“${event.title}”`).join(", ")}`);
        if (params.attendees?.length) flags.push(`it sends invitations to ${params.attendees.join(", ")}`);
        return { resource: { type: "calendar", id: `${target.providerId}:primary` }, account: target.email, flags, conflicts: conflicts.map((event) => event.title), duplicate: Boolean(duplicate) };
      },
      preview: (params, _ctx, assessed) => ({ title: `Add “${params.title}” to your ${providerName(params.provider || assessed.resource?.id.split(":")[0])} calendar`, lines: eventLines(params), warnings: assessed.flags || [] }),
      async execute(params, ctx) {
        const target = await account(ctx, params.provider);
        const data = target.providerId === "google"
          ? await call(target.token, `${GOOGLE}/calendars/primary/events?sendUpdates=${params.attendees?.length ? "all" : "none"}${params.videoLink ? "&conferenceDataVersion=1" : ""}`, { method: "POST", body: body(params, "google") })
          : await call(target.token, `${GRAPH}/events`, { method: "POST", body: body(params, "microsoft") });
        return { provider: target.providerId, id: data.id, link: data.htmlLink || data.webLink || "", meeting: data.hangoutLink || data.onlineMeeting?.joinUrl || "" };
      },
      async verify(response, params, ctx) {
        const found = await getEvent(await account(ctx, response.provider), response.id);
        const sameStart = found.start && Math.abs(Date.parse(found.start) - params.startAt) < 60_000;
        const confirmed = found.title === params.title && (sameStart || found.recurring) && found.status !== "cancelled";
        return { confirmed, evidence: confirmed ? `The calendar has “${found.title}” at ${when(Date.parse(found.start), params.timeZone)}${found.attendees.length ? `, inviting ${found.attendees.length}` : ""}${found.meeting ? `, with a meeting link` : params.videoLink ? " (no meeting link was created)" : ""}. ${found.link}`.trim() : "The event the calendar returned doesn't match what was asked." };
      },
    },
    {
      id: "calendar.update", service: "calendar", kind: "write", title: "Change a calendar event",
      description: "Change an existing event's title, time, place, notes or attendees. Give the event's id and provider from calendar.events.",
      needs: "A connected Google or Microsoft account",
      input: { type: "object", properties: { id: { type: "string" }, provider: { type: "string" }, title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, durationMinutes: { type: "number" }, timeZone: { type: "string" }, location: { type: "string" }, description: { type: "string" }, attendees: { type: "array", items: { type: "string" } } }, required: ["id", "provider"] },
      normalize(raw) {
        const id = String(raw.id || "");
        if (!/^[A-Za-z0-9_=+/@.-]{1,400}$/.test(id)) throw fail(400, "That isn't an event id.", "bad-request");
        if (!["google", "microsoft"].includes(raw.provider)) throw fail(400, "Say which calendar the event is in (provider: google or microsoft).", "bad-request");
        const changes = normalizeEvent(raw, { partial: true });
        if (!["title", "startAt", "location", "description", "attendees"].some((key) => changes[key] !== undefined)) throw fail(400, "Say what to change.", "bad-request");
        return { ...changes, id, provider: raw.provider };
      },
      async assess(params, ctx) {
        const target = await account(ctx, params.provider);
        const current = await getEvent(target, params.id);
        const flags = [];
        if (current.attendees.length || params.attendees?.length) flags.push(`other people are on this event (${[...new Set([...current.attendees, ...(params.attendees || [])])].slice(0, 6).join(", ")}) and will be told`);
        if (params.startAt) {
          const nearby = await eventsBetween(ctx, params.startAt, params.endAt, target.providerId).catch(() => []);
          const conflicts = nearby.filter((event) => event.id !== params.id && !event.allDay && Date.parse(event.start) < params.endAt && Date.parse(event.end) > params.startAt);
          if (conflicts.length) flags.push(`the new time overlaps ${conflicts.slice(0, 3).map((event) => `“${event.title}”`).join(", ")}`);
        }
        return { resource: { type: "calendar", id: `${target.providerId}:primary` }, account: target.email, flags, current };
      },
      preview: (params, _ctx, assessed) => ({ title: `Change “${assessed.current?.title || "an event"}” in your ${providerName(params.provider)} calendar`, lines: [{ label: "Now", value: assessed.current?.start ? when(Date.parse(assessed.current.start), params.timeZone) : "" }, ...eventLines(params).map((item) => ({ ...item, label: `New ${item.label.toLowerCase()}` }))], warnings: assessed.flags || [] }),
      async execute(params, ctx) {
        const target = await account(ctx, params.provider);
        const data = target.providerId === "google"
          ? await call(target.token, `${GOOGLE}/calendars/primary/events/${encodeURIComponent(params.id)}?sendUpdates=all`, { method: "PATCH", body: body(params, "google") })
          : await call(target.token, `${GRAPH}/events/${encodeURIComponent(params.id)}`, { method: "PATCH", body: body(params, "microsoft") });
        return { provider: target.providerId, id: data.id || params.id, link: data.htmlLink || data.webLink || "" };
      },
      async verify(response, params, ctx) {
        const found = await getEvent(await account(ctx, response.provider), response.id);
        const checks = [params.title === undefined || found.title === params.title, !params.startAt || (found.start && Math.abs(Date.parse(found.start) - params.startAt) < 60_000)];
        const confirmed = checks.every(Boolean);
        return { confirmed, evidence: confirmed ? `The calendar now shows “${found.title}” at ${when(Date.parse(found.start), params.timeZone)}. ${found.link}`.trim() : "The calendar doesn't show the change." };
      },
    },
    {
      id: "calendar.delete", service: "calendar", kind: "destroy", title: "Delete a calendar event",
      description: "Delete an event. Attendees are told it was cancelled. Always asks first.",
      needs: "A connected Google or Microsoft account",
      input: { type: "object", properties: { id: { type: "string" }, provider: { type: "string" } }, required: ["id", "provider"] },
      normalize(raw) {
        const id = String(raw.id || "");
        if (!/^[A-Za-z0-9_=+/@.-]{1,400}$/.test(id) || !["google", "microsoft"].includes(raw.provider)) throw fail(400, "Give the event's id and provider from calendar.events.", "bad-request");
        return { id, provider: raw.provider };
      },
      async assess(params, ctx) {
        const target = await account(ctx, params.provider);
        return { resource: { type: "calendar", id: `${target.providerId}:primary` }, account: target.email, current: await getEvent(target, params.id) };
      },
      preview: (params, _ctx, assessed) => ({ title: `Delete “${assessed.current?.title || "an event"}” from your ${providerName(params.provider)} calendar`, lines: [{ label: "When", value: assessed.current?.start ? when(Date.parse(assessed.current.start)) : "" }, ...(assessed.current?.attendees?.length ? [{ label: "Attendees told", value: assessed.current.attendees.join(", ") }] : [])], warnings: ["This can't be undone."] }),
      async execute(params, ctx) {
        const target = await account(ctx, params.provider);
        const url = target.providerId === "google" ? `${GOOGLE}/calendars/primary/events/${encodeURIComponent(params.id)}?sendUpdates=all` : `${GRAPH}/events/${encodeURIComponent(params.id)}`;
        const response = await fetchImpl(url, { method: "DELETE", headers: { Authorization: `Bearer ${target.token}` }, redirect: "error", signal: AbortSignal.timeout(20_000) });
        if (!response.ok && response.status !== 410) throw fail(response.status === 404 ? 404 : 502, response.status === 404 ? "That event wasn't found." : `The calendar answered ${response.status}.`);
        return { provider: target.providerId, id: params.id, deleted: true };
      },
      async verify(response, _params, ctx) {
        try {
          const found = await getEvent(await account(ctx, response.provider), response.id);
          return found.status === "cancelled" ? { confirmed: true, evidence: "The calendar shows the event as cancelled." } : { confirmed: false, evidence: "The calendar still returns the event." };
        } catch (error) {
          return error.status === 404 ? { confirmed: true, evidence: "The calendar no longer has the event." } : { confirmed: false, evidence: "The calendar couldn't be read back." };
        }
      },
    },
  ];
}

module.exports = { calendarActions, freeSlots, instant, normalizeRecurrence, offsetMinutes, rrule, zonedToUtc };
