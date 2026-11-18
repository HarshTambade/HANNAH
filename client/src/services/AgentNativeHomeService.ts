/**
 * HANNAH's "home": the HANNAH server this app works with (the website's own
 * server, a self-hosted one, or a Vercel deployment), and the services
 * connected through it.
 *
 * Nothing here pretends to create infrastructure. "provision" connects to a
 * server and checks it for real: GET /api/health (is it up, does it have an
 * AI provider) and GET /api/account/status (accounts, database, vault). The
 * state is "running" only when the server answered healthy, "error" with the
 * reason otherwise. "migrate" does the same for another server address.
 */
import { apiBase } from "./api";

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
  /** The server's address. */
  region: string;
  provider: "local" | "aws" | "gcp" | "azure" | "self_hosted" | "vercel";
  status: "provisioning" | "running" | "stopped" | "error";
  uptimeSince: number | null;
  connections: AppConnection[];
  createdAt: number;
  /** What the server reported, or why it couldn't be reached. */
  health?: { ready: boolean; provider: string | null; accounts: boolean; database: boolean; vault: boolean; latencyMs: number; checkedAt: number; error?: string };
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

/** The server this app uses: its configured API base, or this page's own origin. */
function defaultServer() {
  const base = apiBase();
  if (base) return base;
  return typeof window !== "undefined" ? window.location.origin : "http://localhost:3001";
}

const hostingOf = (url: string): CloudHome["provider"] => {
  try {
    const host = new URL(url).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) return "local";
    if (host.endsWith(".vercel.app")) return "vercel";
    if (/amazonaws\.com$/.test(host)) return "aws";
    if (/(run\.app|appspot\.com|googleusercontent\.com)$/.test(host)) return "gcp";
    if (/azure(websites|containerapps)?\.(net|io)$/.test(host)) return "azure";
  } catch {
    // Fall through.
  }
  return "self_hosted";
};

/** Ask a HANNAH server how it is. Never throws; a failure is in `error`. Exported for tests. */
export async function checkServer(server: string, fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<NonNullable<CloudHome["health"]>> {
  const started = Date.now();
  const base = server.replace(/\/+$/, "");
  try {
    const health = await fetchImpl(`${base}/api/health`, { signal: AbortSignal.timeout(10_000) });
    if (!health.ok) throw new Error(`The server answered ${health.status}.`);
    const body = await health.json() as { status?: string; ready?: boolean; provider?: string };
    if (body.status !== "ok") throw new Error("The server isn't healthy.");
    const status = await fetchImpl(`${base}/api/account/status`, { signal: AbortSignal.timeout(10_000) }).then((response) => (response.ok ? response.json() : {})).catch(() => ({})) as { accounts?: { enabled?: boolean }; database?: { ready?: boolean }; vault?: boolean };
    return { ready: body.ready === true, provider: body.provider ?? null, accounts: status.accounts?.enabled === true, database: status.database?.ready === true, vault: status.vault === true, latencyMs: Date.now() - started, checkedAt: Date.now() };
  } catch (error) {
    return { ready: false, provider: null, accounts: false, database: false, vault: false, latencyMs: Date.now() - started, checkedAt: Date.now(), error: error instanceof Error ? error.message : String(error) };
  }
}

export const AgentNativeHomeService = {
  home: readHome(),
  /** Connect to a HANNAH server (this app's own by default) and check it. */
  async provision(region = defaultServer(), provider?: CloudHome["provider"], { fetchImpl }: { fetchImpl?: typeof fetch } = {}) {
    const home: CloudHome = {
      id: this.home?.id ?? crypto.randomUUID(),
      region,
      provider: provider ?? hostingOf(region),
      status: "provisioning",
      uptimeSince: null,
      connections: this.home?.connections ?? [],
      createdAt: this.home?.createdAt ?? Date.now(),
    };
    writeHome(home);
    this.home = home;
    const health = await checkServer(region, fetchImpl);
    home.health = health;
    home.status = health.error ? "error" : "running";
    home.uptimeSince = health.error ? null : Date.now();
    writeHome(home);
    this.home = home;
    return home;
  },
  /** Move to another HANNAH server: checked first; the old one stays if the new one doesn't answer. */
  async migrate(region: string, { fetchImpl }: { fetchImpl?: typeof fetch } = {}) {
    if (!this.home) throw new Error("No HANNAH server is connected yet.");
    const previous = { ...this.home };
    const health = await checkServer(region, fetchImpl);
    if (health.error) throw new Error(`HANNAH couldn't use ${region}: ${health.error}`);
    this.home = { ...this.home, region, provider: hostingOf(region), status: "running", uptimeSince: Date.now(), health };
    writeHome(this.home);
    return { previous, current: this.home };
  },
  /** Check the current server again. */
  async refresh({ fetchImpl }: { fetchImpl?: typeof fetch } = {}) {
    if (!this.home) return null;
    const health = await checkServer(this.home.region, fetchImpl);
    this.home = { ...this.home, health, status: health.error ? "error" : "running", uptimeSince: health.error ? null : this.home.uptimeSince ?? Date.now() };
    writeHome(this.home);
    return this.home;
  },
  registerConnection(connection: AppConnection) {
    if (!this.home) throw new Error("No HANNAH server is connected yet.");
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
    if (this.home) writeHome(this.home);
  },
};
