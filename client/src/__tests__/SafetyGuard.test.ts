import { beforeEach, describe, expect, it, vi } from "vitest";

const { confirmAction } = vi.hoisted(() => ({ confirmAction: vi.fn() }));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@capacitor/dialog", () => ({ Dialog: { confirm: vi.fn() } }));
vi.mock("../services/DesktopBridge", () => ({
  getDesktopBridge: () => ({ confirmAction }),
}));

import { SafetyGuard } from "../services/SafetyGuard";

describe("SafetyGuard human approval checks", () => {
  beforeEach(() => {
    confirmAction.mockReset();
  });

  it("blocks a destructive action when the user rejects confirmation", async () => {
    const executeShell = vi.fn();
    vi.stubGlobal("window", { confirm: vi.fn(() => false) });

    await expect((async () => {
      await SafetyGuard.require("write_file", { path: "notes.txt", content: "overwrite" });
      executeShell();
    })()).rejects.toThrow("Action cancelled");

    expect(executeShell).not.toHaveBeenCalled();
  });

  it("requires and returns the HITL token before a destructive desktop tool can execute", async () => {
    const executeShell = vi.fn();
    confirmAction.mockResolvedValueOnce(undefined);

    await expect((async () => {
      const token = await SafetyGuard.authorizeDesktop("execute_shell", { command: "pwd" });
      executeShell(token);
    })()).rejects.toThrow("Action cancelled");
    expect(executeShell).not.toHaveBeenCalled();

    confirmAction.mockResolvedValueOnce("one-use-hitl-token");
    const token = await SafetyGuard.authorizeDesktop("execute_shell", { command: "pwd" });
    executeShell(token);

    expect(executeShell).toHaveBeenCalledWith("one-use-hitl-token");
  });
});
