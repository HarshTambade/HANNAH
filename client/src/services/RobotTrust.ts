/**
 * The client side of robot interoperability (server/interop), device
 * identity (server/trust) and hardware packages (server/marketplace).
 *
 * Everything here is the server's record. A mission is asked for through the
 * Action Engine (the server's /api/interop routes run interop.mission), so it
 * waits for approval like any other robot movement.
 */
import { accountRequest } from "./Account";

export type NormalizedError = { code: string; title: string; severity: "warning" | "error" | "fatal"; needsPerson: boolean; message: string; vendor: Record<string, unknown> | null };
export type InteropRobot = {
  id: string; adapter: "hannah-link" | "vda5050" | string; name: string; kind: "simulation" | "physical"; status?: string;
  identity: { manufacturer: string | null; model: string | null; serialNumber: string | null; protocol: string; protocolVersion: string | null };
  state: { connection: string; online: boolean; lastReportAt: number | null; ageS: number | null; stale: boolean };
  battery: { percent: number; charging: boolean } | null;
  pose: { x: number; y: number; theta: number | null; mapId: string | null; localized: boolean } | null;
  navigation: { driving: boolean; paused: boolean } | null;
  mission: { id: string; type: string; status: string } | null;
  diagnostics: { errors: NormalizedError[]; estop: { engaged: boolean | null; kind: string | null }; fieldViolation: boolean | null };
  mode: { normalized: string; vendor: string | null; acceptsMissions: boolean };
  functions: string[]; maintenance: Record<string, unknown> | null; extensions: Record<string, unknown>;
};
export type MissionType = "navigate" | "inspect" | "deliver" | "dock" | "report_status" | "request_assistance";
export type Negotiation = { supported: boolean; missing: Array<{ feature: string; title: string }>; explanation: string };
export type CapabilityRow = { id: string; name: string; adapter: string; kind: string; functions: string[]; missions: Record<MissionType, Negotiation> };
export type Verdict = { ok: boolean; adapter: string; violations: Array<{ code: string; message: string }>; warnings: string[]; negotiation: Negotiation; plan?: Record<string, unknown> };
export type ActionRecordLite = { id: string; status: string; outcome: string };
export type InteropMission = { id: string; robotId: string; adapter: string; mission: string; title: string; status: string; final: boolean; evidence: string | null; error: string | null; createdAt: number };

export type DeviceIdentity = {
  deviceId: string; kind: string; status: "pending" | "active" | "quarantined" | "revoked"; hardwareId: string | null; keyFingerprint: string | null;
  certificate: { state: string; serial: string | null; notAfter: number | null }; reason: string | null; firstSeenAt: number | null; lastSeenAt: number | null; enrolledAt: number | null; enrollmentExpiresAt: number | null;
};
export type DevicePolicy = { unknownDevices: "quarantine" | "reject"; certificateDays: number; credentialMinutes: number; robotSecretMaxAgeDays: number | null; requireMtlsForRobotLink: boolean };
export type AuditEntry = { id: string; at: number; deviceId: string | null; kind: string; decision: string; reason: string };

export type PackageStatus = { kind: "developer-published" | "compatibility-tested"; label: string; detail: string; note?: string };
export type HardwarePackage = {
  id: string; version: string; kind: string; kindLabel: string; name: string; author: string; publisher: string; description: string;
  permissions: string[]; hardwareInterfaces: Array<{ type: string; match: string }>; safetyConstraints: string[]; dependencies: Array<{ id: string; version: string }>;
  testResults: Array<{ level: string; target: string; environment: string; passed: number; total: number }>; changelog: Array<{ version: string; changes?: string[] }>;
  status: PackageStatus; revoked: { reason: string; at: number } | null; installedOn: string[]; documentation: string;
};
export type PackageInstall = { packageId: string; target: string; version: string; previousVersion: string | null; permissions: string[]; status: string; updatedAt: number };

const json = (value: unknown) => JSON.stringify(value);
const id = (value: string) => encodeURIComponent(value);

export const MISSION_LABELS: Record<MissionType, string> = {
  navigate: "Drive to a place", inspect: "Visit points and record", deliver: "Carry a load", dock: "Go to the dock", report_status: "Report status", request_assistance: "Stop and ask for help",
};

