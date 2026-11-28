"use strict";

// Hardware marketplace packages on the real server: signature, publisher,
// integrity, dependency, permission, compatibility and security checks;
// install and rollback through the Action Engine (always approved by a
// person); revocation; and runtime least privilege. Also the interop routes.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const test = require("node:test");
const { after, before } = test;

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "packages-test-token-0123456789-abcdefghijklmn";
process.env.DATABASE_URL = process.env.HANNAH_TEST_DB === "pglite" ? "postgres://pglite.local/hannah" : "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "a".repeat(64);
process.env.HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S = "100000";
process.env.HANNAH_RATE_LIMIT_ROBOT_ENROLL_PER_ADDRESS = "200";
delete process.env.VERCEL;

const hw = require("./marketplace/hardware-packages");
const { keyIdOf, sha256 } = require("./robotics/packages");
const { createRobotClient } = require("./test-fixtures/robot-client");

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
const publisher = crypto.generateKeyPairSync("ed25519");
const publicPem = publisher.publicKey.export({ type: "spki", format: "pem" });

function build({ id = "org.example.lidar-driver", version = "1.0.0", files = { "driver.py": "import serial\nport = serial.Serial('/dev/ttyUSB0')\n" }, overrides = {}, key = publisher.privateKey } = {}) {
  const buffers = Object.fromEntries(Object.entries(files).map(([path, text]) => [path, Buffer.from(text)]));
  const manifest = {
    formatVersion: 2, id, name: "Example lidar driver", author: "Example Robotics", publisher: { name: "Example Robotics", keyId: "" }, version, kind: "driver",
    description: "Reads a serial lidar and publishes scans.",
    compatibility: { robotTypes: ["differential-drive"], hardware: ["2d-lidar"], operatingSystems: [], rosDistributions: [] },
    dependencies: [], permissions: ["read-sensors", "hardware-access"], hardwareInterfaces: [{ type: "serial", match: "/dev/ttyUSB*" }],
    safetyConstraints: ["Read-only: never writes to the lidar's motor"], documentation: "https://example.org/docs",
    testResults: [{ level: "simulation", target: "HANNAH stand-in differential-drive robot", environment: "HANNAH server integration test", passed: 12, total: 12 }],
    changelog: [{ version, date: "2026-11-01", changes: ["First release"] }],
    integrity: { files: Object.entries(buffers).map(([path, bytes]) => ({ path, sha256: sha256(bytes), size: bytes.length })) },
    ...overrides,
  };
  return { manifest: hw.signManifest(manifest, key), files: Object.fromEntries(Object.entries(buffers).map(([path, bytes]) => [path, bytes.toString("base64")])) };
}

before(async () => {
  if (process.env.HANNAH_TEST_DB === "pglite") await require("./db").useDatabase(await require("./db/pglite-adapter").createPgliteAdapter());
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  db = await require("./db").getDatabase();
  for (const name of ["asha", "bo"]) {
    const response = await fetch(`${base}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${name}@packages.example`, password: "correct horse battery staple" }) });
    assert.equal(response.status, 200);
    users[name] = { Cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") };
    users[`${name}Id`] = (await db.query("SELECT id FROM hannah_users WHERE email = $1", [`${name}@packages.example`])).rows[0].id;
  }
  assert.equal((await call(users.asha, "POST", "/devices/publishers", { keyId: keyIdOf(publisher.publicKey), owner: "Example Robotics", publicKey: publicPem })).status, 201);
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

test("unit: version ranges, interface patterns, and factual marketplace status (never a certification)", () => {
  assert.equal(hw.satisfies("1.4.2", "^1.2.0"), true);
  assert.equal(hw.satisfies("2.0.0", "^1.2.0"), false);
  assert.equal(hw.satisfies("1.2.9", "~1.2.0"), true);
  assert.equal(hw.satisfies("1.3.0", "~1.2.0"), false);
  assert.equal(hw.satisfies("1.2.0", "1.2.0"), true);
  assert.equal(hw.interfaceMatches("/dev/ttyUSB*", "/dev/ttyUSB3"), true);
  assert.equal(hw.interfaceMatches("/dev/ttyUSB*", "/dev/ttyACM0"), false);
  assert.equal(hw.interfaceMatches("can0", "can1"), false);
  const tested = hw.marketplaceStatus(build().manifest);
  assert.equal(tested.label, "Compatibility tested");
  assert.match(tested.detail, /simulation on HANNAH stand-in differential-drive robot in HANNAH server integration test: 12\/12 passed, reported by the developer/);
  assert.equal(hw.marketplaceStatus({ testResults: [] }).label, "Developer-published");
  assert.doesNotMatch(JSON.stringify([tested, hw.marketplaceStatus({ testResults: [] })]), /\bcertified\b|badge/i);
});

