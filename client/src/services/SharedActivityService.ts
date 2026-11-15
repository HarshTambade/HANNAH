import { trackEvent } from "./events";

export type SharedActivityType = "co_browsing" | "co_coding" | "co_system_operation";

export type SharedActivitySession = {
  id: string;
  type: SharedActivityType;
  startedAt: string;
  endedAt?: string;
  durationSeconds?: number;
  completed: boolean;
};

const STORAGE_KEY = "shanaya.sharedActivity.v1";
const MAX_SESSIONS = 200;

function readSessions(): SharedActivitySession[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSessions(sessions: SharedActivitySession[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
  } catch {
    // Best effort.
  }
}

export const SharedActivityService = {
  start(type: SharedActivityType): string {
    const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `activity-${Date.now()}`;
    const session: SharedActivitySession = {
      id,
      type,
      startedAt: new Date().toISOString(),
      completed: false,
    };
    const sessions = [session, ...readSessions()];
    writeSessions(sessions);
    trackEvent("chat_opened", { activity: type });
    return id;
  },

  end(id: string, completed: boolean) {
    const sessions = readSessions();
    const index = sessions.findIndex((session) => session.id === id);
    if (index < 0) return;
    const startedAt = new Date(sessions[index].startedAt).getTime();
    sessions[index] = {
      ...sessions[index],
      endedAt: new Date().toISOString(),
      durationSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      completed,
    };
    writeSessions(sessions);
    trackEvent(completed ? "tool_confirmation_approved" : "tool_confirmation_rejected", { activity: sessions[index].type });
  },

  list(): SharedActivitySession[] {
    return readSessions();
  },

  summary() {
    const sessions = readSessions();
    return {
      total: sessions.length,
      completed: sessions.filter((session) => session.completed).length,
      byType: sessions.reduce<Record<string, number>>((accumulator, session) => {
        accumulator[session.type] = (accumulator[session.type] || 0) + 1;
        return accumulator;
      }, {}),
    };
  },
};