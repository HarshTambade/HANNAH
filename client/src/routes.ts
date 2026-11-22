/**
 * HANNAH's URL routes.
 *
 * Every screen has a real path (/chat, /models, …), so the address bar never
 * shows internal "#/…" identifiers, refresh and direct links work, and the
 * browser's (and Android's) back button walks the app's history. The build
 * writes an index.html for each path (see scripts/appRoutesPlugin.ts) so
 * static hosts, Capacitor and Electron all serve the app at that URL.
 *
 * Old "#/chat"-style links still work: they're rewritten to the path on load.
 * Plain "#section" anchors on the landing page are left alone.
 */
export type AppScreen =
  | "landing"
  | "conversation"
  | "companion"
  | "agents"
  | "models"
  | "accountability"
  | "automations"
  | "settings"
  | "integrations"
  | "marketplace"
  | "actions"
  | "robotics"
  | "devices";

export type Screen = AppScreen | "not-found";

export const ROUTE_PATHS: Record<AppScreen, string> = {
  landing: "/",
  conversation: "/chat",
  companion: "/dashboard",
  agents: "/agents",
  models: "/models",
  accountability: "/memory",
  automations: "/automations",
  settings: "/settings",
  integrations: "/integrations",
  marketplace: "/marketplace",
  actions: "/actions",
  robotics: "/robotics",
  devices: "/devices",
};

export const ROUTE_TITLES: Record<Screen, string> = {
  landing: "HANNAH — Your Personal AI",
  conversation: "Chat · HANNAH",
  companion: "Dashboard · HANNAH",
  agents: "Agents · HANNAH",
  models: "Models · HANNAH",
  accountability: "Memory & style · HANNAH",
  automations: "Automations · HANNAH",
  settings: "Settings · HANNAH",
  integrations: "Integrations · HANNAH",
  marketplace: "Marketplace · HANNAH",
  actions: "Actions · HANNAH",
  robotics: "Robots · HANNAH",
  devices: "Devices · HANNAH",
  "not-found": "Page not found · HANNAH",
};

/** App paths other than "/", for the build to emit an index.html each. */
export const APP_ROUTE_PATHS = Object.values(ROUTE_PATHS).filter((path) => path !== "/");

/** Older names some links used; they open the current screen. */
const ALIASES: Record<string, AppScreen> = { "/conversation": "conversation", "/home": "landing", "/workflows": "automations", "/tasks": "agents", "/permissions": "actions", "/code": "actions", "/robots": "robotics", "/hardware": "devices", "/iot": "devices", "/connectors/callback": "marketplace" };

/** Extra pages the build emits (an index.html each) that open another screen: a connector's sign-in returns to /connectors/callback. */
export const EXTRA_PAGE_PATHS: Record<string, AppScreen> = { "/connectors/callback": "marketplace" };

function normalizePath(pathname: string, base = "/") {
  let path = pathname;
  const prefix = base.endsWith("/") ? base.slice(0, -1) : base;
  if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length) || "/";
  path = path.replace(/\/index\.html$/, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path || "/";
}

/** The screen for a location. Legacy "#/route" hashes win over the path. */
export function screenForLocation(location: Pick<Location, "pathname" | "hash">, base = "/"): Screen {
  if (location.hash.startsWith("#/")) {
    const legacy = normalizePath(location.hash.slice(1));
    return screenForPath(legacy) ?? "not-found";
  }
  return screenForPath(normalizePath(location.pathname, base)) ?? "not-found";
}

function screenForPath(path: string): AppScreen | null {
  const match = (Object.entries(ROUTE_PATHS) as Array<[AppScreen, string]>).find(([, value]) => value === path);
  return match?.[0] ?? ALIASES[path] ?? null;
}

/** Full URL path for a screen, including the deployment base. */
export function pathForScreen(screen: AppScreen, base = "/") {
  const prefix = base.endsWith("/") ? base.slice(0, -1) : base;
  const path = ROUTE_PATHS[screen];
  return path === "/" ? `${prefix}/` : `${prefix}${path}`;
}

/**
 * If the URL uses a legacy "#/route", the path to replace it with (keeping the
 * query string); otherwise null.
 */
export function legacyHashRedirect(location: Pick<Location, "pathname" | "hash" | "search">, base = "/") {
  if (!location.hash.startsWith("#/")) return null;
  const screen = screenForLocation(location, base);
  return screen === "not-found" ? null : `${pathForScreen(screen, base)}${location.search}`;
}
