export const AppConnectionRegistry = {
  connections: [] as Array<{ service: string; interface: "cli" | "api" | "mcp" | "gui"; latencyMs: number; success: boolean }>,
  register(service: string, iface: "cli" | "api" | "mcp" | "gui") {
    this.connections.push({ service, interface: iface, latencyMs: 0, success: true });
  },
  preferAgentAdapted(service: string) {
    return this.connections.find((c) => c.service === service && c.interface !== "gui");
  },
};