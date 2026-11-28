"use strict";

// SROS 2 keystore generated from a robot profile, checked on the generated
// files: governance and permissions against the DDS Security schemas (xmllint,
// sros2's XSD copies), every .p7s with OpenSSL S/MIME verification, every
// enclave certificate against the keystore CA. Running a secured DDS graph is
// BLOCKED_EXTERNAL_DEPENDENCY: no ROS 2 / DDS on this machine.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");
const sros2 = require("./trust/sros2");
const dds = require("./trust/dds-network");

const has = (command, args) => { try { execFileSync(command, args, { stdio: "ignore" }); return true; } catch { return false; } };
const openssl = has("openssl", ["version"]);
const xmllint = has("xmllint", ["--version"]);
const schemas = path.join(__dirname, "trust", "sros2-schemas");

const robot = {
  id: "rb_0123456789abcdef01", name: "Rover", capabilities: ["navigate_to", "return_to_dock", "stop_motion"], rosDistro: "jazzy",
  sensors: [
    { id: "lidar", type: "2d-range", description: "sensor_msgs/LaserScan on /scan" },
    { id: "odometry", type: "wheel-odometry", description: "nav_msgs/Odometry on /odom" },
    { id: "battery", type: "battery", description: "sensor_msgs/BatteryState on /battery_state" },
  ],
  ros: { topics: { battery: "/battery_state", estop: "/estop" }, domainId: 7 },
};

function writeOut(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hannah-sros2-"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test("the profile becomes least-privilege enclaves; only HANNAH's bridge and watchdog may command velocity", () => {
  const enclaves = sros2.enclavesFor(sros2.profileFromRobot(robot));
  assert.deepEqual(enclaves.map((item) => item.path), ["/hannah/robot_bridge", "/hannah/watchdog", "/hannah/drivers/lidar", "/hannah/drivers/battery"]);
  for (const enclave of enclaves) {
    const { publish } = sros2.ddsTopics(enclave);
    if (["/hannah/robot_bridge", "/hannah/watchdog"].includes(enclave.path)) assert.ok(publish.includes("rt/cmd_vel"), enclave.path);
    else assert.equal(publish.includes("rt/cmd_vel"), false, `${enclave.path} must not command velocity`);
  }
  const lidar = sros2.ddsTopics(enclaves[2]);
  assert.ok(lidar.publish.includes("rt/scan"));
  assert.equal(lidar.publish.includes("rt/odom"), false, "a driver publishes its own topic only");
  const bridge = sros2.ddsTopics(enclaves[0]);
  assert.ok(bridge.publish.includes("rq/navigate_to_pose/_action/send_goalRequest"));
  assert.ok(bridge.subscribe.includes("rt/navigate_to_pose/_action/status"));
  assert.ok(bridge.subscribe.includes("rt/estop") && bridge.subscribe.includes("rt/battery_state"));
  assert.ok(bridge.subscribe.includes("rq/hannah_robot_bridge/get_parametersRequest") && bridge.publish.includes("rr/hannah_robot_bridge/get_parametersReply"));
  // A robot that can't navigate gets no navigation action.
  const still = sros2.enclavesFor(sros2.profileFromRobot({ ...robot, capabilities: ["report_robot_state"] }));
  assert.equal(sros2.ddsTopics(still[0]).publish.some((topic) => topic.includes("_action")), false);
});

