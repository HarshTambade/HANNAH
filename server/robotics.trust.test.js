"use strict";

// Zero trust on the real server: device identity over HTTP, the robot link's
// secret rotation, credential age and mTLS policy, and the Robot OS bridge's
// replay protection across server instances. A stand-in robot speaks the
// protocol; nothing here is a physical robot.
const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const { after, before } = test;

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "trust-test-token-0123456789-abcdefghijklmnopqr";
process.env.DATABASE_URL = process.env.HANNAH_TEST_DB === "pglite" ? "postgres://pglite.local/hannah" : "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "f".repeat(64);
process.env.HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S = "100000";
process.env.HANNAH_RATE_LIMIT_ROBOT_ENROLL_PER_ADDRESS = "200";
delete process.env.VERCEL;

const { createRobotClient } = require("./test-fixtures/robot-client");
const { createDevice } = require("./test-fixtures/trust-device");
const { createAuthenticator, signEnvelope } = require("./robotics/robot_os_auth");
const { createTrustService } = require("./trust/service");

let server;
let base;
let db;
const users = {};
const call = async (who, method, route, body) => {
  const response = await fetch(`${base}/api${route}`, { method, headers: { ...(who || {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, body: data };
};

before(async () => {
  if (process.env.HANNAH_TEST_DB === "pglite") await require("./db").useDatabase(await require("./db/pglite-adapter").createPgliteAdapter());
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  db = await require("./db").getDatabase();
  for (const name of ["asha", "bo", "cy"]) {
    const response = await fetch(`${base}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${name}@trust.example`, password: "correct horse battery staple" }) });
    assert.equal(response.status, 200, await response.clone().text());
    users[name] = { Cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") };
  }
  const key = await call(users.asha, "POST", "/account/api-keys", { name: "agent" });
  users.ashaKey = { Authorization: `Bearer ${key.body.key}` };
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

async function enrolledRobot(who, name) {
  const created = await call(who, "POST", "/robots", { name, simulated: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const robot = createRobotClient({ base });
  assert.equal((await robot.enroll(created.body.enrollment.code)).status, 201);
  return robot;
}

test("device identity over HTTP: a person registers, the device enrolls with its key, credentials are its own", async () => {
  assert.equal((await call(null, "GET", "/trust/devices")).status, 401);
  const byKey = await call(users.ashaKey, "POST", "/trust/devices", { deviceId: "cam-001", kind: "sensor" });
  assert.equal(byKey.status, 403, "a developer key can't register a device");
  const registered = await call(users.asha, "POST", "/trust/devices", { deviceId: "cam-001", kind: "sensor", hardwareId: "HW-CAM-1" });
  assert.equal(registered.status, 201);
  const device = createDevice("cam-001", { hardwareId: "HW-CAM-1" });
  const enrolled = await call(null, "POST", "/trust/device/enroll", device.enrollment(registered.body.enrollment.code));
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  assert.match(enrolled.body.certificate, /BEGIN CERTIFICATE/);
  const credential = await call(null, "POST", "/trust/device/credential", device.credentialRequest());
  assert.equal(credential.status, 201);
  const me = await call({ Authorization: `Bearer ${credential.body.token}`, "X-Hannah-Device": "cam-001" }, "GET", "/trust/device/whoami");
  assert.equal(me.status, 200);
  assert.equal(me.body.deviceId, "cam-001");
  const other = await call({ Authorization: `Bearer ${credential.body.token}`, "X-Hannah-Device": "cam-002" }, "GET", "/trust/device/whoami");
  assert.equal(other.status, 403);
  assert.equal(other.body.reason, "cross-device");
  // Another account sees nothing of it.
  assert.equal((await call(users.bo, "GET", "/trust/devices")).body.identities.length, 0);
  const listed = await call(users.asha, "GET", "/trust/devices");
  assert.equal(listed.body.identities[0].certificate.state, "valid");
  assert.ok((await call(users.asha, "GET", "/trust/audit")).body.audit.some((item) => item.kind === "credential-use" && item.decision === "refused"));
  const revoked = await call(users.asha, "POST", "/trust/devices/cam-001/revoke", {});
  assert.equal(revoked.body.identity.status, "revoked");
  assert.equal((await call({ Authorization: `Bearer ${credential.body.token}` }, "GET", "/trust/device/whoami")).status, 401);
});

test("the robot link rotates its secret without a window where it is locked out", async () => {
  const robot = await enrolledRobot(users.asha, "Rotor");
  assert.equal((await robot.sync()).status, 200);
  const text = "{}";
  const response = await fetch(`${base}/api/robots/device/rotate`, { method: "POST", headers: { "Content-Type": "application/json", ...robot.sign(text, { path: "/api/robots/device/rotate" }) }, body: text });
  assert.equal(response.status, 200);
  const { secret } = await response.json();
  assert.notEqual(secret, robot.secret);
  // Until the robot signs with the new secret, the old one still works (the answer could have been lost).
  assert.equal((await robot.sync()).status, 200);
  const old = robot.secret;
  robot.secret = secret;
  assert.equal((await robot.sync()).status, 200, "the new secret takes over");
  robot.secret = old;
  const refused = await robot.sync();
  assert.equal(refused.status, 401, "the old secret stops working once the new one is used");
  robot.secret = secret;
  const events = await call(users.asha, "GET", `/robots/events?robot=${robot.robotId}`);
  assert.ok(events.body.events.some((event) => event.type === "secret-rotated"));
});

test("an account's secret age limit expires a robot's secret; its mTLS rule refuses a plain connection", async () => {
  assert.equal((await call(users.bo, "PUT", "/trust/policy", { robotSecretMaxAgeDays: 1 })).status, 200);
  const robot = await enrolledRobot(users.bo, "Aged");
  const fresh = await robot.sync();
  assert.equal(fresh.status, 200);
  assert.ok(fresh.body.credentialExpiresAt > Date.now(), "the robot is told when its secret expires");
  await db.query("UPDATE hannah_robots SET enrolled_at = $1 WHERE id = $2", [Date.now() - 2 * 86_400_000, robot.robotId]);
  const expired = await robot.sync();
  assert.equal(expired.status, 401);
  assert.equal(expired.body.reason, "credential-expired");

  assert.equal((await call(users.cy, "PUT", "/trust/policy", { requireMtlsForRobotLink: true })).status, 200);
  const strict = await enrolledRobot(users.cy, "Strict");
  const plain = await strict.sync();
  assert.equal(plain.status, 401);
  assert.equal(plain.body.reason, "mtls-required");
  assert.equal((await call(users.ashaKey, "PUT", "/trust/policy", { unknownDevices: "reject" })).status, 403, "a developer key can't loosen or change the policy");
});

test("Robot OS bridge: a replayed envelope is refused by a second server instance, and the refusal is audited", async () => {
  const trust = createTrustService();
  const refusals = [];
  const make = () => createAuthenticator({ secrets: { "robot-1": "s3cret" }, claim: (scope, id, expiresAt) => trust.claimNonce(db, scope, id, expiresAt), onRefused: (item) => refusals.push(item) });
  const envelope = { envelope_id: `env-${Date.now()}`, robot_id: "robot-1", ts_ms: Date.now(), kind: "heartbeat", payload: { status: "ok" } };
  envelope.signature = signEnvelope("s3cret", envelope);
  assert.equal((await make().verify(envelope)).ok, true);
  const again = await make().verify(envelope);
  assert.equal(again.ok, false);
  assert.equal(again.reason, "replayed");
  assert.equal((await make().verify({ ...envelope, envelope_id: "env-x", robot_id: "robot-9" })).reason, "unknown-robot");
  assert.deepEqual(refusals.map((item) => item.reason), ["replayed", "unknown-robot"]);
});
