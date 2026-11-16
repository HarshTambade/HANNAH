/**
 * HANNAH's public website, which also serves its API (/api) and download
 * links (/download/…). The desktop and mobile apps use it as their server
 * unless a build sets VITE_API_BASE_URL; set VITE_SITE_URL to point a build at
 * another deployment.
 */
import { Capacitor } from "@capacitor/core";

export const DEFAULT_SITE_URL = "https://hannah.eliteforums.in";

export const SITE_URL = (import.meta.env.VITE_SITE_URL?.trim() || DEFAULT_SITE_URL).replace(/\/+$/, "");

/** True on the website (any browser); false in the desktop and mobile apps. */
export const IS_WEBSITE = (() => {
  try {
    return typeof Capacitor?.getPlatform !== "function" || Capacitor.getPlatform() === "web";
  } catch {
    return true;
  }
})();
