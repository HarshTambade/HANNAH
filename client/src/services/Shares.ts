/**
 * Shared conversation links (server/shares.js).
 *
 * Chat history stays on this device. Sharing uploads a copy of only the
 * messages the person ticked, when they press Publish; the server keeps that
 * snapshot at /s/<id> until they delete the link. Memories, tool results and
 * file contents are never part of it; research sources and attachment names
 * only when they opt in. The server masks anything that looks like a key or
 * password again, whatever is sent.
 */
import type { ChatMessage } from "../types";
import { accountRequest } from "./Account";

export type SharedLink = { id: string; url: string; title: string; messageCount: number; createdAt: number };
export type ShareInclude = { sources: boolean; attachments: boolean };
export type SharePayloadMessage = { role: "user" | "assistant"; content: string; sources?: Array<{ url: string; title: string } | null>; attachments?: string[] };
export type SharePayload = { title: string; include: ShareInclude; messages: SharePayloadMessage[] };

/** Lookups for the opt-in extras: a research answer's sources by number, and file names by id. */
export type ShareExtras = {
  sourcesFor?: (researchId: string) => Record<number, { url: string; title: string }> | undefined;
  fileName?: (fileId: string) => string | undefined;
};

/** Messages that can be shared: yours and HANNAH's replies with text (never status or tool lines). */
export function shareableMessages(messages: ChatMessage[]) {
  return messages.filter((message): message is ChatMessage & { role: "user" | "assistant" } => (message.role === "user" || message.role === "assistant") && Boolean(message.content.trim()));
}

/** What is uploaded: only the chosen messages, and extras only when opted in. Exported for tests. */
export function buildSharePayload(messages: ChatMessage[], chosen: (message: ChatMessage, index: number) => boolean, title: string, include: ShareInclude, extras: ShareExtras = {}): SharePayload {
  const picked = shareableMessages(messages).filter(chosen);
  return {
    title: title.trim().slice(0, 120),
    include,
    messages: picked.map((message) => {
      const item: SharePayloadMessage = { role: message.role, content: message.content };
      const researchId = message.studio?.researchId;
      if (include.sources && researchId && extras.sourcesFor) {
        const byNumber = extras.sourcesFor(researchId);
        const numbers = Object.keys(byNumber ?? {}).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 30);
        if (byNumber && numbers.length) item.sources = Array.from({ length: Math.max(...numbers) }, (_, index) => byNumber[index + 1] ?? null);
      }
      const fileIds = message.studio?.fileIds ?? [];
      if (include.attachments && fileIds.length && extras.fileName) {
        const names = fileIds.map((id) => extras.fileName!(id)).filter((name): name is string => Boolean(name));
        if (names.length) item.attachments = names;
      }
      return item;
    }),
  };
}

export const Shares = {
  async create(payload: SharePayload) {
    return accountRequest<SharedLink & { include: ShareInclude }>("/api/account/shares", { method: "POST", body: JSON.stringify(payload) });
  },
  async list() {
    return (await accountRequest<{ shares: SharedLink[] }>("/api/account/shares")).shares;
  },
  /** Delete the link: the page stops working at once. */
  async revoke(id: string) {
    await accountRequest(`/api/account/shares/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
};
