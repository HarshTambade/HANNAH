import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShanayaTool } from "../services/DeviceTools";

const { requireApproval } = vi.hoisted(() => ({ requireApproval: vi.fn() }));

vi.mock("../services/SafetyGuard", () => ({
  SafetyGuard: { require: requireApproval },
}));

import { executeShanayaTool } from "../services/DeviceTools";

describe("approved device tool execution", () => {
  beforeEach(() => {
    requireApproval.mockReset().mockResolvedValue(undefined);
  });

  it("waits for approval before executing a protected tool", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const tool: ShanayaTool = {
      name: "write_app_file",
      description: "Write a private file.",
      inputSchema: { type: "object", properties: {} },
      requiresApproval: true,
      sensitive: "write_file",
      execute,
    };
    const args = { path: "notes.txt", content: "hello" };

    requireApproval.mockRejectedValueOnce(new Error("Action cancelled"));
    await expect(executeShanayaTool(tool, args)).rejects.toThrow("Action cancelled");
    expect(execute).not.toHaveBeenCalled();

    await expect(executeShanayaTool(tool, args)).resolves.toEqual({ ok: true });
    expect(requireApproval).toHaveBeenCalledWith("write_file", args);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an approval-required tool has no SafetyGuard action", async () => {
    const execute = vi.fn();
    const tool: ShanayaTool = {
      name: "unsafe_future_tool",
      description: "A malformed future tool.",
      inputSchema: { type: "object", properties: {} },
      requiresApproval: true,
      execute,
    };

    await expect(executeShanayaTool(tool, {})).rejects.toThrow("no SafetyGuard action configured");
    expect(requireApproval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
