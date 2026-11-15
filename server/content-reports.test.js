"use strict";

const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  appendContentReport,
  buildContentReportDocument,
  createContentReportHandler,
  validateContentReportPayload,
} = require("./content-reports");

const validPayload = {
  messageId: "8f14e45f-ceea-4674-9c1e-7d6f4b7a2c11",
  reason: "harmful",
  appVersion: "1.0.0",
  platform: "Android",
  inferenceMode: "Local",
  modeDetail: "native",
};

function invokeHandler(handler, body) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        resolve({ status: this.statusCode, body: payload });
      },
    };
    Promise.resolve(handler({ body }, res)).catch(reject);
  });
}

test("validates the metadata-only content report schema", () => {
  const valid = validateContentReportPayload({ ...validPayload, message: "This text must be ignored." });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.messageId, validPayload.messageId);
  assert.equal(valid.value.reason, "harmful");
  assert.equal(valid.value.inferenceMode, "Local");
  assert.equal(valid.value.message, undefined);

  assert.equal(validateContentReportPayload(null).ok, false);
  assert.equal(validateContentReportPayload({ ...validPayload, messageId: "short" }).ok, false);
  assert.equal(validateContentReportPayload({ ...validPayload, messageId: "../../etc/passwd" }).ok, false);
  assert.equal(validateContentReportPayload({ ...validPayload, reason: "spam" }).ok, false);
  assert.equal(validateContentReportPayload({ ...validPayload, platform: "Linux" }).ok, false);
  assert.equal(validateContentReportPayload({ ...validPayload, inferenceMode: "Edge" }).ok, false);
  assert.equal(validateContentReportPayload({ ...validPayload, modeDetail: "bad mode\n" }).ok, false);
});

test("builds a document without message text or identity fields", () => {
  const document = buildContentReportDocument(validPayload, {
    id: "report-1",
    receivedAt: new Date("2026-11-15T10:00:00.000Z"),
  });
  assert.deepEqual(document, {
    schemaVersion: 1,
    id: "report-1",
    receivedAt: "2026-11-15T10:00:00.000Z",
    messageId: validPayload.messageId,
    reason: "harmful",
    appVersion: "1.0.0",
    platform: "Android",
    inferenceMode: "Local",
    modeDetail: "native",
    source: "in-app-ai-content-report",
  });
  assert.equal("message" in document, false);
  assert.equal("ip" in document, false);
});

test("appends one JSON object per line to the report log", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shanaya-content-reports-"));
  const logPath = path.join(directory, "nested", "content_reports.jsonl");
  try {
    await appendContentReport(buildContentReportDocument(validPayload, { id: "report-a" }), { logPath });
    await appendContentReport(buildContentReportDocument({ ...validPayload, reason: "other" }, { id: "report-b" }), { logPath });

    const raw = await readFile(logPath, "utf8");
    const records = raw.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.equal(records[0].id, "report-a");
    assert.equal(records[1].reason, "other");
    assert.equal(raw.includes("This text must be ignored"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("handler returns 202 with a report id and rejects invalid payloads", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shanaya-content-handler-"));
  const logPath = path.join(directory, "content_reports.jsonl");
  try {
    const handler = createContentReportHandler({ logPath });

    const rejected = await invokeHandler(handler, { messageId: "short", reason: "other" });
    assert.equal(rejected.status, 400);

    const accepted = await invokeHandler(handler, { ...validPayload, message: "private assistant reply" });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.ok, true);
    assert.equal(typeof accepted.body.id, "string");

    const records = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].messageId, validPayload.messageId);
    assert.equal(JSON.stringify(records[0]).includes("private assistant reply"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
