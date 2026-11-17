import { IS_WEBSITE, SITE_URL } from "../config/site";
import { Diagnostics } from "./Diagnostics";

/**
 * Where the HANNAH API lives. The website calls its own domain (on Vercel the
 * API is part of the same deployment). The desktop and mobile apps have no
 * domain of their own, so they call the HANNAH website unless the build says otherwise.
 */
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL?.trim() || (IS_WEBSITE ? "" : SITE_URL)).replace(/\/+$/, "");

/** The API base this build uses ("" means the page's own origin). */
export function apiBase() {
  return apiBaseUrl;
}
const TOKEN_KEY = "hannah.session.apiToken";
const GROQ_KEY = "hannah.session.groqKey";

// On the website, credentials live in sessionStorage: they survive a page
// refresh but are cleared when the tab closes and aren't shared with other
// tabs. The desktop and mobile apps have no tabs; there they live in the app's
// own private storage, so you don't have to connect again on every launch, and
// Disconnect (or signing out) clears them.
function credentialStore() {
  return IS_WEBSITE ? window.sessionStorage : window.localStorage;
}

function readSession(key: string) {
  try {
    return credentialStore().getItem(key) || "";
  } catch {
    return "";
  }
}

function writeSession(key: string, value: string) {
  try {
    if (value) credentialStore().setItem(key, value);
    else credentialStore().removeItem(key);
  } catch {
    // Private browsing can block storage; the value still lives in memory.
  }
}

let apiAccessToken = readSession(TOKEN_KEY);
let groqApiKey = readSession(GROQ_KEY);

// Account session. On the web the session is an HttpOnly cookie the app can't
// read, so only a "signed in as" hint is kept here. Native apps and builds that
// call a different API origin can't use the cookie and keep the session token
// (hs_…, never a provider key) instead.
const ACCOUNT_KEY = "hannah.account.v1";
export const ACCOUNT_EVENT = "hannah:account";
export type AccountHint = { email: string; displayName?: string; sessionToken?: string };

function readAccount(): AccountHint | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ACCOUNT_KEY) || "null") as AccountHint | null;
    return parsed && typeof parsed.email === "string" ? parsed : null;
  } catch {
    return null;
  }
}

let accountHint = readAccount();

export function getAccountHint() {
  return accountHint;
}

export function setAccountHint(value: AccountHint | null) {
  accountHint = value;
  try {
    if (value) window.localStorage.setItem(ACCOUNT_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // Storage blocked: the hint lives in memory for this page.
  }
  try {
    window.dispatchEvent(new Event(ACCOUNT_EVENT));
  } catch {
    // No window events in some environments.
  }
}

/** True when the API is on another origin, so the session cookie can't be used. */
export function usesBearerSession() {
  if (!apiBaseUrl) return false;
  try {
    return new URL(apiBaseUrl, window.location.href).origin !== window.location.origin;
  } catch {
    return true;
  }
}

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
  setAccountHint(null);
}

const GROQ_KEY_PATTERN = /^gsk_[A-Za-z0-9]{20,200}$/;

/** True for a value shaped like a Groq API key (gsk_…). */
export function isGroqKey(value: string) {
  return GROQ_KEY_PATTERN.test(value.trim());
}

/** Connected with the operator's access token, a signed-in account, or the visitor's own Groq key. */
export function hasApiSession() {
  return apiAccessToken.length >= 32 || Boolean(accountHint) || isGroqKey(groqApiKey);
}

/** Guest (bring-your-own-key) session: no operator token or account, only a Groq key. */
export function isGuestSession() {
  return !apiAccessToken && !accountHint && isGroqKey(groqApiKey);
}

/** Signed in to an account on this server. */
export function isAccountSession() {
  return !apiAccessToken && Boolean(accountHint);
}

export function apiHeaders(init?: HeadersInit) {
  const headers = new Headers(init);
  if (apiAccessToken) headers.set("Authorization", "Bearer " + apiAccessToken);
  else if (accountHint?.sessionToken && !headers.has("Authorization")) headers.set("Authorization", "Bearer " + accountHint.sessionToken);
  // A Groq key from this tab is sent alongside an account session too; the
  // server forwards it only to Groq.
  if (!apiAccessToken && isGroqKey(groqApiKey) && !headers.has("X-Groq-API-Key")) headers.set("X-Groq-API-Key", groqApiKey);
  return headers;
}

export function apiUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return apiBaseUrl ? `${apiBaseUrl}${normalizedPath}` : normalizedPath;
}

/** The request's path for a diagnostic entry: never its query string or body. */
function describeRequest(input: RequestInfo | URL) {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(url, typeof window === "undefined" ? "http://localhost" : window.location.origin).pathname;
  } catch {
    return "the server";
  }
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  try {
    const response = await fetch(input, { ...init, headers: apiHeaders(init.headers) });
    if (response.status >= 500) Diagnostics.log("warn", "network", `The server answered ${response.status} for ${describeRequest(input)}.`);
    return response;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    Diagnostics.log(timedOut ? "warn" : "error", "network", timedOut ? `${describeRequest(input)} didn't answer in time.` : `Couldn't reach ${describeRequest(input)}.`);
    throw error;
  }
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
