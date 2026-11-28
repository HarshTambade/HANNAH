import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("../services/Account", () => ({ accountRequest: vi.fn(async () => ({})) }));

import { connectionText, packageStatusText, type InteropRobot } from "../services/RobotOps";
import { missionParams } from "../components/robotops/InteropPanel";
import InteropPanel from "../components/robotops/InteropPanel";
import DeviceSecurityPanel from "../components/robotops/DeviceSecurityPanel";
import HardwarePackagesPanel from "../components/robotops/HardwarePackagesPanel";

const robot = (state: Partial<InteropRobot["state"]>): InteropRobot => ({
  id: "ia_1", adapter: "vda5050", name: "Cart", kind: "simulation",
  identity: { manufacturer: "Acme", model: null, serialNumber: "C-1", protocol: "VDA 5050", protocolVersion: "2.0.0" },
  state: { connection: "online", online: true, lastReportAt: 1, ageS: 0.4, stale: false, ...state },
  battery: null, pose: null, navigation: null, mission: null, diagnostics: { errors: [], estop: { engaged: false, kind: "NONE" }, fieldViolation: false },
  mode: { normalized: "autonomous", vendor: "AUTOMATIC", acceptsMissions: true }, functions: [], maintenance: null, extensions: {},
});

describe("robot interoperability, device security and hardware packages in the app", () => {
  it("never shows an old report as current", () => {
    expect(connectionText(robot({}))).toBe("Reporting (0.4 s ago)");
    expect(connectionText(robot({ connection: "stale", online: false, ageS: 95, stale: true }))).toContain("shown as old");
    expect(connectionText(robot({ connection: "link-broken", online: false }))).toContain("Link broken");
    expect(connectionText(robot({ connection: "never-connected", online: false, ageS: null }))).toBe("Never reported");
  });

  it("states package status as a fact, never a certification", () => {
    expect(packageStatusText({ kind: "developer-published", label: "Developer-published", detail: "" })).toBe("Developer-published");
    const tested = packageStatusText({ kind: "compatibility-tested", label: "Compatibility tested", detail: "simulation on Bench in CI: 12/12 passed" });
    expect(tested).toBe("Compatibility tested: simulation on Bench in CI: 12/12 passed");
    expect(tested).not.toMatch(/certified|badge/i);
  });

  it("turns the form into normalized mission inputs", () => {
    expect(missionParams("navigate", { place: "shelf", x: "", y: "", to: "" })).toEqual({ place: "shelf" });
    expect(missionParams("navigate", { place: "", x: "1", y: "2", to: "" })).toEqual({ x: 1, y: 2 });
    expect(missionParams("inspect", { place: "1,1; 2,2", x: "", y: "", to: "" })).toEqual({ waypoints: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });
    expect(missionParams("deliver", { place: "packing", to: "3,4", x: "", y: "" })).toEqual({ from: { place: "packing" }, to: { x: 3, y: 4 } });
  });

  it("renders the three panels with what they promise", () => {
    const interop = renderToString(createElement(InteropPanel));
    expect(interop).toContain("All robots, every adapter");
    expect(interop).toContain("not an emergency stop");
    const security = renderToString(createElement(DeviceSecurityPanel));
    expect(security).toContain("Device identity and security");
    expect(security).toContain("DDS (ROS 2) stays on the robot");
    const hardware = renderToString(createElement(HardwarePackagesPanel));
    expect(hardware).toContain("Hardware packages");
    expect(hardware).toContain("always asks you first");
    expect(hardware).not.toMatch(/certified/i);
  });
});
