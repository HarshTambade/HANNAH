/**
 * Connectors: outside services (each the vendor's own MCP server) that you
 * connect with your own sign-in, a token, or nothing at all. Their tools become
 * HANNAH tools that always ask for your approval and pass the Guardian.
 *
 * Everything about a connection stays in this browser (localStorage): the
 * client id HANNAH registered with the service, your tokens and the tool list.
 * The server (server/connectors.js) stores nothing; it registers, exchanges
 * codes for tokens and forwards tool calls with the token this browser sends.
 *
 * Sign-in is OAuth 2.1 with PKCE (S256) and dynamic client registration, as the
 * MCP authorization spec describes. It returns to /connectors/callback on the
 * website, so signing in works on the website (and local development).
 */
import { IS_WEBSITE } from "../config/site";
import { apiFetch, apiUrl, isLocalDevelopmentHost } from "./api";
import { setExternalTools, type HANNAHTool, type ToolSchema } from "./DeviceTools";
import { mcpToolName } from "./McpTools";

export type ConnectorAuth = "oauth" | "none" | "token";
export type CatalogEntry = { id: string; name: string; category: string; url: string; auth: ConnectorAuth; description: string; docs: string; tokenHelp?: string; /** The vendor's own icon, bundled with the site. */ icon?: string };
export type ConnectorTool = { name: string; title?: string; description: string; inputSchema: ToolSchema; readOnly: boolean };
export type Connection = {
  id: string;
  name: string;
  url: string;
  auth: ConnectorAuth;
  custom?: boolean;
  clientId?: string;
  clientSecret?: string;
  authMethod?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number | null;
  tools: ConnectorTool[];
  connectedAt: number;
  /** Set when the service needs you to sign in again. */
  needsSignIn?: boolean;
};

const KEY = "hannah.connectors.v1";
const PENDING = "hannah.connectors.pending";
export const CALLBACK_PATH = "/connectors/callback";
export const CONNECTORS_EVENT = "hannah:connectors";

function read(): Connection[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || "[]") as Connection[];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === "string" && typeof item.url === "string") : [];
  } catch {
    return [];
  }
}
function write(connections: Connection[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(connections));
  } catch {
    // Storage full or blocked: the connection lasts for this page only.
  }
  installConnectorTools(connections);
  try {
    window.dispatchEvent(new Event(CONNECTORS_EVENT));
  } catch {
    // No window events in some environments.
  }
}
function save(connection: Connection) {
  write([...read().filter((item) => item.id !== connection.id), connection]);
}

export function listConnections() {
  return read();
}

/** Signing in needs the website's callback page; the desktop and phone apps link to the website for now. */
export function canSignIn() {
  return IS_WEBSITE || isLocalDevelopmentHost();
}

function redirectUri() {
  return `${window.location.origin}${CALLBACK_PATH}`;
}

