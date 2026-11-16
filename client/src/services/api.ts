const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, "") || "";
const TOKEN_KEY = "hannah.session.apiToken";
const GROQ_KEY = "hannah.session.groqKey";

// Credentials live in sessionStorage: they survive a page refresh but are
// cleared when this browser tab closes and are never shared with other tabs.
function readSession(key: string) {
  try {
    return window.sessionStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeSession(key: string, value: string) {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Private browsing can block storage; the value still lives in memory.
  }
}

let apiAccessToken = readSession(TOKEN_KEY);
let groqApiKey = readSession(GROQ_KEY);

export function setApiAccessToken(token: string) {
  apiAccessToken = token.trim();
  writeSession(TOKEN_KEY, apiAccessToken);
}

export function getApiAccessToken() {
  return apiAccessToken;
}

export function setSessionGroqKey(key: string) {
  groqApiKey = key.trim();
  writeSession(GROQ_KEY, groqApiKey);
}

export function getSessionGroqKey() {
  return groqApiKey;
}

export function clearApiSession() {
  setApiAccessToken("");
  setSessionGroqKey("");
}

const GROQ_KEY_PATTERN = /^gsk_[A-Za-z0-9]{20,200}$/;

/** True for a value shaped like a Groq API key (gsk_…). */
export function isGroqKey(value: string) {
  return GROQ_KEY_PATTERN.test(value.trim());
}

/** Connected either with the operator's access token or with the visitor's own Groq key. */
export function hasApiSession() {
  return apiAccessToken.length >= 32 || isGroqKey(groqApiKey);
}

/** Guest (bring-your-own-key) session: no operator token, only a Groq key. */
export function isGuestSession() {
  return !apiAccessToken && isGroqKey(groqApiKey);
}

export function apiHeaders(init?: HeadersInit) {
  const headers = new Headers(init);
  if (apiAccessToken) headers.set("Authorization", "Bearer " + apiAccessToken);
  // Guests authenticate with their own Groq key, which the server forwards only to Groq.
  else if (isGroqKey(groqApiKey) && !headers.has("X-Groq-API-Key")) headers.set("X-Groq-API-Key", groqApiKey);
  return headers;
}

export function apiUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return apiBaseUrl ? `${apiBaseUrl}${normalizedPath}` : normalizedPath;
}

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  return fetch(input, { ...init, headers: apiHeaders(init.headers) });
}

export function isLocalDevelopmentHost() {
  try {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);
  } catch {
    return false;
  }
}

export type ApiAccessResult =
  | { ok: true }
  | { ok: false; reason: "unauthorized" | "not-configured" | "unreachable" | "error"; message: string };

function unreachable(): ApiAccessResult {
  return {
    ok: false,
    reason: "unreachable",
    message: isLocalDevelopmentHost()
      ? "Could not reach the HANNAH API. Start it with npm run dev from the project root."
      : "Could not reach the HANNAH server. Check your connection and try again.",
  };
}

/**
 * Confirms the server accepts these credentials before the app opens.
 * With a token, the token is checked; with only a Groq key, Groq itself is
 * asked (through the server) whether it accepts the key.
 */
export async function verifyApiAccess({ token = "", groqKey = "" }: { token?: string; groqKey?: string }): Promise<ApiAccessResult> {
  const trimmedToken = token.trim();
  const trimmedKey = groqKey.trim();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (trimmedToken) headers.Authorization = `Bearer ${trimmedToken}`;
  if (trimmedKey) headers["X-Groq-API-Key"] = trimmedKey;
  const path = trimmedToken ? "/api/providers" : "/api/models?provider=groq";

  let response: Response;
  try {
    response = await fetch(apiUrl(path), { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    return unreachable();
  }
  if (response.ok) return { ok: true };
  const body = await response.json().catch(() => ({})) as { reason?: string };
  if (response.status === 401 && body.reason === "groq-key-rejected") {
    return { ok: false, reason: "unauthorized", message: "Groq didn't accept that key. Copy it again from console.groq.com/keys and paste the whole value." };
  }
  if (response.status === 401) {
    return trimmedToken
      ? { ok: false, reason: "unauthorized", message: "That access token was not accepted. Check it with your server operator." }
      : { ok: false, reason: "unauthorized", message: "This HANNAH server only accepts its operator's access token. Open “I have an access token” and enter it, or use a server that allows your own key." };
  }
  if (response.status === 503) {
    return { ok: false, reason: "not-configured", message: "This server has no access token configured yet. Connect with your Groq key instead." };
  }
  return { ok: false, reason: "error", message: `The HANNAH server returned an error (HTTP ${response.status}). Try again shortly.` };
}
