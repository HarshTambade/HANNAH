"use strict";

// The permission manager's rules, as pure decisions: no database, no network.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { defaultPolicy, evaluate, normalizeGrant, normalizePolicy, resourceCovers } = require("./actions/permissions");

const NOW = Date.parse("2026-11-20T10:00:00Z");
const policy = (levels = {}, stoppedAt = null) => ({ ...normalizePolicy({ levels }), stoppedAt });
const action = (id, service, kind, extra = {}) => ({ id, service, kind, ...extra });
const grant = (input, level = 4) => normalizeGrant(input, { now: NOW, level });
const decide = (args) => evaluate({ now: NOW, ...args });

test("the default is approval before action for every service", () => {
  const levels = defaultPolicy().levels;
  assert.ok(Object.values(levels).every((level) => level === 3));
  assert.equal(decide({ policy: policy(), action: action("mail.search", "mail", "read") }).outcome, "allow");
  assert.equal(decide({ policy: policy(), action: action("mail.draft", "mail", "prepare") }).outcome, "allow");
  assert.equal(decide({ policy: policy(), action: action("mail.send", "mail", "send") }).outcome, "ask");
  assert.equal(decide({ policy: policy(), action: action("calendar.create", "calendar", "write") }).outcome, "ask");
});

test("read only refuses everything but reading; suggest prepares and submits nothing", () => {
  const readOnly = policy({ mail: 1 });
  assert.equal(decide({ policy: readOnly, action: action("mail.search", "mail", "read") }).outcome, "allow");
  assert.equal(decide({ policy: readOnly, action: action("mail.draft", "mail", "prepare") }).outcome, "deny");
  assert.equal(decide({ policy: readOnly, action: action("mail.send", "mail", "send") }).outcome, "deny");
  const suggest = policy({ mail: 2 });
  assert.equal(decide({ policy: suggest, action: action("mail.draft", "mail", "prepare") }).outcome, "allow");
  const sent = decide({ policy: suggest, action: action("mail.send", "mail", "send") });
  assert.equal(sent.outcome, "suggest");
  assert.match(sent.reason, /not submitted/);
});

test("a standing permission lets one action through, for the resource and limits it names, and nothing else", () => {
  const level4 = policy({ mail: 4 });
  const send = action("mail.send", "mail", "send");
  const toTeam = grant({ service: "mail", actions: ["mail.send"], resource: { type: "recipient", match: "*@team.example" }, note: "Team updates" });
  const call = (ids) => ({ resource: { type: "recipient", id: ids[0], all: ids } });
  const allowed = decide({ policy: level4, grants: [toTeam], action: send, call: call(["asha@team.example"]) });
  assert.equal(allowed.outcome, "allow");
  assert.equal(allowed.grantId, toTeam.id);
  // Someone outside the grant on the same message: every recipient has to be covered.
  assert.equal(decide({ policy: level4, grants: [toTeam], action: send, call: call(["asha@team.example", "stranger@elsewhere.example"]) }).outcome, "ask");
  assert.equal(decide({ policy: level4, grants: [toTeam], action: send, call: call(["stranger@elsewhere.example"]) }).outcome, "ask");
  // A different action of the same service isn't covered.
  assert.equal(decide({ policy: level4, grants: [toTeam], action: action("mail.organize", "mail", "write"), call: {} }).outcome, "ask");
  // The same grant does nothing at level 3.
  assert.equal(decide({ policy: policy({ mail: 3 }), grants: [toTeam], action: send, call: call(["asha@team.example"]) }).outcome, "ask");
});

test("revoked and expired permissions stop applying at once", () => {
  const level4 = policy({ code: 4 });
  const publish = action("code.publish", "code", "send");
  const call = { resource: { type: "repo", id: "asha/site" } };
  const live = grant({ service: "code", actions: ["code.publish"], resource: { type: "repo", match: "asha/site" }, expiresAt: NOW + 3_600_000 });
  assert.equal(decide({ policy: level4, grants: [live], action: publish, call }).outcome, "allow");
  assert.equal(decide({ policy: level4, grants: [{ ...live, revokedAt: NOW - 1 }], action: publish, call }).outcome, "ask");
  assert.equal(decide({ policy: level4, grants: [live], action: publish, call, now: NOW + 3_600_001 }).outcome, "ask");
  // Another repository isn't covered.
  assert.equal(decide({ policy: level4, grants: [live], action: publish, call: { resource: { type: "repo", id: "asha/other" } } }).outcome, "ask");
});

test("limits: per day and hours of the day", () => {
  const level4 = policy({ messages: 4 });
  const send = action("messages.send", "messages", "send");
  const limited = grant({ service: "messages", actions: ["messages.send"], limits: { perDay: 2, hours: { from: 9, to: 17, timeZone: "UTC" } } });
  const call = { resource: { type: "recipient", id: "telegram:1" } };
  assert.equal(decide({ policy: level4, grants: [limited], action: send, call, usage: { today: new Map([[limited.id, 1]]) } }).outcome, "allow");
  assert.equal(decide({ policy: level4, grants: [limited], action: send, call, usage: { today: new Map([[limited.id, 2]]) } }).outcome, "ask");
  assert.equal(decide({ policy: level4, grants: [limited], action: send, call, now: Date.parse("2026-11-20T20:00:00Z") }).outcome, "ask");
});

