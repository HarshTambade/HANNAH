const KEY = "hannah.emotional.v1";

export const EmotionalStateModel = {
  track(sentiment: number, source: string) {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(KEY) || "[]");
      const entries = Array.isArray(parsed) ? parsed : [];
      entries.push({ sentiment, source, at: Date.now() });
      window.localStorage.setItem(KEY, JSON.stringify(entries.slice(-200)));
    } catch {
      // Best effort.
    }
  },
  trajectory(days = 7) {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(KEY) || "[]");
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      return Array.isArray(parsed) ? parsed.filter((e) => e.at >= cutoff) : [];
    } catch {
      return [];
    }
  },
};