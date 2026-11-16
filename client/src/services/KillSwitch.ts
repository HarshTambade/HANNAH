const KEY = "hannah.killswitch.v1";

export const KillSwitch = {
  active: false,
  activate(reason: string) {
    this.active = true;
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ active: true, reason, at: Date.now() }));
    } catch {
      // Best effort.
    }
  },
  deactivate() {
    this.active = false;
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      // Best effort.
    }
  },
  isActive() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(KEY) || "null");
      return Boolean(parsed?.active) || this.active;
    } catch {
      return this.active;
    }
  },
};