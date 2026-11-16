/**
 * Capawesome Live Updates (OTA) integration.
 *
 * The plugin is optional at build time; this module no-ops when it is not
 * installed so web/desktop builds keep working.
 */
export async function checkForLiveUpdate(): Promise<void> {
  try {
    const module = await import("@capawesome/capacitor-live-update");
    const LiveUpdate = module.LiveUpdate;
    const result = await LiveUpdate.sync();
    if (result?.nextBundleId) {
      await LiveUpdate.reload();
    }
  } catch {
    // Live updates are only available in native Capacitor builds.
  }
}
