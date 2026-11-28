"use strict";

// Zero-trust device identity: certificates from the account's CA (checked by
// OpenSSL), enrollment with proof of possession, short-lived credentials,
// rotation, revocation, quarantine of unregistered devices, replay protection
// and mutual TLS. Unit and integration tests; no physical device is involved.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const express = require("express");
const { testDatabase } = require("./test-fixtures/trust-db");
const { createDevice } = require("./test-fixtures/trust-device");
const { createTrustService } = require("./trust/service");
const { createMtlsServer, requireClientCertificate } = require("./trust/mtls");
const x509 = require("./trust/x509");

const opensslAvailable = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();

async function setup() {
  let clock = Date.now();
  const db = await testDatabase();
  const trust = createTrustService({ now: () => clock });
  return { db, trust, advance: (ms) => { clock += ms; }, now: () => clock };
}

test("the account CA and a device certificate verify with OpenSSL, strict mode", { skip: !opensslAvailable && "BLOCKED_EXTERNAL_DEPENDENCY: openssl CLI not installed" }, async () => {
  const { db, trust } = await setup();
  const device = createDevice("rb_strict01", { hardwareId: "SN-0042" });
  const { enrollment } = await trust.registerDevice(db, "u_asha", { deviceId: "rb_strict01", kind: "robot", hardwareId: "SN-0042" });
  const enrolled = await trust.enroll(db, device.enrollment(enrollment.code));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hannah-ca-"));
  fs.writeFileSync(path.join(dir, "ca.pem"), enrolled.caCertificate);
  fs.writeFileSync(path.join(dir, "device.pem"), enrolled.certificate);
  const out = execFileSync("openssl", ["verify", "-x509_strict", "-purpose", "sslclient", "-CAfile", path.join(dir, "ca.pem"), path.join(dir, "device.pem")]).toString();
  assert.match(out, /OK/);
  const text = execFileSync("openssl", ["x509", "-in", path.join(dir, "device.pem"), "-noout", "-text"]).toString();
  assert.match(text, /URI:urn:hannah:device:rb_strict01/);
  assert.match(text, /serialNumber\s*=\s*SN-0042/);
  assert.match(text, /prime256v1|P-256/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("enrollment needs the one-time code, proof of the key and the registered hardware", async () => {
  const { db, trust } = await setup();
  const device = createDevice("rb_enroll01", { hardwareId: "SN-1" });
  const { enrollment } = await trust.registerDevice(db, "u_asha", { deviceId: "rb_enroll01", kind: "robot", hardwareId: "SN-1" });
  await assert.rejects(trust.enroll(db, device.enrollment("AAAAA-BBBBB")), { reason: "bad-code" });
  const forged = { ...device.enrollment(enrollment.code), publicKey: createDevice("other").publicPem() };
  await assert.rejects(trust.enroll(db, forged), { reason: "bad-signature" }, "a key the device can't sign with is refused");
  const impostor = createDevice("rb_enroll01", { hardwareId: "SN-999" });
  await assert.rejects(trust.enroll(db, impostor.enrollment(enrollment.code)), { reason: "hardware-mismatch" });
  const done = await trust.enroll(db, device.enrollment(enrollment.code));
  assert.equal(done.deviceId, "rb_enroll01");
  await assert.rejects(trust.enroll(db, device.enrollment(enrollment.code)), { reason: "bad-code" }, "a code works once");
  const audit = await trust.listAudit(db, "u_asha");
  assert.ok(audit.filter((item) => item.decision === "refused").length >= 3, "refusals are audited");
  // A device id belongs to one account.
  await assert.rejects(trust.registerDevice(db, "u_bo", { deviceId: "rb_enroll01", kind: "robot" }), { reason: "taken" });
});

test("short-lived credentials: expire, can't be replayed, can't act for another device, end on revocation", async () => {
  const { db, trust, advance } = await setup();
  const a = createDevice("dev_a001");
  const b = createDevice("dev_b001");
  for (const device of [a, b]) {
    const { enrollment } = await trust.registerDevice(db, "u_asha", { deviceId: device.deviceId, kind: "sensor" });
    await trust.enroll(db, device.enrollment(enrollment.code));
  }
  const request = a.credentialRequest();
  const credential = await trust.issueCredential(db, request);
  await assert.rejects(trust.issueCredential(db, request), { reason: "replayed" }, "the same signed request is refused the second time");
  await assert.rejects(trust.issueCredential(db, { ...a.credentialRequest(), deviceId: "dev_b001" }), { reason: "bad-signature" }, "a's key can't ask for b");
  await assert.rejects(trust.issueCredential(db, a.credentialRequest({ time: Date.now() - 5 * 60_000 })), { reason: "clock-skew" });
  const ok = await trust.authenticate(db, credential.token, { deviceId: "dev_a001" });
  assert.equal(ok.deviceId, "dev_a001");
  await assert.rejects(trust.authenticate(db, credential.token, { deviceId: "dev_b001" }), { reason: "cross-device" });
  await assert.rejects(trust.authenticate(db, credential.token, { scope: "admin" }), { reason: "wrong-scope" });
  advance(16 * 60_000);
  await assert.rejects(trust.authenticate(db, credential.token), { reason: "expired" }, "an expired credential is rejected");
  const fresh = await trust.issueCredential(db, a.credentialRequest({ time: Date.now() + 16 * 60_000 }));
  await trust.revoke(db, "u_asha", "dev_a001", "Lost in transit.");
  await assert.rejects(trust.authenticate(db, fresh.token), { reason: "revoked" });
  await assert.rejects(trust.issueCredential(db, a.credentialRequest({ time: Date.now() + 16 * 60_000 })), { reason: "revoked" });
  const revoked = await trust.revocations(db, "u_asha");
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].reason, "Lost in transit.");
});

test("an expired certificate is refused, and rotation replaces the key and supersedes the old certificate", async () => {
  const { db, trust, advance, now } = await setup();
  await trust.setPolicy(db, "u_asha", { certificateDays: 1 });
  const device = createDevice("dev_rot001");
  const { enrollment } = await trust.registerDevice(db, "u_asha", { deviceId: "dev_rot001", kind: "controller" });
  const first = await trust.enroll(db, device.enrollment(enrollment.code));
  const rotation = device.rotation({ time: now() });
  const rotated = await trust.rotate(db, rotation.request);
  assert.notEqual(rotated.serial, first.serial);
  await assert.rejects(trust.rotate(db, rotation.request), { reason: "bad-signature" }, "the old key no longer speaks for the device");
  rotation.commit();
  assert.ok((await trust.revocations(db, "u_asha")).some((item) => item.serial === first.serial && item.reason === "superseded"));
  await assert.rejects(trust.verifyClientCertificate(db, first.certificate), { reason: "revoked" }, "the superseded certificate is refused");
  assert.equal((await trust.verifyClientCertificate(db, rotated.certificate)).deviceId, "dev_rot001");
  advance(2 * 86_400_000);
  await assert.rejects(trust.issueCredential(db, device.credentialRequest({ time: now() })), { reason: "certificate-expired" });
  await assert.rejects(trust.verifyClientCertificate(db, rotated.certificate), { reason: "certificate-expired" });
});

test("unregistered devices are quarantined or rejected by the account's policy, never given anything", async () => {
  const { db, trust } = await setup();
  const seen = await trust.observeUnregistered(db, "u_asha", { deviceId: "agv_ghost", kind: "agv", source: "VDA 5050 broker" });
  assert.equal(seen.decision, "quarantined");
  assert.equal(seen.identity.status, "quarantined");
  const intruder = createDevice("agv_ghost");
  await assert.rejects(trust.issueCredential(db, intruder.credentialRequest()), { reason: "quarantined" });
  await trust.setPolicy(db, "u_asha", { unknownDevices: "reject" });
  const rejected = await trust.observeUnregistered(db, "u_asha", { deviceId: "agv_other", kind: "agv", source: "VDA 5050 broker" });
  assert.equal(rejected.decision, "rejected");
  assert.equal((await trust.listIdentities(db, "u_asha")).some((item) => item.deviceId === "agv_other"), false);
  const audit = await trust.listAudit(db, "u_asha");
  assert.ok(audit.some((item) => item.kind === "unregistered-device" && item.decision === "rejected"));
  assert.ok(audit.some((item) => item.kind === "unregistered-device" && item.decision === "quarantined"));
  // A person can register the quarantined device properly afterwards.
  const { enrollment } = await trust.registerDevice(db, "u_asha", { deviceId: "agv_ghost", kind: "agv" });
  assert.match(enrollment.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
});

test("the durable nonce store refuses a nonce the second time, across service instances", async () => {
  const { db } = await setup();
  const one = createTrustService();
  const two = createTrustService();
  assert.equal(await one.claimNonce(db, "bridge:r1", "n-1", Date.now() + 60_000), true);
  assert.equal(await two.claimNonce(db, "bridge:r1", "n-1", Date.now() + 60_000), false);
  assert.equal(await two.claimNonce(db, "bridge:r2", "n-1", Date.now() + 60_000), true, "scopes are separate");
});

test("mutual TLS: a certificate from the account CA is accepted; none, a foreign or a revoked one is not", async () => {
  const { db, trust } = await setup();
  const device = createDevice("rb_mtls001");
  const { enrollment } = await trust.registerDevice(db, "u_asha", { deviceId: "rb_mtls001", kind: "robot" });
  const enrolled = await trust.enroll(db, device.enrollment(enrollment.code));
  // The server's own TLS certificate, from a throwaway CA.
  const serverCa = x509.newKeyPair();
  const serverKey = x509.newKeyPair();
  const at = Date.now();
  const serverCaCert = x509.createCertificate({ subject: { CN: "test server CA" }, publicKey: serverCa.publicKey, signingKey: serverCa.privateKey, notBefore: at - 60_000, notAfter: at + 86_400_000, ca: true, keyUsage: ["keyCertSign", "digitalSignature"] });
  const serverCert = x509.createCertificate({ subject: { CN: "localhost" }, issuer: { CN: "test server CA" }, publicKey: serverKey.publicKey, signingKey: serverCa.privateKey, notBefore: at - 60_000, notAfter: at + 86_400_000, keyUsage: ["digitalSignature"], extKeyUsage: ["serverAuth"], dnsNames: ["localhost"] });
  const app = express();
  app.get("/link", requireClientCertificate({ trust, database: async () => db, matchHeader: "x-hannah-robot" }), (_req, res) => res.json({ device: res.locals.device.deviceId }));
  const server = createMtlsServer(app, { key: x509.privatePem(serverKey.privateKey), cert: serverCert.pem });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const call = (options = {}) => new Promise((resolve, reject) => {
    const request = https.request({ host: "127.0.0.1", servername: "localhost", port: server.address().port, path: "/link", ca: serverCaCert.pem, ...options }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on("error", reject);
    request.end();
  });
  try {
    const good = await call({ key: x509.privatePem(device.privateKey), cert: enrolled.certificate });
    assert.equal(good.status, 200);
    assert.equal(good.body.device, "rb_mtls001");
    const none = await call();
    assert.equal(none.status, 401);
    assert.equal(none.body.reason, "no-certificate");
    const claimed = await call({ key: x509.privatePem(device.privateKey), cert: enrolled.certificate, headers: { "x-hannah-robot": "rb_other00" } });
    assert.equal(claimed.status, 403);
    assert.equal(claimed.body.reason, "cross-device");
    // A certificate for the same device id made by someone else's CA.
    const rogue = x509.newKeyPair();
    const rogueCert = x509.createCertificate({ subject: { CN: "rb_mtls001" }, issuer: { CN: "HANNAH device CA", O: "HANNAH" }, publicKey: device.privateKey, signingKey: rogue.privateKey, notBefore: at - 60_000, notAfter: at + 86_400_000, uris: ["urn:hannah:device:rb_mtls001"], extKeyUsage: ["clientAuth"] });
    const foreign = await call({ key: x509.privatePem(device.privateKey), cert: rogueCert.pem });
    assert.equal(foreign.status, 401);
    assert.ok(["wrong-issuer", "revoked"].includes(foreign.body.reason));
    await trust.revoke(db, "u_asha", "rb_mtls001");
    const after = await call({ key: x509.privatePem(device.privateKey), cert: enrolled.certificate });
    assert.equal(after.status, 401);
    assert.equal(after.body.reason, "revoked");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a certificate's signature is real: changing one byte of it fails OpenSSL's parse or Node's verify", async () => {
  const pair = x509.newKeyPair();
  const at = Date.now();
  const made = x509.createCertificate({ subject: { CN: "tamper" }, publicKey: pair.publicKey, signingKey: pair.privateKey, notBefore: at, notAfter: at + 1000, ca: true });
  assert.equal(made.certificate.verify(made.certificate.publicKey), true);
  const der = Buffer.from(made.der);
  der[der.length - 5] ^= 0x01;
  let verified = false;
  try { verified = new crypto.X509Certificate(der).verify(made.certificate.publicKey); } catch { verified = false; }
  assert.equal(verified, false);
});
