/** Typed client helpers for the onboard HANNAH Robot OS bridge. */

export type RobotOSEnvelopeKind = "telemetry" | "event" | "command_ack" | "heartbeat" | "sync_request";

export interface RobotOSEnvelope {
  envelope_id: string;
  robot_id: string;
  ts_ms: number;
  kind: RobotOSEnvelopeKind;
  payload: Record<string, unknown>;
  nonce?: string;
  signature: string;
}

export interface RobotOSSummary {
  total: number;
  byKind: Record<string, number>;
  lastTsMs: number | null;
  faultEvents: number;
}

export function summarizeEnvelopes(envelopes: RobotOSEnvelope[]): RobotOSSummary {
  const byKind: Record<string, number> = {};
  let lastTsMs: number | null = null;
  let faultEvents = 0;
  for (const env of envelopes) {
    byKind[env.kind] = (byKind[env.kind] || 0) + 1;
    if (lastTsMs === null || env.ts_ms > lastTsMs) lastTsMs = env.ts_ms;
    if (env.kind === "event" && typeof env.payload.type === "string" && /fault|estop/i.test(env.payload.type)) faultEvents += 1;
  }
  return { total: envelopes.length, byKind, lastTsMs, faultEvents };
}

export async function submitRobotOSEnvelope(
  post: (path: string, body: unknown) => Promise<{ ok: boolean }>,
  envelope: RobotOSEnvelope,
): Promise<boolean> {
  if (!envelope.signature || !envelope.envelope_id || !envelope.robot_id) return false;
  try {
    const result = await post("/api/robotos/bridge", envelope);
    return Boolean(result.ok);
  } catch {
    return false;
  }
}
