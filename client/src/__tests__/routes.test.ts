import { describe, expect, it } from "vitest";
import { APP_ROUTE_PATHS, legacyHashRedirect, pathForScreen, ROUTE_TITLES, screenForLocation } from "../routes";

const at = (pathname: string, hash = "", search = "") => ({ pathname, hash, search });

describe("routes", () => {
  it("maps real paths to screens, with or without a trailing slash", () => {
    expect(screenForLocation(at("/"))).toBe("landing");
    expect(screenForLocation(at("/index.html"))).toBe("landing");
    expect(screenForLocation(at("/chat"))).toBe("conversation");
    expect(screenForLocation(at("/models/"))).toBe("models");
    expect(screenForLocation(at("/models/index.html"))).toBe("models");
    expect(screenForLocation(at("/memory"))).toBe("accountability");
    expect(screenForLocation(at("/marketplace"))).toBe("marketplace");
  });

  it("keeps landing-page anchors on the landing page", () => {
    expect(screenForLocation(at("/", "#privacy"))).toBe("landing");
    expect(screenForLocation(at("/", "#faq"))).toBe("landing");
  });

  it("understands old #/ links and redirects them", () => {
    expect(screenForLocation(at("/", "#/models"))).toBe("models");
    expect(legacyHashRedirect(at("/", "#/settings", "?ref=mail"))).toBe("/settings?ref=mail");
    expect(legacyHashRedirect(at("/", "#privacy"))).toBeNull();
    expect(legacyHashRedirect(at("/", "#/nowhere"))).toBeNull();
  });

  it("reports unknown paths as not found", () => {
    expect(screenForLocation(at("/nope"))).toBe("not-found");
    expect(screenForLocation(at("/chat/extra"))).toBe("not-found");
  });

  it("supports a deployment base path", () => {
    expect(pathForScreen("models", "/app/")).toBe("/app/models");
    expect(pathForScreen("landing", "/app/")).toBe("/app/");
    expect(screenForLocation(at("/app/models"), "/app/")).toBe("models");
    expect(screenForLocation(at("/app/"), "/app/")).toBe("landing");
  });

  it("gives every screen a title and every app path a built page", () => {
    expect(APP_ROUTE_PATHS).toEqual(["/chat", "/dashboard", "/agents", "/models", "/memory", "/automations", "/settings", "/integrations", "/marketplace", "/actions", "/robotics", "/devices"]);
    for (const title of Object.values(ROUTE_TITLES)) expect(title).toMatch(/HANNAH/);
  });
});
