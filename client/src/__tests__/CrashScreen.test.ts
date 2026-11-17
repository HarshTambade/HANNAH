import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("../services/api", () => ({ clearApiSession: vi.fn() }));
vi.mock("../services/appInfo", () => ({ getAppVersion: () => "1.4.0", detectPlatform: () => "Web" }));

import CrashScreen from "../components/CrashScreen";

describe("crash screen", () => {
  it("shows what went wrong, with secrets removed, and every way out", () => {
    const error = new Error("Cannot read properties of undefined (reading 'models') with key gsk_abcdefghijklmnopqrstuvwxyz0123");
    const html = renderToString(createElement(CrashScreen, { error }));
    expect(html).toContain("A moment of stillness.");
    expect(html).toContain("Cannot read properties of undefined");
    expect(html).not.toContain("gsk_abcdefghij");
    for (const label of ["Reload HANNAH", "Copy details", "Export diagnostics", "Disconnect and reload"]) expect(html).toContain(label);
  });

  it("copes with a thrown string", () => {
    const html = renderToString(createElement(CrashScreen, { error: "plain failure" }));
    expect(html).toContain("plain failure");
  });
});