test("verification refuses tampering, untrusted or mismatched publishers, undeclared hardware, missing dependencies and raw actuator code", async () => {
  const good = build();
  const tampered = { ...good, files: { "driver.py": Buffer.from("import os\n").toString("base64") } };
  assert.ok((await call(users.asha, "POST", "/hardware-packages", tampered)).body.problems.some((item) => /Changed since it was signed/.test(item)));
  const stranger = crypto.generateKeyPairSync("ed25519");
  assert.ok((await call(users.asha, "POST", "/hardware-packages", build({ key: stranger.privateKey }))).body.problems.some((item) => /key you don't trust/.test(item)));
  const wrongName = build({ overrides: { publisher: { name: "Somebody Else", keyId: "" } } });
  assert.ok((await call(users.asha, "POST", "/hardware-packages", wrongName)).body.problems.some((item) => /names “Somebody Else” as publisher/.test(item)));
  const sneaky = build({ files: { "driver.py": "open('/dev/mem')\n" } });
  assert.ok((await call(users.asha, "POST", "/hardware-packages", sneaky)).body.problems.some((item) => /\/dev\/mem, which it doesn't declare/.test(item)));
  const raw = build({ files: { "driver.py": "set_torque(5)\n" } });
  assert.ok((await call(users.asha, "POST", "/hardware-packages", raw)).body.problems.some((item) => /raw actuator values/.test(item)));
  const needsDep = build({ id: "org.example.mapper", overrides: { dependencies: [{ id: "org.example.lidar-driver", version: "^2.0.0" }] } });
  assert.ok((await call(users.asha, "POST", "/hardware-packages", needsDep)).body.problems.some((item) => /Needs org\.example\.lidar-driver \^2\.0\.0/.test(item)));
  const undeclared = build({ overrides: { permissions: ["read-sensors"] } });
  assert.ok((await call(users.asha, "POST", "/hardware-packages", undeclared)).body.problems.some((item) => /not the hardware-access permission/.test(item)));
  assert.equal((await call(users.asha, "POST", "/hardware-packages", good)).status, 201);
  // Only the account that trusts the publisher can store it.
  assert.equal((await call(users.bo, "POST", "/hardware-packages", good)).status, 422);
  const listed = await call(users.asha, "GET", "/hardware-packages");
  assert.equal(listed.body.packages.length, 1);
  for (const field of ["id", "author", "version", "compatibility", "dependencies", "permissions", "safetyConstraints", "integrity", "documentation", "testResults", "changelog"]) assert.ok(field in listed.body.packages[0], field);
  const audit = await call(users.asha, "GET", "/trust/audit");
  assert.ok(audit.body.audit.some((item) => item.kind === "package-verify" && item.decision === "refused"));
});

test("install asks a person, grants only what is declared, rolls back after re-checking, and revocation disables it", async () => {
  const created = await call(users.asha, "POST", "/robots", { name: "Bench", simulated: true });
  const robot = createRobotClient({ base });
  assert.equal((await robot.enroll(created.body.enrollment.code)).status, 201);
  const target = robot.robotId;
  assert.equal((await call(users.asha, "POST", "/hardware-packages", build({ version: "1.1.0", overrides: { changelog: [{ version: "1.1.0", date: "2026-11-20", changes: ["Faster"] }] } }))).status, 201);
  const asked = await call(users.asha, "POST", "/hardware-packages/install", { packageId: "org.example.lidar-driver", version: "1.0.0", target });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  assert.equal(asked.body.record.status, "waiting-approval", "installing code on a robot always asks");
  const approved = await call(users.asha, "POST", `/actions/${asked.body.record.id}/decision`, { approve: true });
  assert.equal(approved.body.record?.status || approved.body.status, "done", JSON.stringify(approved.body));
  const upgrade = await call(users.asha, "POST", "/hardware-packages/install", { packageId: "org.example.lidar-driver", version: "1.1.0", target });
  await call(users.asha, "POST", `/actions/${upgrade.body.record.id}/decision`, { approve: true });
  let installs = (await call(users.asha, "GET", "/hardware-packages")).body.installs;
  assert.equal(installs[0].version, "1.1.0");
  assert.equal(installs[0].previousVersion, "1.0.0");
  assert.deepEqual(installs[0].permissions, ["read-sensors", "hardware-access"]);

  // Least privilege at run time, through the service the server uses.
  const { createHardwarePackageService } = hw;
  const service = createHardwarePackageService({});
  assert.equal((await service.authorize(db, users.ashaId, { packageId: "org.example.lidar-driver", target, hardware: { type: "serial", path: "/dev/ttyUSB0" } })).allowed, true);
  const denied = await service.authorize(db, users.ashaId, { packageId: "org.example.lidar-driver", target, hardware: { type: "can", path: "can0" } });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /isn't among the interfaces it declared/);
  assert.equal((await service.authorize(db, users.ashaId, { packageId: "org.example.lidar-driver", target, permission: "network-internet" })).allowed, false);
  assert.equal((await service.authorize(db, users.ashaId, { packageId: "org.example.lidar-driver", target: "rb_000000000000000000", permission: "read-sensors" })).allowed, false, "another robot has nothing installed");

  // A developer key can ask, but the approval is still a person's.
  const rollback = await call(users.asha, "POST", "/hardware-packages/rollback", { packageId: "org.example.lidar-driver", target });
  assert.equal(rollback.body.record.status, "waiting-approval");
  await call(users.asha, "POST", `/actions/${rollback.body.record.id}/decision`, { approve: true });
  installs = (await call(users.asha, "GET", "/hardware-packages")).body.installs;
  assert.equal(installs[0].version, "1.0.0");
  assert.equal(installs[0].history.at(-1).by, "rollback");

  const revoked = await call(users.asha, "POST", "/hardware-packages/revoke", { packageId: "org.example.lidar-driver", version: "1.0.0", reason: "Publisher reported a firmware bug" });
  assert.equal(revoked.body.disabledInstalls, 1);
  assert.equal((await service.authorize(db, users.ashaId, { packageId: "org.example.lidar-driver", target, permission: "read-sensors" })).allowed, false, "a revoked install gets nothing");
  const again = await call(users.asha, "POST", "/hardware-packages/install", { packageId: "org.example.lidar-driver", version: "1.0.0", target });
  assert.equal(again.body.record.status, "denied", "a revoked version is refused before anyone is asked");
  assert.match(again.body.record.outcome, /revoked/);
});

test("interop routes: the fleet, capability negotiation and an explained refusal, per account", async () => {
  assert.equal((await call(null, "GET", "/interop")).status, 401);
  const fleet = await call(users.asha, "GET", "/interop");
  assert.equal(fleet.status, 200);
  assert.deepEqual(fleet.body.adapters.map((item) => item.id), ["hannah-link", "vda5050"]);
  const bench = fleet.body.robots.find((item) => item.name === "Bench");
  assert.equal(bench.adapter, "hannah-link");
  const refused = await call(users.asha, "POST", `/interop/robots/${bench.id}/assess`, { mission: "deliver", params: { from: { x: 0, y: 0 }, to: { x: 1, y: 1 } } });
  assert.equal(refused.body.verdict.ok, false);
  assert.match(refused.body.verdict.violations[0].message, /no load-handling capability/);
  const viaAction = await call(users.asha, "POST", `/interop/robots/${bench.id}/missions`, { mission: "deliver", params: { from: { x: 0, y: 0 }, to: { x: 1, y: 1 } } });
  assert.equal(viaAction.body.record.status, "denied", "refused before approval, with the reason");
  const registered = await call(users.asha, "POST", "/interop/vda5050", { name: "Cart 1", simulated: true, manufacturer: "Acme", serialNumber: "C-1", broker: { host: "127.0.0.1", port: 1 } });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.robot.state.connection, "never-connected");
  assert.equal((await call(users.bo, "GET", "/interop")).body.robots.length, 0);
  const matrix = await call(users.asha, "GET", "/interop/capabilities");
  assert.equal(matrix.body.robots.length, 2);
});
