export type CredentialScope = "llm_provider" | "tts" | "sync";

const STORE_KEY = "hannah.credentials.v1";

export const CredentialBroker = {
  store(scope: CredentialScope, value: string) {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(STORE_KEY) || "{}");
      parsed[scope] = value;
      window.localStorage.setItem(STORE_KEY, JSON.stringify(parsed));
    } catch {
      // Best effort.
    }
  },
  get(scope: CredentialScope): string | null {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(STORE_KEY) || "{}");
      return typeof parsed[scope] === "string" ? parsed[scope] : null;
    } catch {
      return null;
    }
  },
  clear(scope: CredentialScope) {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(STORE_KEY) || "{}");
      delete parsed[scope];
      window.localStorage.setItem(STORE_KEY, JSON.stringify(parsed));
    } catch {
      // Best effort.
    }
  },
  inject(headers: Record<string, string>, scope: CredentialScope) {
    const value = this.get(scope);
    if (value) headers.Authorization = `Bearer ${value}`;
    return headers;
  },
  redact(text: string) {
    return text.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]");
  },
};