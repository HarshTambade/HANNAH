import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("../services/Account", () => ({ accountRequest: vi.fn(async () => ({})) }));

import { EdgeResourcesPanel } from "../components/robotops/EdgeResourcesPanel";
import { ContextView, DeviceGraphPanel } from "../components/robotops/DeviceGraphPanel";
import { metricNote, metricText, type GraphContext, type RobotResources } from "../services/EdgeGraph";

const m = (value: number | boolean | string, unit: string, source = "/proc/meminfo") => ({ available: true as const, value, unit, source });
const na = (reason: string) => ({ available: false as const, reason: `not measurable on this device: ${reason}` });

const resources: RobotResources = {
  robot: { id: "rb_1", name: "Scout", kind: "simulation", connection: "online" },
  note: "Measured by the robot's Edge Resource Manager.",
  latest: {
    id: "res_1", robotId: "rb_1", receivedAt: 1, measuredAt: 1, ageS: 4, fresh: true, source: "robot-sync", status: "critical",
    measuredOn: "the computer running this simulated robot (not robot hardware)", simulatedHost: true, enforcement: "recommend-only", shedActive: true,
    snapshot: {
      measured_at_ms: 1,
      cpu: { utilization_pct: m(41.2, "%", "/proc/stat"), temperature_c: m(93, "C", "/sys/class/thermal/thermal_zone0 (cpu-thermal)") },
      memory: { used_pct: m(61, "%"), available_mb: m(3100, "MB") },
      gpu: { devices: [], status: na("no supported GPU tool found (nvidia-smi or tegrastats)") },
      storage: [{ path: "/", used_pct: m(40, "%", "os.statvfs") }],
      network: { link_up: m(true, "bool", "a non-loopback interface is up") },
      battery: { percent: na("/sys/class/power_supply is missing") },
      power: { external_power: na("no mains or USB supply under /sys/class/power_supply") },
      processes: { count: m(212, "processes", "/proc") },
      inference: { latency_ms_p50: na("no local inference has run since this service started") },
    },
    evaluation: { status: "critical", warnings: [{ kind: "thermal", severity: "critical", metric: "cpu.temperature_c", value: 93, threshold: 90, message: "CPU temperature 93 C", source: "/sys/class/thermal/thermal_zone0" }], unmeasured: ["battery.percent"] },
    actions: [{ policy: "warn", targets: [], reason: "CPU temperature 93 C" }, { policy: "shed_optional_load", targets: ["perception", "ai_reasoning", "background", "maintenance"], applied: false, detail: "recommend-only: enforcement is off in the Robot OS config" }],
    workloads: [{ cls: "critical_safety", description: "Critical control and safety (protected)", slice: "hannah-critical.slice", protected: true, sheddable: false, nice: -10, cpu_weight: 1000, cpu_quota_pct: null, services: ["safety-gateway"], shed: false }],
  },
  history: [],
  advice: {
    available: true, hardware: null, chosen: { model: "llama3.2:3b", label: "Llama 3.2 3B Instruct", tier: "small", placement: "cpu", reason: "fits" }, recommendations: [], notes: [],
    degradation: { level: "minimal", reasons: ["CPU temperature 93 C"], decisions: [{ workload: "ai_reasoning", action: "use-smaller-model", reason: "Remote reasoning isn't available (no remote resource is approved for this robot)." }, { workload: "critical_safety", action: "unchanged", reason: "Safety functions keep full priority." }] },
  },
};

describe("edge resources panel", () => {
  it("shows measured values with their source and says plainly what can't be measured", () => {
    const html = renderToString(createElement(EdgeResourcesPanel, { robotId: "rb_1", initial: resources }));
    expect(html).toContain("93 °C");
    expect(html).toContain("/sys/class/thermal/thermal_zone0 (cpu-thermal)");
    expect(html).toContain("not measurable on this device: no supported GPU tool found");
    expect(html).toContain("not measurable on this device: /sys/class/power_supply is missing");
    expect(html).toContain("the computer running this simulated robot (not robot hardware)");
    expect(html).toContain("recommended only (enforcement off)");
    expect(html).toContain("shed optional load");
    expect(html).toContain("Llama 3.2 3B Instruct");
    expect(html.replace(/<!-- -->/g, "")).toMatch(/critical safety<\/span>: unchanged/);
  });

  it("says when a robot hasn't reported, rather than showing numbers", () => {
    const html = renderToString(createElement(EdgeResourcesPanel, { robotId: "rb_1", initial: { ...resources, latest: null, note: "This robot hasn't sent an edge resources report.", advice: { ...resources.advice, available: false, degradation: null } } }));
    expect(html).toContain("hasn&#x27;t sent an edge resources report");
    expect(html).not.toContain("°C");
  });

  it("formats metrics without inventing values", () => {
    expect(metricText(undefined)).toBe("not reported");
    expect(metricText(na("x"))).toBe("not measurable on this device");
    expect(metricText(m(41.25, "%"))).toBe("41.3%");
    expect(metricNote(m(1, "MB", "/proc/meminfo"))).toBe("Source: /proc/meminfo");
  });
});

describe("device graph panel", () => {
  it("renders the empty state and a context answer with live labels", () => {
    expect(renderToString(createElement(DeviceGraphPanel))).toContain("Device graph");
    const node = (id: string, name: string, type: string, label: "current" | "not current" | "recorded", detail: string) => ({
      id, name, type, typeLabel: type, ref: null, props: {}, source: "user:u", derived: false, scope: { team: null, workspace: null, project: null, owner: "you" }, validFrom: 1, validTo: null,
      label, live: { verified: label !== "recorded", current: label === "current", state: label, detail, checkedAt: 1 },
    });
    const context: GraphContext = {
      start: node("gn_1", "Chiller 3 vibration sensor", "sensor", "recorded", "Entered by a person"),
      machines: [node("gn_2", "Chiller 3", "machine", "recorded", "Entered by a person")],
      places: [node("gn_3", "Plant room B", "zone", "recorded", "")],
      robots: [node("gn_4", "Scout", "robot", "not current", "Scout is offline, last seen 120 s ago.")],
      workflows: [node("gn_5", "Cooling alarm response", "workflow", "current", "“Cooling alarm response” is published (version 1) and active.")],
      approvedWorkflows: [{ id: "gn_5", name: "Cooling alarm response" }], path: [], summary: "Chiller 3 vibration sensor (Sensor) …", note: "“current” means the live source confirmed it just now.",
    };
    const html = renderToString(createElement(ContextView, { context }));
    expect(html).toContain("Scout is offline, last seen 120 s ago.");
    expect(html).toContain("not current");
    expect(html).toContain("Cooling alarm response");
    expect(html).toContain("Plant room B");
  });
});
