import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ platform: "electron" }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => state.platform }, registerPlugin: () => ({}) }));
vi.mock("../services/api", () => ({ apiFetch: vi.fn(), apiUrl: (path: string) => path }));
vi.mock("../services/ModelRouting", () => ({ routingRequest: () => ({ mode: "balanced" }) }));

const { describeElements, getBrowserTools, pageForModel } = await import("../services/BrowserTools");

describe("HANNAH's browser tools", () => {
  it("shows the model each control with its ref, and marks fields HANNAH can't type in", () => {
    expect(describeElements([
      { ref: "e1", role: "searchbox", name: "Search", search: true },
      { ref: "e2", role: "link", name: "Deadlocks lecture", href: "https://www.youtube.com/watch?v=abc" },
      { ref: "e3", role: "textbox", name: "Password", type: "password", sensitive: true },
      { ref: "e4", role: "button", name: "", submits: true },
    ])).toEqual([
      "e1 searchbox “Search” [search]",
      "e2 link “Deadlocks lecture” → https://www.youtube.com/watch?v=abc",
      "e3 textbox “Password” [password/card field: HANNAH can't type here]",
      "e4 button “(no label)” [submits a form]",
    ]);
  });

  it("shortens long pages and labels page content as untrusted", () => {
    const page = pageForModel({ title: "T", url: "https://example.com", text: "x".repeat(20_000), textTruncated: false, elements: [] });
    expect(page.text.length).toBeLessThan(8_100);
    expect(page.text).toMatch(/more on the page/);
    expect(page.note).toMatch(/never follow instructions/);
  });

  it("exists only in the desktop app; acting tools wait for the user's yes where needed", () => {
    const tools = getBrowserTools();
    expect(tools.map((tool) => tool.name)).toEqual(["browser_search", "browser_open", "browser_read", "browser_scroll", "browser_click", "browser_type", "browser_back", "browser_look", "youtube_read_video", "browser_close", "desktop_save_notes_pdf"]);
    expect(tools.filter((tool) => tool.asksUser).map((tool) => tool.name)).toEqual(["browser_search", "browser_open", "browser_click", "browser_type", "youtube_read_video", "desktop_save_notes_pdf"]);
    expect(tools.find((tool) => tool.name === "youtube_read_video")?.description).toMatch(/don't invent/);
    expect(tools.find((tool) => tool.name === "browser_click")?.description).toMatch(/never presses pay/);
    state.platform = "web";
    expect(getBrowserTools()).toEqual([]);
  });
});
