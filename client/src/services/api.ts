const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, "") || "";
let apiAccessToken = "";

export function setApiAccessToken(token: string) {
  apiAccessToken = token.trim();
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
