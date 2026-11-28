"use strict";

/**
 * An SROS 2 keystore for one robot, generated from its profile.
 *
 * The layout and contents are those of `ros2 security create_keystore` and
 * `create_enclave` (sros2, keystore/_keystore.py and _enclave.py):
 *
 *   public/ca.cert.pem, identity_ca.cert.pem, permissions_ca.cert.pem
 *   private/ca.key.pem, …                       (only when asked: the CA key)
 *   enclaves/governance.xml, governance.p7s
 *   enclaves/<enclave>/cert.pem, key.pem, identity_ca.cert.pem,
 *     permissions_ca.cert.pem, governance.p7s, permissions.xml, permissions.p7s
 *
 * sros2 symlinks the shared files into each enclave; a JSON bundle can't carry
 * links, so they are copies with the same bytes. Keys are ECDSA P-256 (DDS
 * Security 9.3.1), certificates X.509 (x509.js), signed documents S/MIME
 * (cms.js), as sros2 makes them.
 *
 * What differs from sros2's default on purpose: sros2 gives a new enclave a
 * wildcard permissions file. Here each enclave is granted only the topics,
 * services and actions its node uses, worked out from the robot's profile,
 * and everything else is denied (<default>DENY</default>). Governance keeps
 * sros2's defaults: unauthenticated participants refused, join access control
 * on, discovery and liveliness encrypted, RTPS signed, data encrypted.
 *
 * This writes files. Whether a DDS implementation on the robot accepts them is
 * checked there: that check is BLOCKED_EXTERNAL_DEPENDENCY here (no ROS 2 or
 * DDS installed on the development machine).
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const x509 = require("./x509");
const { signSmime } = require("./cms");

const DAY = 86_400_000;
const NODE_SERVICES = ["describe_parameters", "get_parameter_types", "get_parameters", "list_parameters", "set_parameters", "set_parameters_atomically", "get_type_description"];
const ENCLAVE = /^(\/[A-Za-z][A-Za-z0-9_]*)+$/;
const TOPIC = /^\/?[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/;

const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fqn = (name) => (String(name).startsWith("/") ? String(name) : `/${name}`);

/** The ROS graph of HANNAH's runtime (robotics/runtime/hannah_robot/hal/ros2.py and ros2_watchdog.py) for this robot. */
function profileFromRobot(robot = {}) {
  const ros = robot.ros || {};
  const topics = { odom: "/odom", scan: "/scan", cmdVel: "/cmd_vel", speedLimit: "/speed_limit", heartbeat: "/hannah/heartbeat", initialPose: "/initialpose", ...(ros.topics || {}) };
  const capabilities = Array.isArray(robot.capabilities) ? robot.capabilities : [];
  const sensors = (robot.sensors || []).map((sensor) => {
    const topic = sensor.topic || String(sensor.description || "").match(/ on (\/[A-Za-z0-9_/]+)/)?.[1] || null;
    return { id: String(sensor.id), type: String(sensor.type || ""), topic };
  }).filter((sensor) => sensor.topic && TOPIC.test(sensor.topic));
  return {
    robotId: String(robot.id || "robot"), name: String(robot.name || robot.id || "robot"), domainId: Number.isInteger(ros.domainId) ? ros.domainId : 0,
    rosDistro: robot.rosDistro || null, topics, navigateAction: ros.navigateAction || "navigate_to_pose",
    navigates: capabilities.some((id) => ["navigate_to", "return_to_dock", "inspect_area"].includes(id)), sensors,
  };
}

/** A node's own topics and parameter services, as sros2's common/node.xml grants them. */
function nodeBasics(node) {
  const name = fqn(node);
  return {
    publish: ["/rosout", "/parameter_events"],
    subscribe: ["/parameter_events", "/clock"],
    servicesServed: NODE_SERVICES.map((service) => `${name}/${service}`),
  };
}

