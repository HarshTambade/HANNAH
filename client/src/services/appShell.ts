import { Capacitor } from "@capacitor/core";
import { getDesktopBridge } from "./DesktopBridge";

/** True inside the Android/iOS app (Capacitor) or the desktop app (Electron), false on the website. */
export function isNativeShell(): boolean {
  try {
    if (Capacitor.isNativePlatform()) return true;
  } catch {
    // Capacitor not available: the website.
  }
  return Boolean(getDesktopBridge());
}

/** Unregister every service worker for this origin. Resolves to how many were removed; never throws. */
export async function removeServiceWorkers(container: Pick<ServiceWorkerContainer, "getRegistrations"> | undefined = typeof navigator === "undefined" ? undefined : navigator.serviceWorker): Promise<number> {
  if (!container) return 0;
  try {
    const registrations = await container.getRegistrations();
    const results = await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
    return results.filter(Boolean).length;
  } catch {
    return 0;
  }
}