test("paying, deleting and merging always ask, whatever the level or grants", () => {
  const all5 = policy({ bookings: 5, calendar: 5, code: 5 });
  const everything = (service) => grant({ service, actions: ["*"], expiresAt: NOW + 86_400_000 }, 5);
  assert.equal(decide({ policy: all5, grants: [everything("bookings")], action: action("bookings.payment", "bookings", "spend", { standing: false }), call: { amount: { value: 5, currency: "USD" } } }).outcome, "ask");
  assert.equal(decide({ policy: all5, grants: [everything("calendar")], action: action("calendar.delete", "calendar", "destroy"), call: {} }).outcome, "ask");
  assert.equal(decide({ policy: all5, grants: [everything("code")], action: action("code.merge", "code", "destroy"), call: {} }).outcome, "ask");
  // The same wide grant does cover an ordinary change.
  assert.equal(decide({ policy: all5, grants: [everything("calendar")], action: action("calendar.create", "calendar", "write"), call: {} }).outcome, "allow");
});

test("committing money by standing permission needs the exact action and an amount within the limit", () => {
  const level5 = policy({ bookings: 5 });
  const book = action("bookings.reserve", "bookings", "spend", { standing: true });
  const wide = grant({ service: "bookings", actions: ["*"], expiresAt: NOW + 86_400_000 }, 5);
  const exact = grant({ service: "bookings", actions: ["bookings.reserve"], limits: { maxAmount: 50, currency: "usd" } }, 5);
  assert.equal(decide({ policy: level5, grants: [wide], action: book, call: { amount: { value: 20, currency: "USD" } } }).outcome, "ask", "a service-wide grant never commits money");
  assert.equal(decide({ policy: level5, grants: [exact], action: book, call: { amount: { value: 20, currency: "USD" } } }).outcome, "allow");
  assert.equal(decide({ policy: level5, grants: [exact], action: book, call: { amount: { value: 80, currency: "USD" } } }).outcome, "ask");
  assert.equal(decide({ policy: level5, grants: [exact], action: book, call: { amount: { value: 20, currency: "EUR" } } }).outcome, "ask");
  assert.equal(decide({ policy: level5, grants: [exact], action: book, call: {} }).outcome, "ask", "no stated amount, no standing permission");
});

test("an action's own flags force a question even when a grant matches, and a forbidden flag refuses", () => {
  const level4 = policy({ mail: 4, code: 4 });
  const any = grant({ service: "mail", actions: ["mail.send"] });
  const flagged = decide({ policy: level4, grants: [any], action: action("mail.send", "mail", "send"), call: { resource: { type: "recipient", id: "a@b.example" }, flags: ["it attaches report.xlsx"] } });
  assert.equal(flagged.outcome, "ask");
  assert.match(flagged.reason, /attaches report\.xlsx/);
  const forbidden = decide({ policy: level4, action: action("code.publish", "code", "send"), call: { flags: ["forbidden:Committing straight to main is off for this repository."] } });
  assert.equal(forbidden.outcome, "deny");
  assert.equal(forbidden.reason, "Committing straight to main is off for this repository.");
});

test("the emergency stop refuses everything but reading", () => {
  const stopped = policy({ mail: 5 }, NOW - 1000);
  assert.equal(decide({ policy: stopped, action: action("mail.search", "mail", "read") }).outcome, "allow");
  for (const kind of ["prepare", "write", "send", "spend", "destroy"]) assert.equal(decide({ policy: stopped, action: action("x", "mail", kind) }).code, "stopped");
});

test("grants are checked when written: level, end date, known actions", () => {
  assert.throws(() => grant({ service: "mail", actions: ["mail.send"] }, 3), /level 4/);
  assert.throws(() => grant({ service: "mail", actions: ["*"], expiresAt: NOW + 1000 }, 4), /level 5/);
  assert.throws(() => grant({ service: "mail", actions: ["*"] }, 5), /end date/);
  assert.throws(() => grant({ service: "mail", actions: ["mail.send"], expiresAt: NOW - 1 }), /future/);
  assert.throws(() => grant({ service: "mail", actions: ["mail.send"], expiresAt: NOW + 400 * 86_400_000 }), /a year/);
  assert.throws(() => grant({ service: "nope", actions: ["x"] }), /service/);
  const known = new Map([["mail.send", { service: "mail" }], ["code.publish", { service: "code" }]]);
  assert.throws(() => normalizeGrant({ service: "mail", actions: ["code.publish"] }, { now: NOW, level: 4, knownActions: known }), /Not an action of this service/);
});

test("resource matching: exact, prefix and suffix, never a guess", () => {
  assert.equal(resourceCovers(null, null), true);
  assert.equal(resourceCovers({ type: "repo", match: "asha/*" }, { type: "repo", id: "asha/site" }), true);
  assert.equal(resourceCovers({ type: "repo", match: "asha/*" }, { type: "repo", id: "bo/site" }), false);
  assert.equal(resourceCovers({ type: "recipient", match: "*@team.example" }, { type: "recipient", id: "x@team.example.evil.example" }), false);
  assert.equal(resourceCovers({ type: "repo", match: "asha/site" }, null), false, "an action that names no resource isn't covered by a scoped grant");
  assert.equal(resourceCovers({ type: "repo", match: "asha/site" }, { type: "recipient", id: "asha/site" }), false);
});