test("generated governance and permissions validate against the DDS Security schemas", { skip: !xmllint && "BLOCKED_EXTERNAL_DEPENDENCY: xmllint not installed" }, () => {
  const keystore = sros2.generateKeystore(sros2.profileFromRobot(robot));
  const dir = writeOut(keystore.files);
  try {
    const check = (file, schema) => {
      const result = spawnSync("xmllint", ["--noout", "--schema", path.join(schemas, schema), path.join(dir, file)], { encoding: "utf8" });
      assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    };
    check("enclaves/governance.xml", "governance.xsd");
    for (const enclave of keystore.enclaves) check(`enclaves${enclave.path}/permissions.xml`, "permissions.xsd");
    assert.match(keystore.files["enclaves/governance.xml"], /<id>7<\/id>/, "the robot's domain id");
    assert.match(keystore.files["enclaves/governance.xml"], /<allow_unauthenticated_participants>false</);
    assert.match(keystore.files["enclaves/hannah/watchdog/permissions.xml"], /<default>DENY<\/default>/);
    // A document that breaks the schema is caught by the same check.
    fs.writeFileSync(path.join(dir, "bad.xml"), keystore.files["enclaves/hannah/watchdog/permissions.xml"].replace("<default>DENY</default>", "<default>MAYBE</default>"));
    assert.notEqual(spawnSync("xmllint", ["--noout", "--schema", path.join(schemas, "permissions.xsd"), path.join(dir, "bad.xml")]).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("every .p7s verifies with OpenSSL against the permissions CA, and a changed document doesn't", { skip: !openssl && "BLOCKED_EXTERNAL_DEPENDENCY: openssl CLI not installed" }, () => {
  const keystore = sros2.generateKeystore(sros2.profileFromRobot(robot));
  const dir = writeOut(keystore.files);
  try {
    const verify = (file, ca = "public/permissions_ca.cert.pem") => spawnSync("openssl", ["smime", "-verify", "-text", "-in", path.join(dir, file), "-CAfile", path.join(dir, ca), "-out", path.join(dir, "out.txt")], { encoding: "utf8" });
    const signed = Object.keys(keystore.files).filter((name) => name.endsWith(".p7s"));
    assert.ok(signed.length >= 1 + keystore.enclaves.length * 2);
    for (const file of signed) {
      const result = verify(file);
      assert.equal(result.status, 0, `${file}: ${result.stderr}`);
      const original = file.endsWith("governance.p7s") ? keystore.files["enclaves/governance.xml"] : keystore.files[file.replace(/permissions\.p7s$/, "permissions.xml")];
      assert.equal(fs.readFileSync(path.join(dir, "out.txt"), "utf8").replace(/\r\n/g, "\n"), original, `${file} carries the document exactly`);
    }
    const tampered = keystore.files["enclaves/hannah/drivers/lidar/permissions.p7s"].replace("<topic>rt/scan</topic>", "<topic>rt/cmd_vel</topic>");
    fs.writeFileSync(path.join(dir, "tampered.p7s"), tampered);
    assert.notEqual(verify("tampered.p7s").status, 0, "a driver can't grant itself cmd_vel by editing its signed permissions");
    // Signed by another CA: refused.
    const other = sros2.generateKeystore(sros2.profileFromRobot(robot));
    fs.writeFileSync(path.join(dir, "other.pem"), other.caCertPem);
    assert.notEqual(verify("enclaves/governance.p7s", "other.pem").status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("enclave certificates chain to the identity CA and their subject is the grant's subject", { skip: !openssl && "BLOCKED_EXTERNAL_DEPENDENCY: openssl CLI not installed" }, () => {
  const keystore = sros2.generateKeystore(sros2.profileFromRobot(robot), { days: 30 });
  const dir = writeOut(keystore.files);
  try {
    for (const enclave of keystore.enclaves) {
      const certFile = path.join(dir, `enclaves${enclave.path}/cert.pem`);
      const result = spawnSync("openssl", ["verify", "-CAfile", path.join(dir, "public/identity_ca.cert.pem"), certFile], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const certificate = new crypto.X509Certificate(keystore.files[`enclaves${enclave.path}/cert.pem`]);
      assert.equal(certificate.subject, `CN=${enclave.path}`);
      const permissions = keystore.files[`enclaves${enclave.path}/permissions.xml`];
      assert.ok(permissions.includes(`<subject_name>CN=${enclave.path}</subject_name>`));
      assert.ok(permissions.includes(`<not_after>${new Date(certificate.validTo).toISOString().replace(/\.\d{3}Z$/, "+00:00")}</not_after>`), "permissions expire with the certificate");
      const key = crypto.createPrivateKey(keystore.files[`enclaves${enclave.path}/key.pem`]);
      assert.equal(key.asymmetricKeyDetails.namedCurve, "prime256v1", "DDS Security 9.3.1: P-256");
      assert.ok(crypto.createPublicKey(key).equals(certificate.publicKey));
    }
    assert.equal(Object.keys(keystore.files).some((name) => name.startsWith("private/")), false, "the CA key isn't handed out unless asked for");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a robot can keep its own enclave keys: then only certificates come back", () => {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keystore = sros2.generateKeystore(sros2.profileFromRobot(robot), { enclavePublicKeys: { "/hannah/robot_bridge": pair.publicKey.export({ type: "spki", format: "pem" }) } });
  assert.equal(keystore.files["enclaves/hannah/robot_bridge/key.pem"], undefined);
  assert.ok(new crypto.X509Certificate(keystore.files["enclaves/hannah/robot_bridge/cert.pem"]).publicKey.equals(pair.publicKey));
  assert.ok(keystore.files["enclaves/hannah/watchdog/key.pem"]);
});

test("DDS network policy: ports per domain, a firewall that keeps DDS local, and exposure findings", () => {
  const ports = dds.ddsPorts(0);
  assert.equal(ports.discoveryMulticast, 7400);
  assert.equal(ports.userMulticast, 7401);
  assert.equal(ports.discoveryUnicast.from, 7410);
  assert.equal(ports.userUnicast.from, 7411);
  assert.equal(dds.ddsPorts(7).discoveryMulticast, 9150);
  const rules = dds.nftablesPolicy({ domainId: 7, lanSubnets: ["192.168.10.0/24", "203.0.113.0/24"] });
  assert.match(rules, /udp dport 9150-\d+ iif "lo" accept/);
  assert.match(rules, /ip saddr \{ 192\.168\.10\.0\/24 \} accept/);
  assert.equal(rules.includes("203.0.113.0/24"), false, "a public subnet is never allowed DDS");
  assert.match(rules, /counter drop/);
  assert.deepEqual(dds.rosEnvironment({ rosDistro: "jazzy" }), { ROS_AUTOMATIC_DISCOVERY_RANGE: "SUBNET" });
  assert.equal(dds.rosEnvironment({ rosDistro: "humble", scope: "localhost" }).ROS_LOCALHOST_ONLY, "1");
  const exposed = dds.checkExposure({ domainId: 0, listeners: [{ protocol: "udp", address: "0.0.0.0", port: 7400 }, { protocol: "udp", address: "198.51.100.4", port: 7411 }, { protocol: "tcp", address: "0.0.0.0", port: 443 }], interfaces: [{ address: "198.51.100.4" }, { address: "10.0.0.2" }] });
  assert.equal(exposed.exposed, true);
  assert.equal(exposed.findings.length, 2);
  const local = dds.checkExposure({ domainId: 0, listeners: [{ protocol: "udp", address: "0.0.0.0", port: 7400 }], interfaces: [{ address: "10.0.0.2" }, { address: "127.0.0.1" }] });
  assert.equal(local.exposed, false);
});
