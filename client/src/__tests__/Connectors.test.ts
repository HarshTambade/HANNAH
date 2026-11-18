import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("../config/site", () => ({ IS_WEBSITE: true, SITE_URL: "https://hannah.example" }));
vi.mock("../services/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args), apiUrl: (path: string) => path, isLocalDevelopmentHost: () => false, getApiAccessToken: () => "" }));
const setExternalTools = vi.fn();
vi.mock("../services/DeviceTools", () => ({ setExternalTools: (...args: unknown[]) => setExternalTools(...args) }));

function storage() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, String(value)), removeItem: (key: string) => void map.delete(key), map };
}
let local: ReturnType<typeof storage>;
let session: ReturnType<typeof storage>;
const assign = vi.fn();

type Reply = { status?: number; body: unknown };
/** Answer the connector routes in order of the calls the code makes. */
function serve(handler: (path: string, body: Record<string, unknown>) => Reply) {
  apiFetch.mockImplementation(async (path: string, init: RequestInit) => {
    const reply = handler(path, JSON.parse(String(init.body || "{}")));
    return { ok: (reply.status ?? 200) < 400, status: reply.status ?? 200, json: async () => reply.body };
  });
}
const tools = [{ name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: { title: { type: "string" } } }, readOnly: false }, { name: "list_issues", description: "List issues", inputSchema: { type: "object", properties: {} }, readOnly: true }];

beforeEach(() => {
  vi.resetModules();
  apiFetch.mockReset();
  setExternalTools.mockReset();
  assign.mockReset();
  local = storage();
  session = storage();
  vi.stubGlobal("window", { localStorage: local, sessionStorage: session, location: { origin: "https://hannah.example", pathname: "/marketplace", search: "", assign }, dispatchEvent: () => true });
});

const load = () => import("../services/Connectors");

describe("connectors", () => {
  it("connects a service without sign-in, keeps it in this browser, and its tools always need approval", async () => {
    serve((path, body) => {
      expect(path).toBe("/api/connectors/rpc");
      expect(body).toMatchObject({ url: "https://mcp.context7.com/mcp", action: "list" });
      return { body: { tools } };
    });
    const { connect, connectorTools, listConnections } = await load();
    const result = await connect({ id: "context7", name: "Context7", url: "https://mcp.context7.com/mcp", auth: "none" });
    expect("connected" in result && result.connected.tools).toHaveLength(2);
    expect(JSON.parse(local.map.get("hannah.connectors.v1") || "[]")[0]).toMatchObject({ id: "context7", auth: "none" });
    expect(listConnections()).toHaveLength(1);
    const [create, list] = connectorTools();
    expect(create.name).toBe("mcp_c_context7_create_issue");
    expect([create.requiresApproval, create.sensitive]).toEqual([true, "external_tool"]);
    expect(list.description).toContain("read-only");
    expect(setExternalTools).toHaveBeenLastCalledWith(expect.any(Array), "connectors");
  });

  it("signs in with PKCE (S256): the challenge matches the verifier, and the code is exchanged with it", async () => {
    let tokenRequest: Record<string, unknown> = {};
    serve((path, body) => {
      if (path === "/api/connectors/register") {
        expect(body.redirectUri).toBe("https://hannah.example/connectors/callback");
        return { body: { clientId: "client_1", authorizationEndpoint: "https://auth.vendor.example/authorize", resource: "https://mcp.vendor.example/mcp", scope: "read write" } };
      }
      if (path === "/api/connectors/token") { tokenRequest = body; return { body: { accessToken: "at_1", refreshToken: "rt_1", expiresAt: Date.now() + 3_600_000 } }; }
      expect(body.token).toBe("at_1");
      return { body: { tools } };
    });
    const { connect, finishSignIn, listConnections } = await load();
    expect(await connect({ id: "linear", name: "Linear", url: "https://mcp.vendor.example/mcp", auth: "oauth" })).toEqual({ redirecting: true });
    const authorize = new URL(assign.mock.calls[0][0]);
    expect(authorize.origin + authorize.pathname).toBe("https://auth.vendor.example/authorize");
    const pending = JSON.parse(session.map.get("hannah.connectors.pending") || "{}");
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      response_type: "code", client_id: "client_1", redirect_uri: "https://hannah.example/connectors/callback",
      code_challenge: createHash("sha256").update(pending.verifier).digest("base64url"), code_challenge_method: "S256",
      state: pending.state, resource: "https://mcp.vendor.example/mcp", scope: "read write",
    });
    expect(pending.verifier.length).toBeGreaterThanOrEqual(43);

    const connection = await finishSignIn(`?code=code_1&state=${pending.state}`);
    expect(tokenRequest).toMatchObject({ clientId: "client_1", code: "code_1", codeVerifier: pending.verifier, redirectUri: "https://hannah.example/connectors/callback" });
    expect(connection).toMatchObject({ id: "linear", accessToken: "at_1", refreshToken: "rt_1" });
    expect(listConnections()[0].tools).toHaveLength(2);
    expect(session.map.has("hannah.connectors.pending")).toBe(false);
  });

  it("refuses a sign-in that didn't start in this tab, and reports a denied one", async () => {
    serve(() => { throw new Error("no request should be made"); });
    const { finishSignIn } = await load();
    await expect(finishSignIn("?code=x&state=forged")).rejects.toThrow(/didn't start here/);
    session.setItem("hannah.connectors.pending", JSON.stringify({ state: "s1", verifier: "v", target: { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp" }, clientId: "c", at: Date.now() }));
    await expect(finishSignIn("?error=access_denied&state=s1")).rejects.toThrow("You didn't allow Notion.");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token before a call, and asks to sign in again when the refresh is refused", async () => {
    local.setItem("hannah.connectors.v1", JSON.stringify([{ id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", auth: "oauth", clientId: "c1", accessToken: "old", refreshToken: "rt_old", expiresAt: Date.now() - 1000, tools, connectedAt: 1 }]));
    const seen: string[] = [];
    serve((path, body) => {
      seen.push(path === "/api/connectors/token" ? `token:${body.refreshToken}` : `rpc:${body.token}`);
      if (path === "/api/connectors/token") return { body: { accessToken: "new", refreshToken: "rt_new", expiresAt: Date.now() + 3_600_000 } };
      return { body: { isError: false, text: "Created TRK-2" } };
    });
    const { connectorTools, listConnections } = await load();
    const create = connectorTools()[0];
    expect(await create.execute({ title: "A" })).toEqual({ message: "Created TRK-2" });
    expect(seen).toEqual(["token:rt_old", "rpc:new"]);
    expect(listConnections()[0]).toMatchObject({ accessToken: "new", refreshToken: "rt_new" });

    // The service revokes everything: the call is refused and so is the refresh.
    serve((path) => ({ status: 401, body: { error: path.endsWith("token") ? "invalid_grant" : "Linear needs you to sign in again.", reason: "reauth" } }));
    await expect(connectorTools()[0].execute({ title: "B" })).rejects.toThrow(/sign in again/);
    expect(listConnections()[0].needsSignIn).toBe(true);
    expect(connectorTools()).toHaveLength(0);
  });

  it("disconnecting removes the tokens from this browser", async () => {
    local.setItem("hannah.connectors.v1", JSON.stringify([{ id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", auth: "token", accessToken: "github_pat_x", tools, connectedAt: 1 }]));
    const { disconnect, listConnections } = await load();
    disconnect("github");
    expect(listConnections()).toEqual([]);
    expect(local.map.get("hannah.connectors.v1")).not.toContain("github_pat_x");
  });
});
