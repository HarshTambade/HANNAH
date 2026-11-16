const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "device-tasks-test-token-0123456789-abcdefghij";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "b".repeat(64);

let server;
let baseUrl;

before(async () => {
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

function client(cookie, device) {
  const call = async (path, init = {}) => {
    const response = await fetch(`${baseUrl}/api${path}`, { ...init, headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) } });
    return { status: response.status, body: await response.json() };
  };
  return {
    put: (id, body) => call(`/account/tasks/${id}`, { method: "PUT", body: JSON.stringify({ deviceId: device.id, deviceName: device.name, ...body }) }),
    decide: (id, approve, as = device) => call(`/account/tasks/${id}/decision`, { method: "POST", body: JSON.stringify({ approve, deviceId: as.id, deviceName: as.name }) }),
    list: (since) => call(`/account/tasks${since ? `?since=${since}` : ""}`),
    get: (id) => call(`/account/tasks/${id}`),
  };
}

const laptop = { id: "laptop-device-0001", name: "MacBook" };
const phone = { id: "phone-device-00001", name: "Pixel" };

test("a task started on one device shows on the other, and only its device updates it", async () => {
  const cookie = await signUp("tasks@example.com");
  const onLaptop = client(cookie, laptop);
  const onPhone = client(cookie, phone);
  const created = await onLaptop.put("team-run-0001", { kind: "task", title: "Research flights to Lisbon", status: "running", detail: "Planning" });
  assert.equal(created.status, 201);
  const seen = await onPhone.list();
  assert.equal(seen.body.tasks.length, 1);
  assert.deepEqual(seen.body.tasks[0].device, laptop);
  assert.equal(seen.body.tasks[0].status, "running");

  assert.equal((await onPhone.put("team-run-0001", { kind: "task", status: "done" })).status, 409);
  const done = await onLaptop.put("team-run-0001", { kind: "task", status: "done", detail: "Found three options" });
  assert.equal(done.body.task.status, "done");
  assert.equal(done.body.task.title, "Research flights to Lisbon");
  assert.equal((await onLaptop.put("team-run-0001", { kind: "task", status: "exploded" })).status, 400);
});

test("an approval asked on the laptop is answered once from the phone", async () => {
  const cookie = await signUp("approve@example.com");
  const onLaptop = client(cookie, laptop);
  const onPhone = client(cookie, phone);
  const asked = await onLaptop.put("approval-0001", { kind: "approval", title: "Send an email", detail: "To: sam@example.com" });
  assert.equal(asked.status, 201);
  assert.equal(asked.body.task.status, "waiting");
  assert.ok(asked.body.task.expiresAt > Date.now());

  const pending = await onPhone.list();
  assert.equal(pending.body.tasks[0].kind, "approval");
  assert.equal(pending.body.tasks[0].detail, "To: sam@example.com");

  const approved = await onPhone.decide("approval-0001", true);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.task.status, "approved");
  assert.equal(approved.body.task.decidedBy, "Pixel");

  // The second answer loses, whichever device sends it.
  const late = await onLaptop.decide("approval-0001", false);
  assert.equal(late.status, 409);
  assert.match(late.body.error, /already approved on Pixel/);
  assert.equal((await onLaptop.get("approval-0001")).body.task.status, "approved");
  // An approval can't be rewritten by PUT.
  assert.equal((await onLaptop.put("approval-0001", { kind: "approval", title: "Something else" })).status, 409);
});

test("the asking device can withdraw a request, and nobody can approve it afterwards", async () => {
  const cookie = await signUp("withdraw@example.com");
  const onLaptop = client(cookie, laptop);
  const onPhone = client(cookie, phone);
  await onLaptop.put("approval-0002", { kind: "approval", title: "Delete a file" });
  const cancelled = await onLaptop.put("approval-0002", { kind: "approval", status: "cancelled" });
  assert.equal(cancelled.body.task.status, "cancelled");
  assert.equal((await onPhone.decide("approval-0002", true)).status, 409);
});

test("another account can't see or answer someone's approvals", async () => {
  const owner = client(await signUp("owner@example.com"), laptop);
  const stranger = client(await signUp("stranger@example.com"), phone);
  await owner.put("approval-0003", { kind: "approval", title: "Make a payment" });
  assert.equal((await stranger.list()).body.tasks.length, 0);
  assert.equal((await stranger.get("approval-0003")).status, 404);
  assert.equal((await stranger.decide("approval-0003", true)).status, 404);
  assert.equal((await owner.get("approval-0003")).body.task.status, "waiting");
});

test("tasks need a signed-in session and valid ids", async () => {
  const anonymous = await fetch(`${baseUrl}/api/account/tasks`);
  assert.equal(anonymous.status, 401);
  const withKeyOnly = await fetch(`${baseUrl}/api/account/tasks`, { headers: { Authorization: `Bearer ${process.env.HANNAH_API_TOKEN}` } });
  assert.equal(withKeyOnly.status, 401);
  const cookie = await signUp("ids@example.com");
  const bad = client(cookie, { id: "x", name: "Bad" });
  assert.equal((await bad.put("approval-0004", { kind: "approval", title: "Hi" })).status, 400);
  assert.equal((await client(cookie, laptop).get("no")).status, 404);
});

test("the calendar sign-in callback is public but refuses unknown or used states", async () => {
  const response = await fetch(`${baseUrl}/api/account/connections/google/callback?state=forged&code=abc`);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /sign-in link expired/);
});
