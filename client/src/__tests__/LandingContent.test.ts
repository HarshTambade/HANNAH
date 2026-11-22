import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { AUTOMATION } from "../content/landing";

// The site's integration list must match the engine: every listed step exists, with the same status.
const require = createRequire(import.meta.url);
const { REGISTRY } = require("../../../server/workflows/nodes.js") as { REGISTRY: Map<string, { status: string; label: string }> };

describe("landing automation content", () => {
  it("names only steps the workflow engine has, with their real status", () => {
    for (const item of AUTOMATION.integrations) {
      const node = REGISTRY.get(item.type);
      expect(node, `${item.name} (${item.type}) isn't a workflow node`).toBeTruthy();
      expect(item.status, `${item.name} is listed as ${item.status} but the engine says ${node!.status}`).toBe(node!.status);
    }
  });
});

describe("landing model and agent content", () => {
  it("lists Auto's routing modes exactly as the app defines them", async () => {
    const { ROUTING_MODES: app } = await import("../services/ModelRouting");
    const { ROUTING_MODES: site } = await import("../content/landing");
    expect(site.map(([label, text]) => ({ label, description: text }))).toEqual(app.map(({ label, description }) => ({ label, description })));
  });

  it("names only cloud providers the server supports", async () => {
    const { MODEL_PROVIDERS } = await import("../content/landing");
    const { listProviders } = require("../../../server/providers/catalog.js") as { listProviders: () => Array<{ label: string; local?: boolean }> };
    const labels = listProviders().map((provider) => provider.label.replace(/ \(.*\)$/, ""));
    for (const name of MODEL_PROVIDERS.cloud) expect(labels, `${name} isn't a server provider`).toContain(name);
  });

  it("marks the desktop workflow steps with the engine's status", async () => {
    const { AGENTS } = await import("../content/landing");
    expect(AGENTS.computer.find((item) => item.name === "Desktop tasks from workflows")?.status).toBe(REGISTRY.get("device.browser")!.status);
  });
});

describe("landing devices content", () => {
  it("names only protocols the hub has an adapter for, and keeps saying no physical device was tested", async () => {
    const { DEVICES, FAQS, ROADMAP } = await import("../content/landing");
    const profiles = require("../../../server/devices/profiles.js") as { ADAPTERS: Record<string, unknown>; NOT_BUILT: Record<string, string>; builtin: () => Array<Record<string, unknown>>; compatibility: (profile: unknown) => { level: string } };
    expect(DEVICES.protocols.map((item) => item.id).sort()).toEqual(Object.keys(profiles.ADAPTERS).sort());
    for (const item of DEVICES.notBuilt) expect(profiles.NOT_BUILT[item.id], item.label).toBeTruthy();
    // "None is called plug and play" has to be true of what ships.
    expect(profiles.builtin().some((profile) => profiles.compatibility(profile).level === "plug-and-play")).toBe(false);
    expect(profiles.builtin().every((profile) => profile.simulated === true)).toBe(true);
    expect(DEVICES.status).toBe("beta");
    const limits = DEVICES.limits.join(" ");
    expect(limits).toMatch(/No physical device has been connected/);
    expect(limits).toMatch(/none is called plug and play/);
    expect(limits).toMatch(/no HANNAH OS image to install yet/);
    expect(limits).toMatch(/not a safety system/);
    expect(FAQS.find((item) => /lights, plugs and sensors/.test(item.q))?.a).toMatch(/with real ones it is untested/);
    expect(ROADMAP[0][1]).toMatch(/simulated/);
  });
});

describe("landing robotics content", () => {
  it("names only capabilities the robot contract has as implemented, and keeps saying it is simulation only", async () => {
    const { ROBOTICS, FAQS, ROADMAP, CAPABILITIES } = await import("../content/landing");
    const contract = require("../../../server/robotics/contract.js") as { capability: (id: string) => { status: string } | undefined };
    for (const item of ROBOTICS.capabilities) expect(contract.capability(item.id)?.status, `${item.label} (${item.id})`).toBe("implemented");
    // Nothing on the site may read as if a physical robot had been driven.
    expect(ROBOTICS.status).toBe("beta");
    expect(ROBOTICS.limits.join(" ")).toMatch(/built-in simulators/);
    expect(ROBOTICS.limits.join(" ")).toMatch(/No physical robot has been connected/);
    expect(ROBOTICS.limits.join(" ")).toMatch(/not safety-certified.*not an emergency stop/);
    expect(FAQS.find((item) => item.q === "Can HANNAH control a robot?")?.a).toMatch(/on real hardware, not yet/);
    expect(ROADMAP.some(([title]) => /Gazebo and on real hardware/.test(title))).toBe(true);
    expect(CAPABILITIES.find((item) => /Robots/.test(item.title))?.description).toMatch(/not yet run on a physical robot/);
    // The steps a commissioning needs, as the site says them.
    const { ORDER } = require("../../../server/robotics/commissioning.js") as { ORDER: string[] };
    expect(ROBOTICS.also.join(" ")).toContain(["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"][ORDER.length] + " checks");
  });
});
