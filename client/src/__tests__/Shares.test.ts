import { describe, expect, it } from "vitest";
import { buildSharePayload, shareableMessages } from "../services/Shares";
import { isServerPath, APP_ROUTE_PATHS, EXTRA_PAGE_PATHS, LANDING_TAB_PATHS } from "../routes";
import type { ChatMessage } from "../types";

const messages: ChatMessage[] = [
  { id: "1", role: "user", content: "Find hotels in Pune" },
  { role: "system", content: "Using web search…" },
  { id: "2", role: "assistant", content: "Two options [1] [3].", studio: { researchId: "r1", fileIds: ["f1", "f2"] } },
  { id: "3", role: "user", content: "   " },
  { id: "4", role: "user", content: "Thanks" },
];
const extras = {
  sourcesFor: (id: string) => (id === "r1" ? { 1: { url: "https://a.example", title: "A" }, 3: { url: "https://c.example", title: "C" } } : undefined),
  fileName: (id: string) => ({ f1: "plan.docx" } as Record<string, string>)[id],
};

describe("share snapshots", () => {
  it("only offers your messages and HANNAH's replies with text", () => {
    expect(shareableMessages(messages).map((message) => message.id)).toEqual(["1", "2", "4"]);
  });

  it("uploads only the ticked messages and no extras unless opted in", () => {
    const payload = buildSharePayload(messages, (_message, index) => index !== 2, " Pune hotels ", { sources: false, attachments: false }, extras);
    expect(payload).toEqual({
      title: "Pune hotels",
      include: { sources: false, attachments: false },
      messages: [{ role: "user", content: "Find hotels in Pune" }, { role: "assistant", content: "Two options [1] [3]." }],
    });
    expect(JSON.stringify(payload)).not.toContain("studio");
  });

  it("adds sources by citation number and file names when opted in", () => {
    const payload = buildSharePayload(messages, () => true, "t", { sources: true, attachments: true }, extras);
    expect(payload.messages[1].sources).toEqual([{ url: "https://a.example", title: "A" }, null, { url: "https://c.example", title: "C" }]);
    expect(payload.messages[1].attachments).toEqual(["plan.docx"]);
    expect(payload.messages[0].sources).toBeUndefined();
  });
});

describe("server paths", () => {
  it("keeps shared conversation pages and the API out of the app's routes", () => {
    expect(isServerPath("/s/AbCdEfGhIjKlMnOpQrStUv")).toBe(true);
    expect(isServerPath("/s")).toBe(true);
    expect(isServerPath("/api/health")).toBe(true);
    expect(isServerPath("/settings")).toBe(false);
    expect(isServerPath("/skills")).toBe(false);
    expect(isServerPath("/downloads")).toBe(false);
    for (const path of [...APP_ROUTE_PATHS, ...Object.keys(EXTRA_PAGE_PATHS), ...Object.values(LANDING_TAB_PATHS)]) expect(isServerPath(path), path).toBe(false);
  });
});
