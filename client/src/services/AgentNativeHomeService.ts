export type AppConnection = {
  service: string;
  interface: "cli" | "api" | "mcp" | "gui";
  endpoint: string;
  oauthToken?: string;
  connectedAt: number;
  lastLatencyMs: number;
  successRate: number;
};

export type CloudHome = {
  id: string;
  region: string;
  provider: "local" | "aws" | "gcp" | "azure" | "self_hosted";
  status: "provisioning" | "running" | "stopped" | "error";
  uptimeSince: number | null;
  connections: AppConnection[];
  createdAt: number;
};

const KEY = "hannah.cloudhome.v1";

function readHome(): CloudHome | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || "null");
    return parsed;
  } catch {
    return null;
  }
}

function writeHome(home: CloudHome | null) {
  try {
    window.localStorage.setItem(KEY, home ? JSON.stringify(home) : "null");
  } catch {
    // Best effort.
  }
}

export const AgentNativeHomeService = {
  home: readHome(),
  async provision(region = "local", provider: CloudHome["provider"] = "local") {
    const home: CloudHome = {
      id: crypto.randomUUID(),
      region,
      provider,
      status: "provisioning",
      uptimeSince: null,
      connections: [],
      createdAt: Date.now(),
    };
    writeHome(home);
    this.home = home;
    // Simulate provisioning completion; real implementation would call infra API.
    await new Promise((resolve) => setTimeout(resolve, 500));
    home.status = "running";
    home.uptimeSince = Date.now();
    writeHome(home);
    this.home = home;
    return home;
  },
  async migrate(region: string) {
    if (!this.home) throw new Error("No cloud home provisioned.");
    const previous = { ...this.home };
    this.home.region = region;
    this.home.status = "provisioning";
    writeHome(this.home);
    await new Promise((resolve) => setTimeout(resolve, 500));
    this.home.status = "running";
    this.home.uptimeSince = Date.now();
    writeHome(this.home);
    return { previous, current: this.home };
  },
  registerConnection(connection: AppConnection) {
    if (!this.home) throw new Error("No cloud home provisioned.");
    const existing = this.home.connections.findIndex((c) => c.service === connection.service);
    if (existing >= 0) {
      this.home.connections[existing] = { ...this.home.connections[existing], ...connection, connectedAt: Date.now() };
    } else {
      this.home.connections.push({ ...connection, connectedAt: Date.now() });
    }
    writeHome(this.home);
  },
  getConnection(service: string) {
    return this.home?.connections.find((c) => c.service === service);
  },
  recordLatency(service: string, latencyMs: number, success: boolean) {
    const conn = this.getConnection(service);
    if (!conn) return;
    conn.lastLatencyMs = latencyMs;
    conn.successRate = success ? Math.min(1, (conn.successRate + 1) / 2) : Math.max(0, conn.successRate - 0.1);
    writeHome(this.home);
  },
};