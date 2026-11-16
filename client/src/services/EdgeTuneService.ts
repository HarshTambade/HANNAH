import { PersonalizationEngine } from "./PersonalizationEngine";
import { CognitiveReadinessEngine } from "./CognitiveReadinessEngine";
import { DreamingConsolidator } from "./DreamingConsolidator";

export type AdapterVersion = {
  version: number;
  createdAt: string;
  taskType: string; // e.g., "email_writing", "code_generation", "general"
  dataPoints: number;
  mergedFrom: number[]; // versions that were merged
  status: "active" | "rolled_back" | "archived";
  qualityScore: number; // 0..1 estimated personalization gain
};

export type PersonalizationHealth = {
  currentVersion: number;
  activeAdapters: number;
  totalDataPoints: number;
  estimatedGain: number;
  batteryImpact: "low" | "medium" | "high";
  thermalImpact: "low" | "medium" | "high";
  paused: boolean;
  lastRunAt: string | null;
};

const VERSIONS_KEY = "shanaya.edgetune.versions.v1";
const HEALTH_KEY = "shanaya.edgetune.health.v1";

function readVersions(): AdapterVersion[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VERSIONS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeVersions(versions: AdapterVersion[]) {
  try {
    window.localStorage.setItem(VERSIONS_KEY, JSON.stringify(versions.slice(-100)));
  } catch {
    // Best effort.
  }
}

function readHealth(): PersonalizationHealth {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HEALTH_KEY) || "null");
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Best effort.
  }
  return {
    currentVersion: 0,
    activeAdapters: 0,
    totalDataPoints: 0,
    estimatedGain: 0,
    batteryImpact: "low",
    thermalImpact: "low",
    paused: false,
    lastRunAt: null,
  };
}

function writeHealth(health: PersonalizationHealth) {
  try {
    window.localStorage.setItem(HEALTH_KEY, JSON.stringify(health));
  } catch {
    // Best effort.
  }
}

export const EdgeTuneService = {
  versions: readVersions(),
  health: readHealth(),

  async runCycle(taskType = "general"): Promise<AdapterVersion | null> {
    if (this.health.paused) return null;

    // Only run during idle periods
    const readiness = await CognitiveReadinessEngine.readiness();
    if (readiness === "busy" || readiness === "focused") return null;

    const rated = PersonalizationEngine.rated();
    if (rated.length < 3) return null; // Need enough data

    const now = new Date().toISOString();
    const dataPoints = rated.length;

    // Estimate personalization gain based on data quality
    const editedCount = rated.filter((r) => r.feedback === "edited").length;
    const acceptedCount = rated.filter((r) => r.feedback === "accepted").length;
    const qualityScore = Math.min(1, (editedCount * 0.1 + acceptedCount * 0.05) + 0.3);

    // K-Merge pattern: merge new data with existing adapters
    const existingActive = this.versions.filter((v) => v.status === "active" && v.taskType === taskType);
    const mergedFrom = existingActive.map((v) => v.version);

    const nextVersion = (this.versions.filter((v) => v.taskType === taskType).sort((a, b) => b.version - a.version)[0]?.version ?? 0) + 1;

    const adapter: AdapterVersion = {
      version: nextVersion,
      createdAt: now,
      taskType,
      dataPoints,
      mergedFrom,
      status: "active",
      qualityScore: Math.round(qualityScore * 100) / 100,
    };

    // Archive previous active versions for this task type
    this.versions = this.versions.map((v) =>
      v.taskType === taskType && v.status === "active" ? { ...v, status: "archived" } : v,
    );
    this.versions.push(adapter);
    writeVersions(this.versions);

    // Update health
    this.health = {
      currentVersion: nextVersion,
      activeAdapters: this.versions.filter((v) => v.status === "active").length,
      totalDataPoints: dataPoints,
      estimatedGain: qualityScore,
      batteryImpact: "low",
      thermalImpact: "low",
      paused: false,
      lastRunAt: now,
    };
    writeHealth(this.health);

    // Run dreaming consolidation during the same idle window
    await DreamingConsolidator.start();

    return adapter;
  },

  rollback(version: number) {
    const adapter = this.versions.find((v) => v.version === version);
    if (!adapter) return false;

    // Archive current active, restore target
    this.versions = this.versions.map((v) => {
      if (v.taskType === adapter.taskType && v.status === "active") return { ...v, status: "archived" };
      if (v.version === version) return { ...v, status: "active" };
      return v;
    });
    writeVersions(this.versions);

    this.health.currentVersion = version;
    writeHealth(this.health);
    return true;
  },

  pause() {
    this.health.paused = true;
    writeHealth(this.health);
  },

  resume() {
    this.health.paused = false;
    writeHealth(this.health);
  },

  reset() {
    this.versions = [];
    writeVersions([]);
    this.health = {
      currentVersion: 0,
      activeAdapters: 0,
      totalDataPoints: 0,
      estimatedGain: 0,
      batteryImpact: "low",
      thermalImpact: "low",
      paused: false,
      lastRunAt: null,
    };
    writeHealth(this.health);
    PersonalizationEngine.clear();
  },

  getHealth(): PersonalizationHealth {
    return { ...this.health };
  },

  getVersions(): AdapterVersion[] {
    return [...this.versions];
  },
};