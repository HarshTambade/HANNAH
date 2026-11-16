import { afterEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ name: "web" }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => platform.name, isNativePlatform: () => platform.name !== "web" } }));

async function load() {
  vi.resetModules();
  const project = await import("../config/project");
  const api = await import("../services/api");
  return { downloadUrl: project.downloadUrl, apiUrl: api.apiUrl };
}

afterEach(() => { platform.name = "web"; });

describe("download and API links", () => {
  it("on the website, download buttons stay on the site's own domain", async () => {
    platform.name = "web";
    const { downloadUrl, apiUrl } = await load();
    expect(downloadUrl("android")).toBe("/download/android");
    expect(apiUrl("/api/health")).toBe("/api/health");
  });

  it("the desktop and mobile apps use the HANNAH website", async () => {
    for (const name of ["electron", "android", "ios"]) {
      platform.name = name;
      const { downloadUrl, apiUrl } = await load();
      expect(downloadUrl("windows")).toBe("https://hannah.eliteforums.in/download/windows");
      expect(apiUrl("/api/health")).toBe("https://hannah.eliteforums.in/api/health");
    }
  });
});
