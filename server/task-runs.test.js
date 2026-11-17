const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "task-runs-test-token-0123456789-abcdefghijkl";
// The same suite runs on embedded Postgres from task-runs.pglite.test.js.
process.env.DATABASE_URL = process.env.HANNAH_TEST_DB === "pglite" ? "postgres://pglite.local/hannah" : "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "c".repeat(64);

let server;
let baseUrl;

before(async () => {
  if (process.env.HANNAH_TEST_DB === "pglite") await require("./db").useDatabase(await require("./db/pglite-adapter").createPgliteAdapter());
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await require("./db").resetDatabase();
});

async function signUp(email) {
  const response = await fetch(`${baseUrl}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery" }) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.headers.get("set-cookie").split(";")[0];
}

let writes = 0;
const writeId = () => `write-${String(++writes).padStart(6, "0")}`;

function client(cookie, device) {
  const call = async (path, init = {}) => {
    const response = await fetch(`${baseUrl}/api${path}`, { ...init, headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) } });
    return { status: response.status, body: await response.json() };
  };
  const as = { deviceId: device.id, deviceName: device.name };
  return {
    save: (id, body) => call(`/account/runs/${id}`, { method: "PUT", body: JSON.stringify({ ...as, writeId: writeId(), ...body }) }),
    claim: (id) => call(`/account/runs/${id}/claim`, { method: "POST", body: JSON.stringify(as) }),
    heartbeat: (id) => call(`/account/runs/${id}/heartbeat`, { method: "POST", body: JSON.stringify(as) }),
    cancel: (id) => call(`/account/runs/${id}/cancel`, { method: "POST", body: JSON.stringify(as) }),
    remove: (id) => call(`/account/runs/${id}?deviceId=${device.id}`, { method: "DELETE" }),
    list: () => call("/account/runs"),
    get: (id) => call(`/account/runs/${id}`),
    raw: call,
  };
}

const laptop = { id: "laptop-device-0001", name: "MacBook" };
const phone = { id: "phone-device-00001", name: "Pixel" };

const record = (steps) => ({ objective: "Plan a weekend in Pune", steps });
const step = (id, status, output) => ({ id, agent: "research", task: id, dependsOn: [], status, attempts: status === "pending" ? 0 : 1, ...(output ? { output } : {}) });

/** Simulates the running device disappearing: its lease runs out. */
async function expireLease(id) {
  const db = await require("./db").getDatabase();
  await db.query("UPDATE hannah_task_runs SET lease_expires_at = 0 WHERE id = $1", [id]);
}

test("a run checkpointed on the laptop resumes on the phone after the laptop pauses it", async () => {
  const cookie = await signUp("runs@example.com");
  const onLaptop = client(cookie, laptop);
  const onPhone = client(cookie, phone);

  const created = await onLaptop.save("team-run-0001", { title: "Plan a weekend in Pune", status: "running", record: record([step("s1", "running"), step("s2", "pending")]) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.run.version, 1);
  assert.deepEqual(created.body.run.lease && created.body.run.lease.deviceId, laptop.id);

  const checkpoint = await onLaptop.save("team-run-0001", { status: "running", baseVersion: 1, record: record([step("s1", "done", "Sunny"), step("s2", "pending")]) });
  assert.equal(checkpoint.status, 200);
  assert.equal(checkpoint.body.run.version, 2);

  // The phone sees it running on the laptop and can't take it or write to it.
  const seen = await onPhone.list();
  assert.equal(seen.body.runs.length, 1);
  assert.equal(seen.body.runs[0].lease.deviceName, "MacBook");
  assert.equal(seen.body.runs[0].record.steps[0].output, "Sunny");
  const refused = await onPhone.claim("team-run-0001");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, "lease-held");
  assert.match(refused.body.error, /running on MacBook/);
  assert.equal((await onPhone.save("team-run-0001", { status: "running", baseVersion: 2, record: record([]) })).body.reason, "lease-held");

  // Pausing releases the lease; the phone claims it and gets the checkpoint.
  const paused = await onLaptop.save("team-run-0001", { status: "paused", baseVersion: 2, record: record([step("s1", "done", "Sunny"), step("s2", "stopped")]) });
  assert.equal(paused.body.run.lease, null);
  const claimed = await onPhone.claim("team-run-0001");
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.run.status, "running");
  assert.equal(claimed.body.run.lease.deviceId, phone.id);
  assert.deepEqual(claimed.body.run.record.steps.map((item) => item.status), ["done", "stopped"]);

  const finished = await onPhone.save("team-run-0001", { status: "completed", baseVersion: claimed.body.run.version, record: record([step("s1", "done", "Sunny"), step("s2", "done", "Trains at 9")]) });
  assert.equal(finished.status, 200);
  assert.equal(finished.body.run.status, "completed");
  assert.ok(finished.body.run.finishedAt);
  // Completed runs are final.
  assert.equal((await onLaptop.claim("team-run-0001")).body.reason, "final");
});

test("a device that disappears loses its lease, and its stale checkpoint can't overwrite the newer one", async () => {
  const cookie = await signUp("stale@example.com");
  const onLaptop = client(cookie, laptop);
  const onPhone = client(cookie, phone);
  await onLaptop.save("team-run-0002", { title: "Compare flights", status: "running", record: record([step("s1", "running")]) });
  assert.equal((await onLaptop.heartbeat("team-run-0002")).status, 200);

  await expireLease("team-run-0002");
  const listed = await onPhone.list();
  assert.equal(listed.body.runs[0].status, "running");
  assert.equal(listed.body.runs[0].lease, null, "an expired lease isn't reported as active");
  const claimed = await onPhone.claim("team-run-0002");
  assert.equal(claimed.status, 200);
  assert.equal((await onPhone.save("team-run-0002", { status: "running", baseVersion: claimed.body.run.version, record: record([step("s1", "done", "Phone result")]) })).status, 200);

  // The laptop comes back: its heartbeat and its old checkpoint are refused.
  const heartbeat = await onLaptop.heartbeat("team-run-0002");
  assert.equal(heartbeat.status, 409);
  assert.equal(heartbeat.body.reason, "lease-held");
  const stale = await onLaptop.save("team-run-0002", { status: "running", baseVersion: 1, record: record([step("s1", "done", "Laptop result")]) });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.reason, "lease-held");
  await onPhone.save("team-run-0002", { status: "paused", baseVersion: claimed.body.run.version + 1, record: record([step("s1", "done", "Phone result")]) });
  const staleAfterPause = await onLaptop.save("team-run-0002", { status: "running", baseVersion: 1, record: record([step("s1", "done", "Laptop result")]) });
  assert.equal(staleAfterPause.body.reason, "stale");
  assert.match(staleAfterPause.body.error, /changed on Pixel/);
  assert.equal((await onPhone.get("team-run-0002")).body.run.record.steps[0].output, "Phone result");
});

test("repeating the same write is a no-op, not a conflict", async () => {
  const cookie = await signUp("replay@example.com");
  const onLaptop = client(cookie, laptop);
  await onLaptop.save("team-run-0003", { title: "Draft notes", status: "running", record: record([]) });
  const body = { status: "running", baseVersion: 1, writeId: "write-replay-01", record: record([step("s1", "done", "x")]) };
  const first = await onLaptop.save("team-run-0003", body);
  const again = await onLaptop.save("team-run-0003", body);
  assert.equal(first.body.run.version, 2);
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.run.version, 2);
});

test("cancelling from the phone stops the laptop's run at its next checkpoint", async () => {
  const cookie = await signUp("cancel@example.com");
  const onLaptop = client(cookie, laptop);
  const onPhone = client(cookie, phone);
  await onLaptop.save("team-run-0004", { title: "Long research", status: "running", record: record([step("s1", "running")]) });
  const cancelled = await onPhone.cancel("team-run-0004");
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.run.status, "cancelled");
  assert.equal(cancelled.body.run.lease, null);

  const heartbeat = await onLaptop.heartbeat("team-run-0004");
  assert.equal(heartbeat.body.reason, "cancelled");
  assert.match(heartbeat.body.error, /cancelled from Pixel/);
  assert.equal((await onLaptop.save("team-run-0004", { status: "running", baseVersion: 1, record: record([]) })).body.reason, "cancelled");
  assert.equal((await onLaptop.claim("team-run-0004")).body.reason, "cancelled");
  assert.equal((await onPhone.cancel("team-run-0004")).status, 409);
});

test("a run in progress on another device can't be deleted; a paused one can", async () => {
  const cookie = await signUp("delete@example.com");
  const onLaptop = client(cookie, laptop);
  const onPhone = client(cookie, phone);
  await onLaptop.save("team-run-0005", { title: "Busy", status: "running", record: record([]) });
  assert.equal((await onPhone.remove("team-run-0005")).body.reason, "lease-held");
  await onLaptop.save("team-run-0005", { status: "paused", baseVersion: 1, record: record([]) });
  assert.equal((await onPhone.remove("team-run-0005")).body.removed, true);
  // The laptop expected the run to exist: it's told it was removed, not given a fresh copy.
  assert.equal((await onLaptop.save("team-run-0005", { status: "running", baseVersion: 2, record: record([]) })).status, 404);
});

test("one account can never see or change another account's runs", async () => {
  const mine = client(await signUp("owner@example.com"), laptop);
  const theirs = client(await signUp("intruder@example.com"), phone);
  await mine.save("team-run-0006", { title: "Private plan", status: "paused", record: record([step("s1", "done", "secret")]) });

  assert.equal((await theirs.list()).body.runs.length, 0);
  assert.equal((await theirs.get("team-run-0006")).status, 404);
  assert.equal((await theirs.claim("team-run-0006")).status, 404);
  assert.equal((await theirs.cancel("team-run-0006")).status, 404);
  assert.equal((await theirs.remove("team-run-0006")).body.removed, false);
  // The same id in another account is a separate run.
  const own = await theirs.save("team-run-0006", { title: "Their own", status: "running", record: record([]) });
  assert.equal(own.status, 201);
  assert.equal((await mine.get("team-run-0006")).body.run.record.steps[0].output, "secret");

  const anonymous = await fetch(`${baseUrl}/api/account/runs`);
  assert.equal(anonymous.status, 401);
});

test("checkpoints are validated", async () => {
  const onLaptop = client(await signUp("validate@example.com"), laptop);
  assert.equal((await onLaptop.save("team-run-0007", { title: "x", status: "exploded", record: record([]) })).status, 400);
  assert.equal((await onLaptop.save("team-run-0007", { title: "x", status: "running", record: [] })).status, 400);
  assert.equal((await onLaptop.save("team-run-0007", { title: "", status: "running", record: record([]) })).status, 400);
  assert.equal((await onLaptop.save("bad id!", { title: "x", status: "running", record: record([]) })).status, 404);
  assert.equal((await onLaptop.save("team-run-0007", { title: "x", status: "running", writeId: "no", record: record([]) })).status, 400);
  const huge = await onLaptop.save("team-run-0007", { title: "x", status: "running", record: { blob: "a".repeat(200_001) } });
  assert.equal(huge.status, 413);
});

test("task runs are part of the account export", async () => {
  const cookie = await signUp("export-runs@example.com");
  await client(cookie, laptop).save("team-run-0008", { title: "Exported", status: "paused", record: record([step("s1", "done", "kept")]) });
  const response = await fetch(`${baseUrl}/api/account/export`, { headers: { Cookie: cookie } });
  const body = await response.json();
  assert.equal(body.taskRuns.length, 1);
  assert.equal(body.taskRuns[0].record.steps[0].output, "kept");
});
