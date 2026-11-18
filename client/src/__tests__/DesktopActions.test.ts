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
    expect(tools.map((tool) => tool.name)).toEqual(["desktop_look_at_screen", "desktop_list_apps", "desktop_open_app", "desktop_startup_routine", "desktop_set_startup_routine"]);
    expect(tools.filter((tool) => tool.asksUser).map((tool) => tool.name)).toEqual(["desktop_look_at_screen", "desktop_open_app", "desktop_set_startup_routine"]);
    expect(tools[0].description).toMatch(/can't click or type/);
    state.platform = "web";
    expect(getDesktopActionTools()).toEqual([]);
    state.platform = "android";
    expect(getDesktopActionTools()).toEqual([]);
  });
});
