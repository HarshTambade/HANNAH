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

export function hasApiSession() {
  return apiAccessToken.length >= 32;
}

export function apiHeaders(init?: HeadersInit) {
  const headers = new Headers(init);
  if (apiAccessToken) headers.set("Authorization", "Bearer " + apiAccessToken);
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

/** Confirms the server is reachable and accepts this token before the app opens. */
export async function verifyApiAccess(token: string): Promise<ApiAccessResult> {
  let response: Response;
  try {
    response = await fetch(apiUrl("/api/providers"), {
      headers: { Accept: "application/json", Authorization: `Bearer ${token.trim()}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return {
      ok: false,
      reason: "unreachable",
      message: isLocalDevelopmentHost()
        ? "Could not reach the HANNAH API. Start it with npm run dev from the project root."
        : "Could not reach the HANNAH server. Check your connection and try again.",
    };
  }
  if (response.ok) return { ok: true };
  if (response.status === 401) {
    return { ok: false, reason: "unauthorized", message: "That access token was not accepted. Check it with your server operator." };
  }
  if (response.status === 503) {
    return { ok: false, reason: "not-configured", message: "This server has no access token configured yet. The operator needs to set HANNAH_API_TOKEN." };
  }
  return { ok: false, reason: "error", message: `The HANNAH server returned an error (HTTP ${response.status}). Try again shortly.` };
}