/** Each enclave and exactly what its node may use. */
function enclavesFor(profile) {
  const { topics } = profile;
  const sensorTopics = new Set([topics.odom, topics.scan, ...(topics.battery ? [topics.battery] : []), ...(topics.estop ? [topics.estop] : [])]);
  const bridge = {
    path: "/hannah/robot_bridge", node: "hannah_robot_bridge",
    purpose: "HANNAH's robot runtime: reads odometry, the range sensor, the battery and the emergency stop state, sends goals to the navigation stack, publishes its heartbeat, a speed limit and zero velocity when it stops.",
    publish: [topics.cmdVel, topics.speedLimit, topics.heartbeat, topics.initialPose],
    subscribe: [...sensorTopics, "/tf", "/tf_static"],
    actionClients: profile.navigates ? [profile.navigateAction] : [],
  };
  const watchdog = {
    path: "/hannah/watchdog", node: "hannah_watchdog",
    purpose: "Stops the robot when HANNAH's heartbeat stops: listens to the heartbeat, publishes zero velocity and cancels navigation goals.",
    publish: [topics.cmdVel], subscribe: [topics.heartbeat], actionClients: profile.navigates ? [profile.navigateAction] : [],
  };
  const drivers = profile.sensors.filter((sensor) => !["odometry"].includes(sensor.id)).map((sensor) => ({
    path: `/hannah/drivers/${sensor.id.replace(/[^A-Za-z0-9_]/g, "_")}`, node: `${sensor.id.replace(/[^A-Za-z0-9_]/g, "_")}_driver`,
    purpose: `Driver for the ${sensor.type || "sensor"} “${sensor.id}”: publishes ${sensor.topic} and nothing else.`,
    publish: [sensor.topic], subscribe: [], actionClients: [],
  }));
  return [bridge, watchdog, ...drivers].map((enclave) => {
    const basics = nodeBasics(enclave.node);
    return { ...enclave, publish: [...new Set([...enclave.publish, ...basics.publish])].map(fqn).sort(), subscribe: [...new Set([...enclave.subscribe, ...basics.subscribe])].map(fqn).sort(), servicesServed: basics.servicesServed };
  });
}

/** ROS names as DDS topics (rmw mangling: rt/ topics, rq/…Request and rr/…Reply services, actions under /_action/). */
function ddsTopics(enclave) {
  const publish = new Set();
  const subscribe = new Set();
  for (const topic of enclave.publish) publish.add(`rt${topic}`);
  for (const topic of enclave.subscribe) subscribe.add(`rt${topic}`);
  for (const service of enclave.servicesServed) { subscribe.add(`rq${service}Request`); publish.add(`rr${service}Reply`); }
  for (const action of enclave.actionClients) {
    const name = fqn(action);
    for (const verb of ["cancel_goal", "get_result", "send_goal"]) { publish.add(`rq${name}/_action/${verb}Request`); subscribe.add(`rr${name}/_action/${verb}Reply`); }
    subscribe.add(`rt${name}/_action/feedback`);
    subscribe.add(`rt${name}/_action/status`);
  }
  return { publish: [...publish].sort(), subscribe: [...subscribe].sort() };
}

const isoTime = (at) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "+00:00");

function governanceXml({ domainId = 0 } = {}) {
  const template = fs.readFileSync(path.join(__dirname, "sros2-schemas", "governance.default.xml"), "utf8");
  return template.replace(/<id>0<\/id>/g, `<id>${Number(domainId)}</id>`);
}

