/**
 * Tools from outside MCP servers the operator connected to this HANNAH server.
 * Each becomes a HANNAH tool that always needs the user's approval (HANNAH
 * can't know what an outside tool changes) and is screened by the Guardian
 * like every other tool. Only available with the operator's access token.
 */
import { apiFetch, apiUrl, getApiAccessToken } from "./api";
import { setExternalTools, type HANNAHTool, type ToolSchema } from "./DeviceTools";

export type McpServerInfo = { id: string; name: string; ok: boolean; error?: string; tools: Array<{ name: string; title?: string; description: string; inputSchema: ToolSchema; readOnly: boolean }> };

/** A tool name the agent API accepts: lowercase letters, digits and underscores, up to 64. */
export function mcpToolName(serverId: string, tool: string) {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `mcp_${slug(serverId)}_${slug(tool)}`.slice(0, 64);
}

export function toHannahTools(servers: McpServerInfo[]): HANNAHTool[] {
  const tools: HANNAHTool[] = [];
  const seen = new Set<string>();
  for (const server of servers) {
    if (!server.ok) continue;
    for (const tool of server.tools) {
      const name = mcpToolName(server.id, tool.name);
      if (seen.has(name) || !/^[a-z][a-z0-9_]{1,63}$/.test(name)) continue;
      seen.add(name);
      tools.push({
        name,
        description: `[${server.name} · outside MCP tool] ${tool.description || tool.title || tool.name}`.slice(0, 1000),
        inputSchema: tool.inputSchema?.type === "object" ? tool.inputSchema : { type: "object", properties: {} },
        requiresApproval: true,
        sensitive: "external_tool",
        approvalDetails: (args) => ({ tool: tool.title || tool.name, server: server.name, arguments: args }),
        execute: async (args) => {
          const response = await apiFetch(apiUrl("/api/mcp/call"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ server: server.id, tool: tool.name, arguments: args }),
            signal: AbortSignal.timeout(60_000),
          });
          const body = await response.json().catch(() => ({})) as { error?: string; isError?: boolean; text?: string };
          if (!response.ok) throw new Error(body.error || `${server.name} didn't respond.`);
          if (body.isError) throw new Error(body.text || `${tool.name} reported an error.`);
          return { message: body.text || "Done." };
        },
      });
    }
  }
  return tools;
}

export async function loadMcpServers(): Promise<McpServerInfo[]> {
  if (!getApiAccessToken()) return [];
  try {
    const response = await apiFetch(apiUrl("/api/mcp/servers"), { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return [];
    const body = await response.json() as { servers?: McpServerInfo[] };
    return Array.isArray(body.servers) ? body.servers : [];
  } catch {
    return [];
  }
}

/** Load outside tools and make them available to HANNAH's agent. */
export async function refreshMcpTools() {
  const servers = await loadMcpServers();
  setExternalTools(toHannahTools(servers));
  return servers;
}
