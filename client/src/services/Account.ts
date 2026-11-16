import { apiFetch, apiUrl, getAccountHint, setAccountHint, usesBearerSession } from "./api";

export type AccountStatus = {
  accounts: { enabled: boolean; signup: boolean; serverKeys: boolean };
  database: { configured: boolean; ready: boolean; kind: "postgres" | "sqlite" | null; provider: string | null; schemaVersion?: number; error?: string };
  vault: boolean;
  user: { id: string; email: string; displayName: string; via: "session" | "api-key"; providers: string[] } | null;
  sessionError?: string;
};

export type StoredCredential = { providerId: string; label: string; hint: string; updatedAt: number };
export type DeveloperKey = { id: string; name: string; prefix: string; createdAt: number; lastUsedAt: number | null };
export type AuditEvent = { event: string; detail: Record<string, unknown> | null; at: number };
export type Webhook = { id: string; url: string; events: string[]; createdAt: number; lastStatus: number | null; lastDeliveryAt: number | null };

export class AccountError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) {
    super(message);
  }
}

/** A call to the signed-in account API. Shared by Account, DeviceTasks and Connections. */
export async function accountRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch(apiUrl(path), {
      ...init,
      credentials: usesBearerSession() ? "omit" : "same-origin",
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(usesBearerSession() ? { "X-HANNAH-Session": "bearer" } : {}), ...(init.headers as Record<string, string> | undefined) },
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AccountError("Couldn't reach the HANNAH server.", 0, "unreachable");
  }
  const body = await response.json().catch(() => ({})) as { error?: string; reason?: string };
  if (!response.ok) {
    if (response.status === 401 && body.reason === "session-invalid") setAccountHint(null);
    throw new AccountError(typeof body.error === "string" ? body.error : `The server returned HTTP ${response.status}.`, response.status, body.reason);
  }
  return body as T;
}

type SignedIn = { user: { id: string; email: string; displayName: string }; sessionToken?: string };

function remember(result: SignedIn) {
  setAccountHint({ email: result.user.email, displayName: result.user.displayName, ...(result.sessionToken ? { sessionToken: result.sessionToken } : {}) });
  return result.user;
}

const json = (value: unknown) => JSON.stringify(value);

export const Account = {
  async status() {
    const status = await accountRequest<Partial<AccountStatus>>("/api/account/status");
    // A host without the HANNAH server (for example a static build) can answer
    // with a web page instead; treat anything without the expected shape as
    // "no accounts here" rather than letting Settings or the landing page crash.
    if (!status || typeof status.accounts?.enabled !== "boolean" || typeof status.database !== "object" || status.database === null) {
      throw new AccountError("This server didn't answer like a HANNAH server.", 0, "unexpected-response");
    }
    return status as AccountStatus;
  },
  async register(email: string, password: string, displayName = "") {
    return remember(await accountRequest<SignedIn>("/api/account/register", { method: "POST", body: json({ email, password, displayName }) }));
  },
  async login(email: string, password: string) {
    return remember(await accountRequest<SignedIn>("/api/account/login", { method: "POST", body: json({ email, password }) }));
  },
  async logout() {
    try {
      await accountRequest("/api/account/logout", { method: "POST" });
    } finally {
      setAccountHint(null);
    }
  },
  async logoutEverywhere() {
    try {
      await accountRequest("/api/account/logout-all", { method: "POST" });
    } finally {
      setAccountHint(null);
    }
  },
  /** Re-check the stored "signed in" hint against the server. Returns the user or null. */
  async refresh() {
    if (!getAccountHint()) return null;
    try {
      const status = await this.status();
      if (!status.user) setAccountHint(null);
      return status.user;
    } catch (error) {
      if (error instanceof AccountError && error.status === 401) setAccountHint(null);
      return getAccountHint() ? undefined : null;
    }
  },
  credentials: () => accountRequest<{ vault: boolean; credentials: StoredCredential[] }>("/api/account/credentials"),
  saveCredential: (providerId: string, apiKey: string) => accountRequest<{ ok: true; hint: string; verified: boolean }>(`/api/account/credentials/${encodeURIComponent(providerId)}`, { method: "PUT", body: json({ apiKey }) }),
  removeCredential: (providerId: string) => accountRequest<{ ok: true }>(`/api/account/credentials/${encodeURIComponent(providerId)}`, { method: "DELETE" }),
  apiKeys: () => accountRequest<{ keys: DeveloperKey[] }>("/api/account/api-keys"),
  createApiKey: (name: string) => accountRequest<{ key: string; id: string; name: string; note: string }>("/api/account/api-keys", { method: "POST", body: json({ name }) }),
  revokeApiKey: (id: string) => accountRequest<{ ok: true }>(`/api/account/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  audit: () => accountRequest<{ events: AuditEvent[] }>("/api/account/audit"),
  exportData: () => accountRequest<Record<string, unknown>>("/api/account/export"),
  async deleteAccount(password: string) {
    await accountRequest("/api/account", { method: "DELETE", body: json({ password }) });
    setAccountHint(null);
  },
  webhooks: () => accountRequest<{ events: string[]; webhooks: Webhook[] }>("/api/account/webhooks"),
  createWebhook: (url: string, events: string[]) => accountRequest<{ id: string; secret: string; events: string[] }>("/api/account/webhooks", { method: "POST", body: json({ url, events }) }),
  removeWebhook: (id: string) => accountRequest<{ ok: true }>(`/api/account/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testWebhook: (id: string) => accountRequest<{ ok: boolean; status: number }>(`/api/account/webhooks/${encodeURIComponent(id)}/test`, { method: "POST" }),
  /** Tell the account's webhooks about something that happened on this device. Best effort. */
  emitEvent(event: "reminder.fired" | "team.completed", data: Record<string, unknown>) {
    if (!getAccountHint()) return;
    void accountRequest("/api/account/events", { method: "POST", body: json({ event, data }) }).catch(() => undefined);
  },
  readData: <T,>(namespace: string) => accountRequest<{ namespace: string; value: T | null; version: number; updatedAt: number | null }>(`/api/account/data/${namespace}`),
  writeData: (namespace: string, value: unknown, baseVersion: number) => accountRequest<{ version: number; updatedAt: number }>(`/api/account/data/${namespace}`, { method: "PUT", body: json({ value, baseVersion }) }),
};

/** Plain-language name for a database provider id from the server. */
export function databaseLabel(provider: string | null | undefined) {
  const labels: Record<string, string> = {
    supabase: "Supabase", neon: "Neon", "aws-rds": "Amazon RDS", azure: "Azure Database for PostgreSQL", railway: "Railway", render: "Render",
    aiven: "Aiven", cockroachdb: "CockroachDB", "local-postgres": "Local Postgres", postgres: "Postgres", sqlite: "SQLite", pglite: "PGlite",
  };
  return provider ? labels[provider] || provider : "None";
}