class ConnectorError extends Error {
  constructor(message: string, readonly reason?: string, readonly status?: number) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(apiUrl(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const data = await response.json().catch(() => ({})) as T & { error?: string; reason?: string };
  if (!response.ok) throw new ConnectorError(data.error || `The server answered ${response.status}.`, data.reason, response.status);
  return data;
}

export async function loadCatalog(): Promise<CatalogEntry[]> {
  const response = await fetch(apiUrl("/api/connectors/catalog"), { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("Couldn't load the connector directory.");
  const body = await response.json() as { connectors?: CatalogEntry[] };
  return Array.isArray(body.connectors) ? body.connectors : [];
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function randomString(bytes = 32) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return base64url(values);
}
async function challengeFor(verifier: string) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

async function listTools(connection: Pick<Connection, "url" | "name" | "accessToken">) {
  const body = await post<{ tools?: ConnectorTool[] }>("/api/connectors/rpc", { url: connection.url, name: connection.name, token: connection.accessToken || undefined, action: "list" });
  return Array.isArray(body.tools) ? body.tools : [];
}

type Target = { id: string; name: string; url: string; auth?: ConnectorAuth; custom?: boolean };

/**
 * Connect a connector. Services without sign-in connect at once; token
 * services need `token`; sign-in services send this page to the service's own
 * sign-in, which returns to /connectors/callback (see finishSignIn).
 */
export async function connect(target: Target, { token }: { token?: string } = {}): Promise<{ connected: Connection } | { redirecting: true }> {
  let auth = target.auth;
  if (!auth) auth = (await post<{ auth: ConnectorAuth }>("/api/connectors/discover", { url: target.url })).auth;
  if (token?.trim()) auth = "token";
  if (auth === "none" || auth === "token") {
    if (auth === "token" && !token?.trim()) throw new ConnectorError(`${target.name} needs a token.`, "token-required");
    const connection: Connection = { id: target.id, name: target.name, url: target.url, auth, custom: target.custom, accessToken: token?.trim() || undefined, tools: [], connectedAt: Date.now() };
    connection.tools = await listTools(connection);
    save(connection);
    return { connected: connection };
  }
  if (!canSignIn()) throw new ConnectorError("Signing in to connectors works on the HANNAH website for now.", "website-only");
  const registration = await post<{ clientId: string; clientSecret?: string; authMethod?: string; authorizationEndpoint: string; resource: string; scope: string }>("/api/connectors/register", { url: target.url, redirectUri: redirectUri() });
  const verifier = randomString(48);
  const state = randomString(24);
  const authorize = new URL(registration.authorizationEndpoint);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: registration.clientId,
    redirect_uri: redirectUri(),
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
    state,
    resource: registration.resource,
    ...(registration.scope ? { scope: registration.scope } : {}),
  };
  for (const [key, value] of Object.entries(params)) authorize.searchParams.set(key, value);
  // Only this tab needs to know about the sign-in in progress.
  window.sessionStorage.setItem(PENDING, JSON.stringify({ state, verifier, target: { ...target, auth: "oauth" }, clientId: registration.clientId, clientSecret: registration.clientSecret, authMethod: registration.authMethod, at: Date.now() }));
  window.location.assign(authorize.toString());
  return { redirecting: true };
}

/** True when this page is a connector's sign-in coming back. */
export function isSignInReturn(location: Pick<Location, "pathname" | "search"> = window.location) {
  return location.pathname.endsWith(CALLBACK_PATH) && /[?&](code|error)=/.test(location.search);
}

/** Finish a sign-in on /connectors/callback: check the state, exchange the code (with the PKCE verifier) and save the connection. */
export async function finishSignIn(search = window.location.search): Promise<Connection> {
  const params = new URLSearchParams(search);
  let pending: { state: string; verifier: string; target: Target; clientId: string; clientSecret?: string; authMethod?: string; at: number } | null = null;
  try {
    pending = JSON.parse(window.sessionStorage.getItem(PENDING) || "null");
  } catch {
    pending = null;
  }
  window.sessionStorage.removeItem(PENDING);
  if (!pending || pending.state !== params.get("state") || Date.now() - pending.at > 15 * 60_000) throw new ConnectorError("This sign-in didn't start here, or it took too long. Try connecting again.", "state");
  if (params.get("error")) throw new ConnectorError(params.get("error") === "access_denied" ? `You didn't allow ${pending.target.name}.` : `${pending.target.name} didn't sign you in (${params.get("error_description") || params.get("error")}).`, "denied");
  const code = params.get("code") || "";
  const tokens = await post<{ accessToken: string; refreshToken?: string; expiresAt: number | null }>("/api/connectors/token", {
    url: pending.target.url, clientId: pending.clientId, clientSecret: pending.clientSecret, authMethod: pending.authMethod, code, codeVerifier: pending.verifier, redirectUri: redirectUri(),
  });
  const connection: Connection = {
    id: pending.target.id, name: pending.target.name, url: pending.target.url, auth: "oauth", custom: pending.target.custom,
    clientId: pending.clientId, clientSecret: pending.clientSecret, authMethod: pending.authMethod,
    accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, tools: [], connectedAt: Date.now(),
  };
  connection.tools = await listTools(connection);
  save(connection);
  return connection;
}

export function disconnect(id: string) {
  write(read().filter((item) => item.id !== id));
}

/** A token that's still good: refreshed first when it's about to expire. */
async function freshToken(connection: Connection, force = false): Promise<string | undefined> {
  if (connection.auth !== "oauth") return connection.accessToken;
  const expiring = connection.expiresAt ? connection.expiresAt - 60_000 < Date.now() : false;
  if ((force || expiring) && connection.refreshToken && connection.clientId) {
    try {
      const tokens = await post<{ accessToken: string; refreshToken?: string; expiresAt: number | null }>("/api/connectors/token", { url: connection.url, clientId: connection.clientId, clientSecret: connection.clientSecret, authMethod: connection.authMethod, refreshToken: connection.refreshToken });
      Object.assign(connection, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || connection.refreshToken, expiresAt: tokens.expiresAt, needsSignIn: false });
      save(connection);
    } catch (error) {
      if (error instanceof ConnectorError && error.reason === "reauth") {
        save({ ...connection, needsSignIn: true });
        throw new ConnectorError(`${connection.name} needs you to sign in again (Marketplace → Connectors).`, "reauth");
      }
      throw error;
    }
  }
  return connection.accessToken;
}

async function call<T>(connection: Connection, body: Record<string, unknown>): Promise<T> {
  const send = async (force: boolean) => post<T>("/api/connectors/rpc", { url: connection.url, name: connection.name, token: await freshToken(connection, force), ...body });
  try {
    return await send(false);
  } catch (error) {
    if (!(error instanceof ConnectorError) || error.reason !== "reauth") throw error;
    // The token was refused: refresh once and try again.
    if (connection.auth === "oauth" && connection.refreshToken) return send(true);
    save({ ...connection, needsSignIn: true });
    throw new ConnectorError(`${connection.name} needs you to connect again (Marketplace → Connectors).`, "reauth");
  }
}

/** Load a connection's tools again (for example after the service added some). */
export async function refreshConnection(id: string) {
  const connection = read().find((item) => item.id === id);
  if (!connection) return null;
  const body = await call<{ tools?: ConnectorTool[] }>(connection, { action: "list" });
  const updated = { ...connection, tools: Array.isArray(body.tools) ? body.tools : [], needsSignIn: false };
  save(updated);
  return updated;
}

/** Each connector tool as a HANNAH tool: always approved by you, screened by the Guardian. */
export function connectorTools(connections = read()): HANNAHTool[] {
  const tools: HANNAHTool[] = [];
  const seen = new Set<string>();
  for (const connection of connections) {
    if (connection.needsSignIn) continue;
    for (const tool of connection.tools.slice(0, 50)) {
      const name = mcpToolName(`c_${connection.id}`, tool.name);
      if (seen.has(name) || !/^[a-z][a-z0-9_]{1,63}$/.test(name)) continue;
      seen.add(name);
      tools.push({
        name,
        description: `[${connection.name} connector${tool.readOnly ? ", read-only" : ""}] ${tool.description || tool.title || tool.name}`.slice(0, 1000),
        inputSchema: tool.inputSchema?.type === "object" ? tool.inputSchema : { type: "object", properties: {} },
        requiresApproval: true,
        sensitive: "external_tool",
        approvalDetails: (args) => ({ tool: tool.title || tool.name, connector: connection.name, arguments: args }),
        execute: async (args) => {
          const current = read().find((item) => item.id === connection.id) || connection;
          const result = await call<{ isError?: boolean; text?: string }>(current, { action: "call", tool: tool.name, arguments: args });
          if (result.isError) throw new Error(result.text || `${tool.name} reported an error.`);
          return { message: result.text || "Done." };
        },
      });
    }
  }
  return tools;
}

export function installConnectorTools(connections = read()) {
  setExternalTools(connectorTools(connections), "connectors");
}