/** One line that never overstates a robot's state. */
export function connectionText(robot: InteropRobot): string {
  if (robot.state.online) return `Reporting${robot.state.ageS !== null ? ` (${robot.state.ageS} s ago)` : ""}`;
  if (robot.state.connection === "never-connected") return "Never reported";
  if (robot.state.connection === "link-broken") return "Link broken (the broker reported it)";
  return `Not reporting${robot.state.ageS !== null ? `: last report ${Math.round(robot.state.ageS)} s ago, shown as old` : ""}`;
}

/** The marketplace status line: a fact about who tested what, never a badge or certification. */
export function packageStatusText(status: PackageStatus): string {
  return status.kind === "compatibility-tested" ? `Compatibility tested: ${status.detail}` : "Developer-published";
}

export const RobotTrust = {
  fleet: () => accountRequest<{ adapters: Array<{ id: string; label: string; protocol: { name: string; version: string; verifiedWith: string } }>; robots: InteropRobot[] }>("/api/interop"),
  capabilities: () => accountRequest<{ robots: CapabilityRow[] }>("/api/interop/capabilities"),
  assess: (robotId: string, mission: MissionType, params: Record<string, unknown>) => accountRequest<{ verdict: Verdict }>(`/api/interop/robots/${id(robotId)}/assess`, { method: "POST", body: json({ mission, params }) }),
  send: (robotId: string, mission: MissionType, params: Record<string, unknown>) => accountRequest<{ record: ActionRecordLite }>(`/api/interop/robots/${id(robotId)}/missions`, { method: "POST", body: json({ mission, params }) }),
  assist: (robotId: string, reason: string) => accountRequest<{ record: ActionRecordLite }>(`/api/interop/robots/${id(robotId)}/assist`, { method: "POST", body: json({ reason }) }),
  missions: () => accountRequest<{ missions: InteropMission[] }>("/api/interop/missions"),
  registerVda: (input: Record<string, unknown>) => accountRequest<{ robot: InteropRobot }>("/api/interop/vda5050", { method: "POST", body: json(input) }),

  identities: () => accountRequest<{ identities: DeviceIdentity[]; policy: DevicePolicy; revocations: Array<{ serial: string; deviceId: string; reason: string; revokedAt: number }> }>("/api/trust/devices"),
  registerDevice: (deviceId: string, kind: string, hardwareId?: string) => accountRequest<{ identity: DeviceIdentity; enrollment: { code: string; expiresAt: number } }>("/api/trust/devices", { method: "POST", body: json({ deviceId, kind, ...(hardwareId ? { hardwareId } : {}) }) }),
  revokeDevice: (deviceId: string, reason?: string) => accountRequest<{ identity: DeviceIdentity }>(`/api/trust/devices/${id(deviceId)}/revoke`, { method: "POST", body: json({ reason }) }),
  dismissQuarantined: (deviceId: string) => accountRequest<{ dismissed: boolean }>(`/api/trust/devices/${id(deviceId)}/quarantine`, { method: "DELETE" }),
  setPolicy: (change: Partial<DevicePolicy>) => accountRequest<{ policy: DevicePolicy }>("/api/trust/policy", { method: "PUT", body: json(change) }),
  audit: () => accountRequest<{ audit: AuditEntry[] }>("/api/trust/audit?limit=30"),

  packages: () => accountRequest<{ packages: HardwarePackage[]; installs: PackageInstall[] }>("/api/hardware-packages"),
  uploadPackage: (manifest: unknown, files: Record<string, string>) => accountRequest<{ stored: boolean; ok: boolean; problems: string[] }>("/api/hardware-packages", { method: "POST", body: json({ manifest, files }) }),
  installPackage: (packageId: string, version: string, target: string) => accountRequest<{ record: ActionRecordLite }>("/api/hardware-packages/install", { method: "POST", body: json({ packageId, version, target }) }),
  rollbackPackage: (packageId: string, target: string) => accountRequest<{ record: ActionRecordLite }>("/api/hardware-packages/rollback", { method: "POST", body: json({ packageId, target }) }),
  revokePackage: (packageId: string, version: string, reason: string) => accountRequest<{ disabledInstalls: number }>("/api/hardware-packages/revoke", { method: "POST", body: json({ packageId, version, reason }) }),
};
