import { describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({ apiFetch: vi.fn(), apiUrl: (path: string) => path, getApiAccessToken: () => "" }));
vi.mock("../services/DeviceTools", () => ({ setExternalTools: vi.fn() }));

const { mcpToolName, toHannahTools } = await import("../services/McpTools");

describe("MCP tools", () => {
  it("builds agent-safe tool names", () => {
    expect(mcpToolName("team-docs", "Search.Pages")).toBe("mcp_team_docs_search_pages");
    expect(mcpToolName("x", "a".repeat(100))).toHaveLength(64);
  });

  it("always requires approval and shows the server and tool on the approval card", () => {
    const [tool] = toHannahTools([
      { id: "docs", name: "Team docs", ok: true, tools: [{ name: "search", title: "Search docs", description: "Find pages", inputSchema: { type: "object", properties: { q: { type: "string" } } }, readOnly: true }] },
      { id: "down", name: "Offline", ok: false, error: "x", tools: [{ name: "a", description: "", inputSchema: { type: "object", properties: {} }, readOnly: false }] },
    ]);
    expect(tool.name).toBe("mcp_docs_search");
    expect(tool.requiresApproval).toBe(true);
    expect(tool.sensitive).toBe("external_tool");
    expect(tool.description).toContain("Team docs");
    expect(tool.approvalDetails?.({ q: "hi" })).toEqual({ tool: "Search docs", server: "Team docs", arguments: { q: "hi" } });
  });
});
