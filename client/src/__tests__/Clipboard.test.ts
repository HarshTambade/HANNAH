import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../services/clipboard";

/** A minimal page: one focused button, and textareas that record selection. */
function fakePage({ execResult = true } = {}) {
  class Element { focus() { page.active = this; } }
  class TextArea extends Element {
    value = ""; selectionStart = 0; selectionEnd = 0; style: Record<string, string> = {};
    setAttribute() {}
    select() {}
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
    remove() { page.children = page.children.filter((child) => child !== this); }
  }
  const button = new Element();
  const page = { active: button as Element, children: [] as Element[] };
  vi.stubGlobal("HTMLElement", Element);
  vi.stubGlobal("document", {
    get activeElement() { return page.active; },
    createElement: () => new TextArea(),
    body: { appendChild: (child: Element) => { page.children.push(child); } },
    execCommand: vi.fn(() => execResult),
  });
  return { page, button };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("copying text", () => {
  it("uses the clipboard API when it works", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back when the browser denies clipboard access, puts focus back, and never throws", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => { throw new Error("Write permission denied."); } } });
    const { page, button } = fakePage();
    await expect(copyText("DATABASE_URL=postgres://…")).resolves.toBe(true);
    expect(page.active).toBe(button);
    expect(page.children).toHaveLength(0);
  });

  it("says false when nothing can copy, instead of claiming it did", async () => {
    vi.stubGlobal("navigator", {});
    fakePage({ execResult: false });
    await expect(copyText("x")).resolves.toBe(false);
  });
});
