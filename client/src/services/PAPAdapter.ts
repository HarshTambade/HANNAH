/**
 * PAP: services that publish an agent profile at /.well-known/pap.json (their
 * capabilities, OAuth endpoints and an actions endpoint), so HANNAH can act
 * there with the person's consent.
 *
 * Sign-in is OAuth 2.0 authorization code with PKCE (S256), as a public
 * client: the verifier stays in this tab (sessionStorage) and the state is
 * checked on the way back; the code is exchanged at the service's token
 * endpoint for a real access token. An action is sent only with
 * `confirmed: true` (the caller's approval), with that token, and the
 * service's own answer is returned.
 */
export type PAPProfile = {
  domain: string;
  name: string;
  capabilities: string[];
  clientId: string;
  actionsEndpoint: string;
  oauth: {
    authorization_endpoint: string;
    token_endpoint: string;
    scopes_supported: string[];
  };
};

export type PAPSession = {
  domain: string;
  accessToken: string | null;
  refreshToken?: string | null;
  scope: string[];
  expiresAt: number | null;
  createdAt: number;
};

const KEY = "hannah.pap.sessions.v1";
const PENDING_KEY = "hannah.pap.pending.v1";

function readSessions(): PAPSession[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSessions(sessions: PAPSession[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(sessions.slice(0, 200)));
  } catch {
    // Best effort.
  }
}

type Pending = { state: string; verifier: string; domain: string; scope: string[]; redirectUri: string; at: number };
function readPending(): Pending[] {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(PENDING_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function writePending(pending: Pending[]) {
  try {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending.filter((item) => Date.now() - item.at < 10 * 60_000).slice(-10)));
  } catch {
    // Without storage the sign-in can't be completed in this tab.
  }
}

const base64url = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function challengeFor(verifier: string) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
const httpsOnly = (url: string, label: string) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`The service's ${label} must use https.`);
  return parsed.toString();
};

export const PAPAdapter = {
  async discover(domain: string, { fetchImpl = (...args: Parameters<typeof fetch>) => fetch(...args) }: { fetchImpl?: typeof fetch } = {}): Promise<PAPProfile | null> {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return null;
    try {
      const response = await fetchImpl(`https://${domain}/.well-known/pap.json`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const data = await response.json();
      return {
        domain,
        name: data.name || domain,
        capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
        clientId: typeof data.client_id === "string" && data.client_id ? data.client_id : "hannah",
        actionsEndpoint: httpsOnly(data.actions_endpoint || `https://${domain}/pap/actions`, "actions endpoint"),
        oauth: {
          authorization_endpoint: httpsOnly(data.oauth?.authorization_endpoint || `https://${domain}/oauth/authorize`, "sign-in page"),
          token_endpoint: httpsOnly(data.oauth?.token_endpoint || `https://${domain}/oauth/token`, "token endpoint"),
          scopes_supported: Array.isArray(data.oauth?.scopes_supported) ? data.oauth.scopes_supported : [],
        },
      };
    } catch {
      return null;
    }
  },

  /** The service's sign-in page address (with a PKCE challenge); open it, and it returns to redirectUri with ?code&state. */
  async beginAuth(domain: string, scope: string[], { fetchImpl, redirectUri = `${window.location.origin}/pap/callback` }: { fetchImpl?: typeof fetch; redirectUri?: string } = {}): Promise<{ url: string; state: string }> {
    const profile = await this.discover(domain, { fetchImpl });
    if (!profile) throw new Error(`No PAP profile found for ${domain}`);
    const state = base64url(crypto.getRandomValues(new Uint8Array(24)));
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
    writePending([...readPending(), { state, verifier, domain, scope, redirectUri, at: Date.now() }]);
    const params = new URLSearchParams({
      client_id: profile.clientId,
      redirect_uri: redirectUri,
      scope: scope.join(" "),
      state,
      response_type: "code",
      code_challenge: await challengeFor(verifier),
      code_challenge_method: "S256",
    });
    return { url: `${profile.oauth.authorization_endpoint}?${params.toString()}`, state };
  },

  /** Finish sign-in: the state must be the one this tab started; the code is exchanged for a token. */
  async completeAuth(domain: string, code: string, state: string, scope: string[], { fetchImpl = (...args: Parameters<typeof fetch>) => fetch(...args) }: { fetchImpl?: typeof fetch } = {}): Promise<PAPSession> {
    const pending = readPending();
    const started = pending.find((item) => item.state === state && item.domain === domain);
    if (!state || !started) throw new Error("This sign-in wasn't started here, or it expired. Start again.");
    writePending(pending.filter((item) => item !== started));
    if (!code) throw new Error("The service didn't return a sign-in code.");
    const profile = await this.discover(domain, { fetchImpl });
    if (!profile) throw new Error(`No PAP profile found for ${domain}`);
    const response = await fetchImpl(profile.oauth.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: started.redirectUri, client_id: profile.clientId, code_verifier: started.verifier }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const token = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
    if (!response.ok || !token.access_token) throw new Error(`${profile.name} didn't accept the sign-in${token.error ? ` (${token.error})` : ""}.`);
    const session: PAPSession = {
      domain,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      scope: token.scope ? token.scope.split(" ") : started.scope.length ? started.scope : scope,
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
      createdAt: Date.now(),
    };
    const sessions = readSessions();
    const existing = sessions.findIndex((s) => s.domain === domain);
    if (existing >= 0) sessions[existing] = session;
    else sessions.push(session);
    writeSessions(sessions);
    return session;
  },

  /**
   * Run an action at the service. Without `confirmed: true` nothing is sent:
   * the caller gets back what would be done, to show the person first.
   */
  async execute(domain: string, action: string, args: Record<string, unknown>, { confirmed = false, fetchImpl = (...args: Parameters<typeof fetch>) => fetch(...args) }: { confirmed?: boolean; fetchImpl?: typeof fetch } = {}) {
    const session = readSessions().find((s) => s.domain === domain && s.accessToken);
    if (!session) throw new Error(`No authenticated PAP session for ${domain}`);
    if (session.expiresAt && session.expiresAt <= Date.now()) throw new Error(`The sign-in to ${domain} expired. Sign in again.`);
    if (!confirmed) return { domain, action, status: "pending_user_confirmation" as const, args };
    const profile = await this.discover(domain, { fetchImpl });
    if (!profile) throw new Error(`No PAP profile found for ${domain}`);
    const response = await fetchImpl(profile.actionsEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ action, args }),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${profile.name} refused “${action}” (${response.status}).`);
    return { domain, action, status: "done" as const, args, result };
  },

  listSessions() {
    return readSessions();
  },
  revoke(domain: string) {
    const sessions = readSessions().filter((s) => s.domain !== domain);
    writeSessions(sessions);
  },
};
