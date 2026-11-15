export const PAPAdapter = {
  async discover(domain: string) {
    try {
      const response = await fetch(`https://${domain}/.well-known/pap.json`);
      if (!response.ok) return null;
      return response.json();
    } catch {
      return null;
    }
  },
  async authenticate(domain: string, scope: string) {
    // OAuth scaffold; requires user approval.
    return { domain, scope, token: "pap-token-placeholder" };
  },
  async execute(action: string, args: Record<string, unknown>) {
    return { action, args, status: "pending_confirmation" };
  },
};