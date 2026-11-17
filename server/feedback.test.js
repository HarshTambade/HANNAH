const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildDiscordPayload, buildFeedbackDocument, validateFeedbackPayload } = require("./feedback");

const base = { message: "The avatar went blank after I connected.", inferenceMode: "cloud", platform: "Desktop", appVersion: "1.4.0", category: "bug" };
const report = {
  format: "hannah-diagnostics",
  version: 1,
  createdAt: "2026-11-17T10:00:00.000Z",
  app: "1.4.0",
  platform: "Desktop",
  userAgent: "HANNAH/1.4.0 Electron",
  online: true,
  memory: { usedMB: 412, limitMB: 4096 },
  storage: { keys: 31, approxKB: 220 },
  entries: [
    { at: 1, level: "warn", source: "ui", message: "The interface froze for 1.2 s." },
    { at: 2, level: "error", source: "crash", message: "The interface crashed: TypeError: x is undefined", detail: "TypeError: x is undefined\n    at AvatarScene" },
  ],
};

test("feedback without diagnostics is unchanged", () => {
  const result = validateFeedbackPayload(base);
  assert.equal(result.ok, true);
  assert.equal("diagnostics" in result.value, false);
  const document = buildFeedbackDocument(result.value, { id: "f1", receivedAt: new Date(0) });
  assert.equal(buildDiscordPayload(document).embeds[0].fields.some((field) => field.name.startsWith("Diagnostics")), false);
});

test("an attached report keeps only the allow-listed shape and is summarized for chat", () => {
  const result = validateFeedbackPayload({ ...base, diagnostics: { ...report, conversation: ["should be dropped"], entries: [...report.entries, { at: 3, level: "error", source: "agent", message: "x", apiKey: "gsk_nope" }] } });
  assert.equal(result.ok, true, result.error);
  const { diagnostics } = result.value;
  assert.deepEqual(Object.keys(diagnostics).sort(), ["app", "createdAt", "entries", "memory", "online", "platform", "storage", "userAgent"]);
  assert.equal(diagnostics.entries.length, 3);
  assert.deepEqual(Object.keys(diagnostics.entries[2]), ["at", "level", "source", "message"]);
  const document = buildFeedbackDocument(result.value, { id: "f2", receivedAt: new Date(0) });
  const field = buildDiscordPayload(document).embeds[0].fields.find((item) => item.name.startsWith("Diagnostics"));
  assert.ok(field);
  assert.match(field.value, /3 entries/);
  assert.match(field.value, /412 MB heap/);
  assert.match(field.value, /\[crash\] The interface crashed/);
  assert.ok(field.value.length <= 1024);
});

test("a malformed report is refused, and a long one is capped", () => {
  assert.equal(validateFeedbackPayload({ ...base, diagnostics: { format: "hannah-diagnostics", entries: [{ level: "loud", source: "ui", message: "x" }] } }).ok, false);
  assert.equal(validateFeedbackPayload({ ...base, diagnostics: { format: "something-else", entries: [] } }).ok, false);
  assert.equal(validateFeedbackPayload({ ...base, diagnostics: "yes" }).ok, false);
  const long = validateFeedbackPayload({ ...base, diagnostics: { ...report, entries: Array.from({ length: 500 }, (_, index) => ({ at: index, level: "info", source: "app", message: `entry ${index}` })) } });
  assert.equal(long.ok, true);
  assert.equal(long.value.diagnostics.entries.length, 100);
  assert.equal(long.value.diagnostics.entries[0].message, "entry 400");
});
