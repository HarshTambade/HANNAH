export type PersonalizationFeedback = "liked" | "accepted" | "edited" | "rejected";

export type PersonalizationInteraction = {
  id: string;
  prompt: string;
  response: string;
  feedback: PersonalizationFeedback;
  editedResponse?: string;
  at: number;
};

const STORAGE_KEY = "shanaya.personalization.v1";
const MAX_INTERACTIONS = 200;
const MAX_FIELD_CHARS = 2_000;

function clean(value: string) {
  return value.trim().slice(0, MAX_FIELD_CHARS);
}

function read(): PersonalizationInteraction[] {
  try {
    const items: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is PersonalizationInteraction =>
      item && typeof item.id === "string" && typeof item.prompt === "string" &&
      typeof item.response === "string" &&
      ["liked", "accepted", "edited", "rejected"].includes(item.feedback) &&
      typeof item.at === "number",
    ).slice(-MAX_INTERACTIONS);
  } catch {
    return [];
  }
}

function write(items: PersonalizationInteraction[]) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(-MAX_INTERACTIONS))); } catch { /* Device storage can be unavailable. */ }
}

export const PersonalizationEngine = {
  record(input: Omit<PersonalizationInteraction, "at">) {
    const items = read().filter((item) => item.id !== input.id);
    const entry: PersonalizationInteraction = {
      ...input,
      prompt: clean(input.prompt),
      response: clean(input.response),
      ...(input.editedResponse ? { editedResponse: clean(input.editedResponse) } : {}),
      at: Date.now(),
    };
    write([...items, entry]);
    return entry;
  },
  list() { return read(); },
  rated() { return read().filter((item) => item.feedback === "liked" || item.feedback === "accepted" || item.feedback === "edited"); },
  clear() { try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* Best effort. */ } },
  exportJsonl() {
    return this.rated().map((item) => JSON.stringify({
      messages: [
        { role: "user", content: item.prompt },
        { role: "assistant", content: item.editedResponse || item.response },
      ],
    })).join("\n");
  },
};
