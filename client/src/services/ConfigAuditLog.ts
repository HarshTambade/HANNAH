const KEY = "shanaya.configAudit.v1";

export const ConfigAuditLog = {
  record(section: string, diff: unknown) {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(KEY) || "[]");
      const entries = Array.isArray(parsed) ? parsed : [];
      entries.push({ section, diff, at: Date.now() });
      window.localStorage.setItem(KEY, JSON.stringify(entries.slice(-200)));
    } catch {
      // Best effort.
    }
  },
  list() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  },
};