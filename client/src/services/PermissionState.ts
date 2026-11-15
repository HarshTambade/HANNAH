const STORAGE_KEY = "shanaya.permissions.v1";

export const PermissionState = {
  revoked: new Set<string>(),
  revoke(permission: string) {
    this.revoked.add(permission);
    try {
      const current = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
      const set = new Set(Array.isArray(current) ? current : []);
      set.add(permission);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
    } catch {
      // Best effort.
    }
  },
  isRevoked(permission: string) {
    if (this.revoked.has(permission)) return true;
    try {
      const current = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(current) && current.includes(permission);
    } catch {
      return false;
    }
  },
  // Monotonic attenuation: a revoked permission cannot be re-granted in-session.
  grant(permission: string) {
    if (this.isRevoked(permission)) throw new Error(`Permission ${permission} is revoked and requires new explicit approval.`);
    return true;
  },
  resetSession() {
    this.revoked.clear();
  },
};