function permissionsXml(enclave, { domainId = 0, notBefore, notAfter, discoveryTopic = true }) {
  const { publish, subscribe } = ddsTopics(enclave);
  // rmw_fastrtps_cpp, rmw_cyclonedds_cpp and rmw_connextdds share the graph on ros_discovery_info (sros2 adds it for them).
  if (discoveryTopic) { publish.push("ros_discovery_info"); subscribe.push("ros_discovery_info"); }
  const list = (items) => items.map((topic) => `            <topic>${escape(topic)}</topic>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<dds xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.omg.org/spec/DDS-SECURITY/20170901/omg_shared_ca_permissions.xsd">
  <permissions>
    <grant name="${escape(enclave.path)}">
      <subject_name>CN=${escape(enclave.path)}</subject_name>
      <validity>
        <not_before>${isoTime(notBefore)}</not_before>
        <not_after>${isoTime(notAfter)}</not_after>
      </validity>
      <allow_rule>
        <domains>
          <id>${Number(domainId)}</id>
        </domains>
        <publish>
          <topics>
${list(publish)}
          </topics>
        </publish>
        <subscribe>
          <topics>
${list(subscribe)}
          </topics>
        </subscribe>
      </allow_rule>
      <default>DENY</default>
    </grant>
  </permissions>
</dds>
`;
}

/**
 * Generate the keystore.
 *   profile             from profileFromRobot()
 *   ca                  { certPem, privateKey } to sign with; a new keystore CA when omitted
 *   enclavePublicKeys   { "/hannah/robot_bridge": PEM } keys the robot made itself: then no private key is generated or returned for that enclave
 *   includeCaKey        put private/ca.key.pem in the bundle (sros2 keeps it in the keystore; leave it off for a robot)
 *   days                enclave certificate and permissions validity (default 365)
 * Returns { files: { relativePath: text }, enclaves, caCertPem, caKeyPem?, notes }.
 */
function generateKeystore(profile, { ca = null, enclavePublicKeys = {}, includeCaKey = false, days = 365, now = Date.now(), discoveryTopic = true } = {}) {
  let authority = ca;
  if (!authority) {
    const pair = x509.newKeyPair();
    const made = x509.createCertificate({ subject: { CN: "sros2CA" }, publicKey: pair.publicKey, signingKey: pair.privateKey, notBefore: now - 60_000, notAfter: now + 3650 * DAY, ca: true, pathLength: 1 });
    authority = { certPem: made.pem, privateKey: pair.privateKey };
  }
  const caCert = new crypto.X509Certificate(authority.certPem);
  const issuer = Object.fromEntries(String(caCert.subject).split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const files = {};
  const sign = (text) => signSmime(text, { certificatePem: authority.certPem, privateKey: authority.privateKey, at: now });
  files["public/ca.cert.pem"] = authority.certPem;
  files["public/identity_ca.cert.pem"] = authority.certPem;
  files["public/permissions_ca.cert.pem"] = authority.certPem;
  if (includeCaKey) {
    const keyPem = x509.privatePem(authority.privateKey);
    for (const name of ["ca.key.pem", "identity_ca.key.pem", "permissions_ca.key.pem"]) files[`private/${name}`] = keyPem;
  }
  const governance = governanceXml({ domainId: profile.domainId });
  const governanceSigned = sign(governance);
  files["enclaves/governance.xml"] = governance;
  files["enclaves/governance.p7s"] = governanceSigned;
  const enclaves = enclavesFor(profile);
  for (const enclave of enclaves) {
    if (!ENCLAVE.test(enclave.path)) throw new Error(`Bad enclave name ${enclave.path}`);
    const dir = `enclaves${enclave.path}`;
    let publicKey = enclavePublicKeys[enclave.path] ? crypto.createPublicKey(enclavePublicKeys[enclave.path]) : null;
    if (!publicKey) {
      const pair = x509.newKeyPair();
      publicKey = pair.publicKey;
      files[`${dir}/key.pem`] = x509.privatePem(pair.privateKey);
    }
    const certificate = x509.createCertificate({ subject: { CN: enclave.path }, issuer, publicKey, signingKey: authority.privateKey, issuerPublicKey: caCert.publicKey, notBefore: now - 60_000, notAfter: now + days * DAY });
    files[`${dir}/cert.pem`] = certificate.pem;
    files[`${dir}/identity_ca.cert.pem`] = authority.certPem;
    files[`${dir}/permissions_ca.cert.pem`] = authority.certPem;
    files[`${dir}/governance.p7s`] = governanceSigned;
    const permissions = permissionsXml(enclave, { domainId: profile.domainId, notBefore: new Date(certificate.certificate.validFrom).getTime(), notAfter: new Date(certificate.certificate.validTo).getTime(), discoveryTopic });
    files[`${dir}/permissions.xml`] = permissions;
    files[`${dir}/permissions.p7s`] = sign(permissions);
    enclave.certificate = { serial: certificate.serialHex, notAfter: new Date(certificate.certificate.validTo).getTime(), keyGenerated: !enclavePublicKeys[enclave.path] };
    enclave.dds = ddsTopics(enclave);
  }
  return {
    files, enclaves, caCertPem: authority.certPem,
    environment: { ROS_SECURITY_KEYSTORE: "/etc/hannah/sros2_keystore", ROS_SECURITY_ENABLE: "true", ROS_SECURITY_STRATEGY: "Enforce", ROS_DOMAIN_ID: String(profile.domainId) },
    notes: [
      "Run each node with --ros-args --enclave <path>, e.g. --enclave /hannah/robot_bridge.",
      "Your navigation stack and motor controller nodes need enclaves of their own; they are not generated here because HANNAH doesn't know their graph.",
      "Generated and checked against the DDS Security schemas and with OpenSSL. Whether the robot's DDS implementation accepts it has not been tested here (BLOCKED_EXTERNAL_DEPENDENCY: no ROS 2 or DDS on this machine).",
    ],
  };
}

module.exports = { NODE_SERVICES, ddsTopics, enclavesFor, generateKeystore, governanceXml, permissionsXml, profileFromRobot };
