/**
 * How HANNAH presents itself to other agents.
 *
 * - `profile()` lists what this device can actually do: the names of the
 *   tools HANNAH has here (calendar, files, phone… whichever are available),
 *   and that every action with side effects needs the person's approval.
 * - `expose()` adds the server's published A2A agent card
 *   (GET /api/a2a/agent-card: the JSON-RPC endpoint other agents call, its
 *   skills and authentication), so another agent gets the real address and
 *   abilities.
 */
import { apiFetch, apiUrl } from "./api";

export type HANNAHInteropProfile = {
  capabilities: string[];
  permissions: string[];
  estimatedCostUsd: number;
};

export type HANNAHAgentCard = HANNAHInteropProfile & {
  name: string;
  url: string | null;
  skills: Array<{ id: string; name: string; description?: string }>;
  authentication: unknown;
  source: "server" | "device-only";
};

export const AgentInteropService = {
  /** What a device with these tools can do (expose() passes the device's real tools). */
  profile(tools: Array<{ name: string; requiresApproval?: boolean }> = []): HANNAHInteropProfile {
    const capabilities = ["chat", "memory", ...new Set(tools.map((tool) => tool.name))].slice(0, 100);
    return { capabilities, permissions: ["user_approved"], estimatedCostUsd: 0.01 };
  },

  /** The full card: device capabilities plus the server's A2A card (when the server answers). */
  async expose({ fetchImpl, tools }: { fetchImpl?: typeof fetch; tools?: Array<{ name: string; requiresApproval?: boolean }> } = {}): Promise<HANNAHAgentCard> {
    if (!tools) {
      try {
        const { getDeviceTools } = await import("./DeviceTools");
        tools = getDeviceTools();
      } catch {
        tools = [];
      }
    }
    const base = this.profile(tools);
    try {
      const response = await (fetchImpl ?? apiFetch)(apiUrl("/api/a2a/agent-card"), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(String(response.status));
      const card = await response.json() as { name?: string; url?: string; skills?: Array<{ id: string; name: string; description?: string }>; authentication?: unknown; securitySchemes?: unknown };
      return { ...base, name: card.name || "HANNAH", url: card.url ?? null, skills: Array.isArray(card.skills) ? card.skills : [], authentication: card.authentication ?? card.securitySchemes ?? null, source: "server" };
    } catch {
      return { ...base, name: "HANNAH", url: null, skills: [], authentication: null, source: "device-only" };
    }
  },
};
