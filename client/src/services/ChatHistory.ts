import type { ChatMessage } from "../types";

const STORAGE_KEY = "hannah.chat.history.v1";
const MAX_MESSAGES = 200;
export const CHAT_HISTORY_EVENT = "hannah:chat-history";

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as ChatMessage;
  return (item.role === "user" || item.role === "assistant" || item.role === "system")
    && typeof item.content === "string";
}

/** Conversation history kept on this device so a refresh does not wipe the chat. */
export const ChatHistory = {
  load(): ChatMessage[] {
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter(isMessage).slice(-MAX_MESSAGES) : [];
    } catch {
      return [];
    }
  },
  save(messages: ChatMessage[]) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_MESSAGES)));
      window.dispatchEvent(new Event(CHAT_HISTORY_EVENT));
    } catch {
      // Storage can be full or disabled; the chat keeps working in memory.
    }
  },
  clear() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.dispatchEvent(new Event(CHAT_HISTORY_EVENT));
    } catch {
      // Best effort.
    }
  },
};

/** The id of the last message when it's yours with no reply after it (HANNAH was interrupted), else null. */
export function interruptedMessageId(messages: ChatMessage[]): string | null {
  const last = [...messages].reverse().find((message) => message.role !== "system");
  return last?.role === "user" && last.id ? last.id : null;
}
