export type PAPProfile = {
  domain: string;
  name: string;
  capabilities: string[];
  oauth: {
    authorization_endpoint: string;
    token_endpoint: string;
    scopes_supported: string[];
  };
};

export type PAPSession = {
  domain: string;
  accessToken: string | null;
  scope: string[];
  expiresAt: number | null;
  createdAt: number;
};

const KEY = "hannah.pap.sessions.v1";

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

export const PAPAdapter = {
  async discover(domain: string): Promise<PAPProfile | null> {
    try {
      const response = await fetch(`https://${domain}/.well-known/pap.json`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      const data = await response.json();
      return {
        domain,
        name: data.name || domain,
        capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
        oauth: {
          authorization_endpoint: data.oauth?.authorization_endpoint || `https://${domain}/oauth/authorize`,
          token_endpoint: data.oauth?.token_endpoint || `https://${domain}/oauth/token`,
          scopes_supported: Array.isArray(data.oauth?.scopes_supported) ? data.oauth.scopes_supported : [],
        },
      };
    } catch {
      return null;
    }
  },
  async beginAuth(domain: string, scope: string[]): Promise<{ url: string; state: string }> {
    const profile = await this.discover(domain);
    if (!profile) throw new Error(`No PAP profile found for ${domain}`);
    const state = crypto.randomUUID();
    const params = new URLSearchParams({
      client_id: "hannah-client",
      redirect_uri: `${window.location.origin}/pap/callback`,
      scope: scope.join(" "),
      state,
      response_type: "code",
    });
    const url = `${profile.oauth.authorization_endpoint}?${params.toString()}`;
    return { url, state };
  },
  async completeAuth(domain: string, code: string, state: string, scope: string[]): Promise<PAPSession> {
    if (!state || state.length < 1) throw new Error("Invalid OAuth state.");
    const profile = await this.discover(domain);
    if (!profile) throw new Error(`No PAP profile found for ${domain}`);
    // In a real deployment this would be a server-side token exchange to avoid
    // exposing client secrets. Here we record the granted session scaffold.
    const session: PAPSession = {
      domain,
      accessToken: code, // placeholder: real OAuth would exchange code for token server-side
      scope: scope,
      expiresAt: null,
      createdAt: Date.now(),
    };
    const sessions = readSessions();
    const existing = sessions.findIndex((s) => s.domain === domain);
    if (existing >= 0) sessions[existing] = session;
    else sessions.push(session);
    writeSessions(sessions);
    return session;
  },
  async execute(domain: string, action: string, args: Record<string, unknown>) {
    const sessions = readSessions();
    const session = sessions.find((s) => s.domain === domain && s.accessToken);
    if (!session) throw new Error(`No authenticated PAP session for ${domain}`);
    return {
      domain,
      action,
      status: "pending_user_confirmation",
      args,
      sessionId: crypto.randomUUID(),
    };
  },
  listSessions() {
    return readSessions();
  },
  revoke(domain: string) {
    const sessions = readSessions().filter((s) => s.domain !== domain);
    writeSessions(sessions);
  },
};