"use strict";

// The parts of the calendar and mail actions that are pure: time zones, repeat
// rules, free-slot search and the attachment message. No network.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { freeSlots, instant, normalizeRecurrence, rrule, zonedToUtc } = require("./actions/catalog/calendar");
const { SECRET_LOOKING, rawWithAttachments } = require("./actions/catalog/communications");

const iso = (at) => new Date(at).toISOString();

test("a time without an offset is read in the named zone, across clock changes", () => {
  assert.equal(iso(zonedToUtc("2026-11-21T15:00", "Asia/Kolkata")), "2026-11-21T09:30:00.000Z");
  // New York: UTC-5 in winter, UTC-4 in summer; the day the clocks change is handled from that day's own offset.
  assert.equal(iso(zonedToUtc("2026-01-15T09:00", "America/New_York")), "2026-01-15T14:00:00.000Z");
  assert.equal(iso(zonedToUtc("2026-07-15T09:00", "America/New_York")), "2026-07-15T13:00:00.000Z");
  assert.equal(iso(zonedToUtc("2026-03-08T12:00", "America/New_York")), "2026-03-08T16:00:00.000Z");
  assert.equal(iso(zonedToUtc("2026-11-01T12:00", "America/New_York")), "2026-11-01T17:00:00.000Z");
  // A time that states its own offset is an instant, whatever zone is named.
  assert.equal(iso(instant("2026-11-21T15:00:00+05:30", "start", "America/New_York")), "2026-11-21T09:30:00.000Z");
  assert.throws(() => instant("next tuesday", "The start time", "UTC"), /Times look like|must be a date and time/);
  assert.throws(() => instant("", "The start time", "UTC"), /missing/);
});

test("repeat rules are written the way calendars read them", () => {
  assert.equal(rrule(normalizeRecurrence({ frequency: "daily" })), "RRULE:FREQ=DAILY");
  assert.equal(rrule(normalizeRecurrence({ frequency: "weekly", interval: 2, days: ["mo", "WE", "xx"], count: 10 })), "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10");
  assert.equal(rrule(normalizeRecurrence({ frequency: "monthly", until: "2027-03-31" })), "RRULE:FREQ=MONTHLY;UNTIL=20270331T235959Z");
  assert.throws(() => normalizeRecurrence({ frequency: "hourly" }), /daily, weekly or monthly/);
  assert.throws(() => normalizeRecurrence({ frequency: "daily", until: "March" }), /2027-03-31/);
  assert.equal(normalizeRecurrence(null), null);
});

test("free slots stay inside working hours in the person's zone, skip busy time and its buffer, and skip weekends unless asked", () => {
  // Friday 20 Nov 2026, 09:00–18:00 in Kolkata is 03:30–12:30 UTC.
  const from = Date.parse("2026-11-20T00:00:00Z");
  const to = Date.parse("2026-11-23T00:00:00Z");
  const busy = [{ start: Date.parse("2026-11-20T04:30:00Z"), end: Date.parse("2026-11-20T05:30:00Z") }];
  const slots = freeSlots({ busy, from, to, durationMs: 60 * 60_000, timeZone: "Asia/Kolkata", hours: { from: 9, to: 18 }, limit: 20 });
  assert.equal(slots[0].start, "2026-11-20T03:30:00.000Z", "09:00 local is the first slot");
  assert.ok(slots.every((slot) => !(Date.parse(slot.start) < busy[0].end && Date.parse(slot.end) > busy[0].start)), "nothing overlaps the busy hour");
  assert.ok(slots.every((slot) => Date.parse(slot.end) <= Date.parse("2026-11-20T12:30:00Z")), "Saturday and Sunday are skipped, and nothing runs past 18:00 local");
  const buffered = freeSlots({ busy, from, to, durationMs: 60 * 60_000, timeZone: "Asia/Kolkata", hours: { from: 9, to: 18 }, bufferMs: 30 * 60_000, limit: 20 });
  assert.ok(buffered.every((slot) => Date.parse(slot.end) <= busy[0].start - 30 * 60_000 || Date.parse(slot.start) >= busy[0].end + 30 * 60_000));
  assert.ok(freeSlots({ busy: [], from, to, durationMs: 60 * 60_000, timeZone: "Asia/Kolkata", weekends: true, limit: 40 }).some((slot) => slot.start.startsWith("2026-11-21")));
  assert.deepEqual(freeSlots({ busy: [{ start: from, end: to }], from, to, durationMs: 60 * 60_000 }), []);
});

test("an email with attachments is a well-formed message, and header text can't inject headers", () => {
  const raw = Buffer.from(rawWithAttachments({ to: ["team@company.example"], cc: [], subject: "Q3 comparison — गुरुवार", body: "Both files are attached." }, [
    { name: "Comparison.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("PK\u0003\u0004 workbook bytes") },
    { name: 'Deck "final"\r\nBcc: attacker@evil.example.pptx', mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", buffer: Buffer.from("PK\u0003\u0004 deck bytes") },
  ]), "base64url").toString("utf8");
  const [head] = raw.split("\r\n\r\n");
  assert.match(head, /^To: team@company\.example\r\nSubject: =\?UTF-8\?B\?/);
  const boundary = /boundary="([^"]+)"/.exec(head)[1];
  const parts = raw.split(`--${boundary}`);
  assert.equal(parts.length, 5, "a text part, two attachments and the closing marker");
  assert.equal(Buffer.from(parts[1].split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8"), "Both files are attached.");
  assert.match(parts[2], /Content-Disposition: attachment; filename="Comparison\.xlsx"/);
  assert.equal(Buffer.from(parts[2].split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8"), "PK\u0003\u0004 workbook bytes");
  assert.ok(!/^Bcc:/m.test(raw), "a file name with line breaks adds no header");
  assert.match(raw, new RegExp(`--${boundary}--\\r\\n$`));
});

test("text that looks like a password, a code or a key is noticed", () => {
  for (const text of ["The password is: hunter2secret", "password=Tr0ub4dor", "Your OTP is 482913", `token ghp_${"a".repeat(36)}`, "-----BEGIN RSA PRIVATE KEY-----", "cvv: 123"]) assert.ok(SECRET_LOOKING.test(text), text);
  for (const text of ["I forgot my password again", "Let's pin this for Thursday", "The report is ready", "Is the key takeaway clear?"]) assert.ok(!SECRET_LOOKING.test(text), text);
});
