export const PresenceManifestationManager = {
  surfaces: ["mobile", "desktop", "earbuds", "display"] as string[],
  manifest(surface: string) {
    return { surface, identity: "Shanaya", state: "active" };
  },
};