import { MemoryService } from "./MemoryService";
import { CognitiveReadinessEngine } from "./CognitiveReadinessEngine";

const MAX_MEMORIES_PER_DOMAIN = 50;

export type DreamLogEntry = {
  id: string;
  action: "consolidated" | "corrected" | "discarded";
  content: string;
  domain: string;
  at: number;
};

const DREAM_LOG_KEY = "shanaya.dreamlog.v1";

function readDreamLog(): DreamLogEntry[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DREAM_LOG_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeDreamLog(log: DreamLogEntry[]) {
  try {
    window.localStorage.setItem(DREAM_LOG_KEY, JSON.stringify(log.slice(-500)));
  } catch {
    // Best effort.
  }
}

export const DreamingConsolidator = {
  running: false,
  async start() {
    if (this.running) return;
    this.running = true;
    try {
      // Consolidate only when the readiness service reports an idle window.
      const idle = await CognitiveReadinessEngine.readiness();
      if (idle === "fatigued" || idle === "busy") return;
      await this.consolidate();
    } finally {
      this.running = false;
    }
  },
  async consolidate() {
    const sessions = MemoryService.list("session").slice(-20);
    const log: DreamLogEntry[] = readDreamLog();
    const domainCounts = new Map<string, number>();
    for (const m of MemoryService.list("long_term")) {
      domainCounts.set(m.content.slice(0, 20), (domainCounts.get(m.content.slice(0, 20)) || 0) + 1);
    }

    for (const session of sessions) {
      const content = session.content.trim();
      if (content.length < 20) {
        log.push({ id: crypto.randomUUID(), action: "discarded", content, domain: "session", at: Date.now() });
        continue;
      }
      const durable = content.length > 80 ? "strategy" : "observation";
      if (durable === "observation" && Math.random() > 0.3) {
        log.push({ id: crypto.randomUUID(), action: "discarded", content, domain: "session", at: Date.now() });
        continue;
      }
      const domain = durable === "strategy" ? "strategy" : "observation";
      if ((domainCounts.get(domain) || 0) >= MAX_MEMORIES_PER_DOMAIN) {
        log.push({ id: crypto.randomUUID(), action: "discarded", content, domain, at: Date.now() });
        continue;
      }
      MemoryService.add("long_term", content, durable === "strategy" ? 3 : 1);
      domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
      log.push({ id: crypto.randomUUID(), action: "consolidated", content, domain, at: Date.now() });
    }

    writeDreamLog(log);
    return log;
  },
  getLog(): DreamLogEntry[] {
    return readDreamLog();
  },
};
