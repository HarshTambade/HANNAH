"use strict";

/**
 * DDS must never be reachable from the internet. This works out which UDP
 * ports a ROS 2 domain uses, writes an nftables policy that lets them through
 * only on loopback and the robot's own private network, and checks what a
 * robot reports listening on.
 *
 * Ports are the RTPS defaults (DDSI-RTPS 2.5, 9.6.1.1): PB 7400, DG 250,
 * PG 2, d0 0, d1 10, d2 1, d3 11. A DDS vendor configured with other values
 * uses other ports; the profile can say so.
 */
const net = require("node:net");

const RTPS = { PB: 7400, DG: 250, PG: 2, d0: 0, d1: 10, d2: 1, d3: 11 };

function ddsPorts(domainId = 0, { maxParticipants = 120, rtps = RTPS } = {}) {
  const domain = Number(domainId);
  if (!Number.isInteger(domain) || domain < 0 || domain > 232) throw new Error("A ROS domain id is 0 to 232.");
  const base = rtps.PB + rtps.DG * domain;
  return {
    discoveryMulticast: base + rtps.d0,
    userMulticast: base + rtps.d2,
    discoveryUnicast: { from: base + rtps.d1, to: base + rtps.d1 + rtps.PG * (maxParticipants - 1) },
    userUnicast: { from: base + rtps.d3, to: base + rtps.d3 + rtps.PG * (maxParticipants - 1) },
    range: { from: base, to: base + rtps.d3 + rtps.PG * (maxParticipants - 1) },
  };
}

/** True for loopback, RFC 1918, link-local and IPv6 unique-local/link-local addresses. */
function isPrivateAddress(address) {
  const text = String(address || "").replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
  if (net.isIPv4(text)) {
    const [a, b] = text.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (net.isIPv6(text)) {
    const lower = text.toLowerCase();
    return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
  }
  return false;
}

/**
 * An nftables ruleset for the robot: DDS ports accepted from loopback and the
 * named private subnets only, dropped (and counted) from anywhere else.
 */
function nftablesPolicy({ domainId = 0, lanSubnets = [], maxParticipants = 120 } = {}) {
  const subnets = lanSubnets.filter((subnet) => /^[0-9a-fA-F:.]+\/\d{1,3}$/.test(subnet) && isPrivateAddress(subnet.split("/")[0]));
  const { range } = ddsPorts(domainId, { maxParticipants });
  const v4 = subnets.filter((subnet) => net.isIPv4(subnet.split("/")[0]));
  const v6 = subnets.filter((subnet) => net.isIPv6(subnet.split("/")[0]));
  return `# HANNAH: DDS (ROS 2 domain ${domainId}) stays on this robot and its private network.
table inet hannah_dds {
  chain input {
    type filter hook input priority 0; policy accept;
    udp dport ${range.from}-${range.to} iif "lo" accept
${v4.length ? `    udp dport ${range.from}-${range.to} ip saddr { ${v4.join(", ")} } accept\n` : ""}${v6.length ? `    udp dport ${range.from}-${range.to} ip6 saddr { ${v6.join(", ")} } accept\n` : ""}    udp dport ${range.from}-${range.to} counter drop comment "DDS from outside the robot's network"
  }
  chain output {
    type filter hook output priority 0; policy accept;
    udp dport ${range.from}-${range.to} oif "lo" accept
${v4.length ? `    udp dport ${range.from}-${range.to} ip daddr { ${v4.join(", ")}, 239.255.0.1 } accept\n` : `    udp dport ${range.from}-${range.to} ip daddr 239.255.0.1 accept\n`}${v6.length ? `    udp dport ${range.from}-${range.to} ip6 daddr { ${v6.join(", ")}, ff02::/16 } accept\n` : ""}    udp dport ${range.from}-${range.to} counter drop comment "DDS to outside the robot's network"
  }
}
`;
}

/** The ROS 2 settings that keep discovery local, per distribution. */
function rosEnvironment({ rosDistro = null, scope = "subnet" } = {}) {
  const distro = String(rosDistro || "").toLowerCase();
  // ROS_AUTOMATIC_DISCOVERY_RANGE replaced ROS_LOCALHOST_ONLY in Iron.
  if (["humble", "galactic", "foxy"].includes(distro)) return scope === "localhost" ? { ROS_LOCALHOST_ONLY: "1" } : { ROS_LOCALHOST_ONLY: "0", note: "Humble can only limit discovery to localhost; rely on the firewall for the subnet." };
  return { ROS_AUTOMATIC_DISCOVERY_RANGE: scope === "localhost" ? "LOCALHOST" : "SUBNET" };
}

/**
 * Check what a robot reports listening on. `listeners`: [{ protocol, address, port }].
 * A DDS port bound to a public address, or to a wildcard on a robot whose
 * interfaces include a public address, is a finding.
 */
function checkExposure({ domainId = 0, listeners = [], interfaces = [] }) {
  const { range } = ddsPorts(domainId);
  const publicInterfaces = interfaces.filter((item) => item && !isPrivateAddress(item.address)).map((item) => item.address);
  const findings = [];
  for (const listener of listeners) {
    if (String(listener.protocol || "udp").toLowerCase() !== "udp" || listener.port < range.from || listener.port > range.to) continue;
    const wildcard = ["0.0.0.0", "::", "*"].includes(String(listener.address));
    if (wildcard && publicInterfaces.length) findings.push({ severity: "error", port: listener.port, message: `DDS port ${listener.port} listens on every interface, and this robot has a public address (${publicInterfaces.join(", ")}). Apply the firewall policy.` });
    else if (!wildcard && !isPrivateAddress(listener.address)) findings.push({ severity: "error", port: listener.port, message: `DDS port ${listener.port} listens on the public address ${listener.address}.` });
  }
  return { exposed: findings.length > 0, findings, checked: listeners.length, basis: "What the robot reported listening on; not a scan from outside." };
}

module.exports = { RTPS, checkExposure, ddsPorts, isPrivateAddress, nftablesPolicy, rosEnvironment };
