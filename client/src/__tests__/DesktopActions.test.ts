import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ platform: "electron" }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => state.platform }, registerPlugin: () => ({}) }));
vi.mock("../services/api", () => ({ apiFetch: vi.fn(), apiUrl: (path: string) => path }));
vi.mock("../services/ModelRouting", () => ({ routingRequest: () => ({ mode: "balanced" }) }));

const { getDesktopActionTools, parseRoutine } = await import("../services/DesktopActions");

const folders = [{ id: "f1", name: "hannah-app" }];

describe("desktop actions", () => {
  it("reads a startup routine written one step per line", () => {
    expect(parseRoutine("1. app: Visual Studio Code | folder: hannah-app\n- url: https://mail.google.com\n\nwait: 10\nlink: https://github.com", folders)).toEqual([
      { kind: "app", app: { id: "", name: "Visual Studio Code" }, folderId: "f1" },
      { kind: "url", url: "https://mail.google.com" },
      { kind: "wait", seconds: 10 },
      { kind: "url", url: "https://github.com" },
    ]);
  });

  it("refuses unknown steps and folders that aren't shared", () => {
    expect(() => parseRoutine("run: rm -rf ~", folders)).toThrow(/isn't a step/);
    expect(() => parseRoutine("app: Code | folder: secrets", folders)).toThrow(/isn't a shared folder/);
    expect(() => parseRoutine("wait: soon", folders)).toThrow(/number of seconds/);
  });

  it("exists only in the desktop app; looking, opening and changing the routine wait for the user", () => {
    const tools = getDesktopActionTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "desktop_look_at_screen", "desktop_list_apps", "desktop_open_app", "desktop_startup_routine", "desktop_set_startup_routine",
      "desktop_control_start", "desktop_observe", "desktop_act", "desktop_switch_app", "desktop_window", "desktop_quit_app", "desktop_control_finish",
    ]);
    expect(tools.filter((tool) => tool.asksUser).map((tool) => tool.name)).toEqual(["desktop_look_at_screen", "desktop_open_app", "desktop_set_startup_routine", "desktop_control_start", "desktop_act", "desktop_window", "desktop_quit_app"]);
    expect(tools[0].description).toMatch(/can't click or type/);
    // The server cuts descriptions at 1,000 characters.
    expect(tools.every((tool) => tool.description.length <= 1000)).toBe(true);
    state.platform = "web";
    expect(getDesktopActionTools()).toEqual([]);
    state.platform = "android";
    expect(getDesktopActionTools()).toEqual([]);
    state.platform = "electron";
  });

  it("requests to use apps bring the control tools, within the server's tool limit", async () => {
    const { selectToolsForRequest, MAX_TOOLS_PER_REQUEST } = await import("../services/AgentRouter");
    const tools = getDesktopActionTools();
    const many = [...tools, ...Array.from({ length: 20 }, (_, index) => ({ ...tools[1], name: `other_tool_${index}` }))];
    for (const request of ["Click the Save button in TextEdit", "Switch to my browser and scroll down", "Type my address into the form for me in Safari"]) {
      const chosen = selectToolsForRequest(many, request).map((tool) => tool.name);
      expect(chosen).toEqual(expect.arrayContaining(["desktop_control_start", "desktop_observe", "desktop_act", "desktop_control_finish"]));
      expect(chosen.length).toBeLessThanOrEqual(MAX_TOOLS_PER_REQUEST);
    }
    expect(selectToolsForRequest(many, "Open VS Code and my project").map((tool) => tool.name)).toContain("desktop_open_app");
  });
});
