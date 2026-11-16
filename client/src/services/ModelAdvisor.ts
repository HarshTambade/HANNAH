import profileData from "../../../shared/model-profiles.json";

/**
 * HANNAH model advisor.
 *
 * Recommends models for a task from three inputs: what the user needs, the
 * computer they have, and what this HANNAH server can actually reach. Local
 * fit is estimated from weights + KV cache + runtime overhead, against memory
 * left after other apps. Tiers come from shared/model-profiles.json and are
 * curated summaries, not benchmark scores.
 */

export type Task = "chat" | "coding" | "reasoning" | "research" | "vision" | "private-docs" | "agentic";
export type Budget = "free-local" | "free-hosted" | "low-cost" | "professional" | "personal-compute" | "hybrid";
export type Priority = "best" | "cheapest" | "fastest" | "coding" | "reasoning" | "local" | "privacy" | "multimodal";
export type Tier = "frontier" | "strong" | "efficient" | "small" | "unrated";
export type GpuKind = "none" | "integrated" | "discrete" | "apple";
export type OperatingSystem = "macos" | "windows" | "linux" | "android" | "ios" | "chromeos" | "unknown";

export type HardwareProfile = {
  os: OperatingSystem;
  cpuThreads: number | null;
  /** Installed RAM in GB. On Apple Silicon this is the unified memory. */
  ramGB: number | null;
  gpuKind: GpuKind;
  gpuName: string;
  /** Dedicated video memory in GB (discrete GPUs only). */
  vramGB: number | null;
  /** Memory kept free for the OS, browser and other apps. */
  reservedGB: number;
  online: boolean;
};

export type AdvisorNeeds = {
  task: Task;
  budget: Budget;
  priority: Priority;
  /** Context the work needs, in tokens (prompt + history + documents). */
  contextTokens: number;
  /** Optional workload for a monthly cost estimate. */
  monthlyMessages?: number;
};

export type CatalogModel = { id: string; label: string; tools: boolean; vision: boolean; context: number | null; free: boolean; notes?: string; price: { inputPerMTok: number; outputPerMTok: number; currency: string } | null };
export type CatalogProvider = { id: string; label: string; kind: string; local: boolean; free: boolean; docs?: string; configured: boolean; models: CatalogModel[] };
export type ModelCatalog = { byok: boolean; priceNote?: string; providers: CatalogProvider[] };

type OpenProfile = {
  id: string; label: string; family: string; paramsB: number; activeParamsB?: number; weightsGB: number;
  layers: number; kvHeads: number; headDim: number; maxContext: number; tier: Tier; strengths: string[];
  tools: boolean; vision: boolean; license: string; licenseNote: string; ollama: string;
  hosted?: Array<{ provider: string; model: string }>;
};
type HostedProfile = { provider: string; model: string; tier: Tier; strengths: string[]; speed: "fast" | "standard" | "slow"; vision?: boolean };

const profiles = profileData as unknown as { reviewed: string; tiers: Record<string, string>; open: OpenProfile[]; hosted: HostedProfile[] };
export const PROFILES_REVIEWED = profiles.reviewed;
export const TIER_DESCRIPTIONS = profiles.tiers;

export type Placement = "gpu" | "unified" | "split" | "cpu" | "too-large" | "unknown";
export type MemoryEstimate = { weightsGB: number; kvGB: number; overheadGB: number; totalGB: number; placement: Placement; usableGB: number | null };

export type Recommendation = {
  key: string;
  kind: "hosted" | "local";
  label: string;
  model: string;
  provider: string;
  providerLabel: string;
  tier: Tier;
  useCase: string;
  quality: string;
  speed: string;
  cost: string;
  monthlyCostUsd: number | null;
  localRequirements: string;
  privacy: string;
  limitations: string[];
  reason: string;
  available: boolean;
  action: { type: "use"; provider: string; model: string } | { type: "install"; command: string } | { type: "configure"; docs?: string; provider: string };
  score: number;
};

export type AdviceResult = { recommendations: Recommendation[]; hybrid: { local: Recommendation | null; cloud: Recommendation | null } | null; notes: string[] };

const TIER_RANK: Record<Tier, number> = { frontier: 4, strong: 3, efficient: 2, small: 1, unrated: 1.5 };
const TIER_LABEL: Record<Tier, string> = { frontier: "Frontier", strong: "Strong", efficient: "Efficient", small: "Small", unrated: "Unrated" };
/** The tier a task actually needs, so trivial chat isn't sent to a frontier model. */
const DESIRED_TIER: Record<Task, number> = { chat: 2, "private-docs": 2, vision: 3, coding: 4, reasoning: 4, research: 4, agentic: 4 };
const TASK_STRENGTHS: Record<Task, string[]> = {
  chat: ["chat", "multilingual"],
  coding: ["coding"],
  reasoning: ["reasoning"],
  research: ["research", "reasoning", "long-context"],
  vision: ["vision"],
  "private-docs": ["chat", "reasoning", "long-context"],
  agentic: ["agentic", "coding"],
};
const STRENGTH_LABEL: Record<string, string> = {
  chat: "everyday conversation", coding: "coding", reasoning: "step-by-step reasoning", research: "research",
  vision: "images", agentic: "multi-step tool use", multilingual: "multilingual replies", "long-context": "long documents",
};
const AVERAGE_INPUT_TOKENS = 1500;
const AVERAGE_OUTPUT_TOKENS = 500;
const LOW_COST_OUTPUT_LIMIT = 2; // USD per million output tokens

// ---------------------------------------------------------------------------
// Hardware

const HARDWARE_KEY = "hannah.hardware.v1";

export function defaultHardware(): HardwareProfile {
  return { os: "unknown", cpuThreads: null, ramGB: null, gpuKind: "none", gpuName: "", vramGB: null, reservedGB: 4, online: true };
}

/** A sensible memory reserve for the OS, browser and other apps. */
export function suggestedReserveGB(ramGB: number | null) {
  if (ramGB === null) return 4;
  if (ramGB <= 8) return 3;
  if (ramGB <= 16) return 4;
  return 6;
}

function detectOs(): OperatingSystem {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = `${nav.userAgentData?.platform ?? ""} ${navigator.userAgent}`.toLowerCase();
  if (/iphone|ipad|ipod/.test(platform)) return "ios";
  if (/android/.test(platform)) return "android";
  if (/cros/.test(platform)) return "chromeos";
  if (/mac/.test(platform)) return "macos";
  if (/win/.test(platform)) return "windows";
  if (/linux/.test(platform)) return "linux";
  return "unknown";
}

/**
 * Best-effort detection. Browsers round and cap reported memory (at most 8 GB)
 * and never expose VRAM, so the result is a starting point the user edits.
 */
export async function detectHardware(): Promise<{ profile: HardwareProfile; hints: string[] }> {
  const profile = defaultHardware();
  const hints: string[] = [];
  profile.os = detectOs();
  profile.cpuThreads = Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : null;
  profile.online = navigator.onLine;
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof deviceMemory === "number") {
    if (deviceMemory >= 8) hints.push("Your browser reports at least 8 GB of memory but hides the exact amount. Enter your real RAM below.");
    else profile.ramGB = deviceMemory;
  } else {
    hints.push("Your browser doesn't report memory. Enter your RAM below for local-model advice.");
  }
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null> } }).gpu;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      const info = adapter?.info;
      const vendor = (info?.vendor || "").toLowerCase();
      profile.gpuName = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(" ").trim();
      if (vendor.includes("apple")) profile.gpuKind = "apple";
      else if (vendor.includes("nvidia") || vendor.includes("amd")) profile.gpuKind = "discrete";
      else if (vendor.includes("intel") || vendor.includes("qualcomm") || vendor.includes("arm")) profile.gpuKind = "integrated";
      if (profile.gpuKind === "discrete") hints.push("Browsers don't expose video memory. Enter your GPU's VRAM for an accurate fit.");
    } catch {
      // WebGPU may be present but blocked; keep defaults.
    }
  }
  if (profile.os === "macos" && profile.gpuKind === "none") profile.gpuKind = "apple";
  return { profile, hints };
}

export function loadHardware(): HardwareProfile | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HARDWARE_KEY) || "null");
    return parsed && typeof parsed === "object" ? { ...defaultHardware(), ...parsed } : null;
  } catch {
    return null;
  }
}

export function saveHardware(profile: HardwareProfile) {
  try {
    window.localStorage.setItem(HARDWARE_KEY, JSON.stringify(profile));
  } catch {
    // Advice still works for this visit.
  }
}

// ---------------------------------------------------------------------------
// Local fit

/** fp16 KV cache: keys and values for every layer and KV head. */
export function kvBytesPerToken(model: Pick<OpenProfile, "layers" | "kvHeads" | "headDim">) {
  return 2 * model.layers * model.kvHeads * model.headDim * 2;
}

export function estimateMemory(model: OpenProfile, contextTokens: number, hardware: HardwareProfile): MemoryEstimate {
  const context = Math.min(contextTokens, model.maxContext);
  const weightsGB = model.weightsGB;
  const kvGB = (kvBytesPerToken(model) * context) / 1024 ** 3;
  const overheadGB = 0.6 + weightsGB * 0.05;
  const totalGB = weightsGB + kvGB + overheadGB;
  const ram = hardware.ramGB;
  if (ram === null) return { weightsGB, kvGB, overheadGB, totalGB, placement: "unknown", usableGB: null };
  const freeRam = Math.max(0, ram - hardware.reservedGB);
  if (hardware.gpuKind === "apple") {
    // macOS lets the GPU use roughly 70% of unified memory by default.
    const usable = Math.min(ram * 0.7, freeRam);
    return { weightsGB, kvGB, overheadGB, totalGB, placement: totalGB <= usable ? "unified" : "too-large", usableGB: usable };
  }
  if (hardware.gpuKind === "discrete" && hardware.vramGB) {
    const vram = hardware.vramGB * 0.92;
    if (totalGB <= vram) return { weightsGB, kvGB, overheadGB, totalGB, placement: "gpu", usableGB: vram };
    const combined = vram + freeRam * 0.8;
    return { weightsGB, kvGB, overheadGB, totalGB, placement: totalGB <= combined ? "split" : "too-large", usableGB: combined };
  }
  // The reserve already covers other apps; keep a small margin for fragmentation.
  const usable = freeRam * 0.9;
  return { weightsGB, kvGB, overheadGB, totalGB, placement: totalGB <= usable ? "cpu" : "too-large", usableGB: usable };
}

function localSpeed(model: OpenProfile, placement: Placement): { label: string; score: number } {
  const active = model.activeParamsB ?? model.paramsB;
  if (placement === "gpu" || placement === "unified") {
    return active <= 15 ? { label: "Fast on your GPU", score: 2 } : { label: "Usable on your GPU", score: 1 };
  }
  if (placement === "split") return { label: "Slow (shared GPU + RAM)", score: -0.5 };
  if (placement === "cpu") {
    if (active <= 4) return { label: "Usable on CPU", score: 0.5 };
    if (active <= 9) return { label: "Slow on CPU", score: -0.5 };
    return { label: "Very slow on CPU", score: -1.5 };
  }
  return { label: "Depends on your hardware", score: 0 };
}

// ---------------------------------------------------------------------------
// Ranking

function joinClauses(items: string[]) {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function strengthsPhrase(strengths: string[]) {
  const labels = [...new Set(strengths.map((item) => STRENGTH_LABEL[item] ?? item))];
  if (!labels.length) return "General use";
  const text = joinClauses(labels);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function taskMatch(task: Task, strengths: string[]) {
  const wanted = TASK_STRENGTHS[task];
  if (strengths.includes(wanted[0])) return 2;
  return wanted.some((item) => strengths.includes(item)) ? 1 : 0;
}

function tierFit(task: Task, tier: Tier, priority: Priority) {
  const rank = TIER_RANK[tier];
  if (priority === "best") return rank * 0.9;
  const desired = DESIRED_TIER[task];
  // Under-powered is worse than over-powered, but both cost points.
  return rank >= desired ? 2 - (rank - desired) * 0.6 : 2 - (desired - rank) * 1.2;
}

function priorityTask(needs: AdvisorNeeds): Task {
  if (needs.priority === "coding") return "coding";
  if (needs.priority === "reasoning") return "reasoning";
  if (needs.priority === "multimodal") return "vision";
  return needs.task;
}

function localOnly(needs: AdvisorNeeds) {
  return needs.priority === "privacy" || needs.priority === "local" || needs.task === "private-docs"
    || needs.budget === "free-local" || needs.budget === "personal-compute";
}

function monthlyCost(price: CatalogModel["price"], messages?: number) {
  if (!price || !messages) return null;
  return (messages * (AVERAGE_INPUT_TOKENS * price.inputPerMTok + AVERAGE_OUTPUT_TOKENS * price.outputPerMTok)) / 1_000_000;
}

function formatUsd(value: number) {
  if (value === 0) return "$0";
  if (value < 0.01) return "< $0.01";
  return `$${value < 10 ? value.toFixed(2) : Math.round(value).toLocaleString()}`;
}

function hostedCandidates(needs: AdvisorNeeds, catalog: ModelCatalog | null): Recommendation[] {
  if (!catalog) return [];
  const task = priorityTask(needs);
  const results: Recommendation[] = [];
  for (const provider of catalog.providers) {
    if (provider.local) continue;
    for (const model of provider.models) {
      if (model.notes && /not chat/i.test(model.notes)) continue;
      const profile = profiles.hosted.find((item) => item.provider === provider.id && item.model === model.id);
      const vision = model.vision || Boolean(profile?.vision);
      if (task === "vision" && !vision) continue;
      if (task === "agentic" && !model.tools) continue;
      if (model.context !== null && needs.contextTokens > model.context) continue;
      const free = model.free || provider.free;
      if (needs.budget === "free-hosted" && !free) continue;
      if (needs.budget === "low-cost" && !free && (!model.price || model.price.outputPerMTok > LOW_COST_OUTPUT_LIMIT)) continue;

      const tier: Tier = profile?.tier ?? "unrated";
      const strengths = [...(profile?.strengths ?? []), ...(vision && !profile?.strengths.includes("vision") ? ["vision"] : [])];
      const speed = profile?.speed ?? "standard";
      const monthly = monthlyCost(model.price, needs.monthlyMessages);
      let score = tierFit(task, tier, needs.priority) + taskMatch(task, strengths) * 1.2;
      if (needs.priority === "cheapest") score += free ? 3 : model.price ? 2 - model.price.outputPerMTok * 0.4 : -1;
      if (needs.priority === "fastest") score += speed === "fast" ? 2.5 : speed === "standard" ? 0.8 : -1;
      if (!model.tools && (task === "coding" || task === "agentic")) score -= 1;
      if (provider.configured) score += 1.5;

      const limitations: string[] = [];
      if (!model.tools) limitations.push("No native tool calling; HANNAH can't use device tools with it.");
      if (!vision) limitations.push("Text only, no image input.");
      if (!profile) limitations.push("Not yet profiled by HANNAH; quality is unrated.");
      if (!provider.configured) limitations.push(`Needs a ${provider.label} API key on the server.`);
      if (free) limitations.push("Free tier is rate-limited; check the provider's current quotas.");

      const cost = free
        ? "Free tier (rate-limited)"
        : model.price
          ? `$${model.price.inputPerMTok}/M in · $${model.price.outputPerMTok}/M out${monthly !== null ? ` · ≈ ${formatUsd(monthly)}/month` : ""}`
          : "Price not in HANNAH's table; check the provider";
      const reasons = [
        taskMatch(task, strengths) === 2 ? `it's strong at ${STRENGTH_LABEL[TASK_STRENGTHS[task][0]] ?? task}` : "",
        speed === "fast" ? "it answers quickly" : "",
        free ? "it's free to start" : model.price && model.price.outputPerMTok <= LOW_COST_OUTPUT_LIMIT ? "it's low cost" : "",
        provider.configured ? "it's ready to use now" : "",
      ].filter(Boolean);

      results.push({
        key: `hosted:${provider.id}:${model.id}`,
        kind: "hosted",
        label: model.label,
        model: model.id,
        provider: provider.id,
        providerLabel: provider.label,
        tier,
        useCase: strengthsPhrase(strengths),
        quality: `${TIER_LABEL[tier]}${tier === "unrated" ? "" : " (curated)"}`,
        speed: speed === "fast" ? "Fast" : speed === "standard" ? "Standard" : "Slower, thinks longer",
        cost,
        monthlyCostUsd: free ? 0 : monthly,
        localRequirements: "None, runs on the provider",
        privacy: `Hosted: prompts go to ${provider.label}`,
        limitations,
        reason: reasons.length ? `Picked because ${joinClauses(reasons)}.` : "It matches your requirements.",
        available: provider.configured,
        action: provider.configured ? { type: "use", provider: provider.id, model: model.id } : { type: "configure", provider: provider.id, docs: provider.docs },
        score,
      });
    }
  }
  return results;
}

function localCandidates(needs: AdvisorNeeds, hardware: HardwareProfile): Recommendation[] {
  const task = priorityTask(needs);
  const results: Recommendation[] = [];
  for (const model of profiles.open) {
    if (task === "vision" && !model.vision) continue;
    if (task === "agentic" && !model.tools) continue;
    if (needs.contextTokens > model.maxContext) continue;
    const memory = estimateMemory(model, needs.contextTokens, hardware);
    if (memory.placement === "too-large") continue;
    const speed = localSpeed(model, memory.placement);
    let score = tierFit(task, model.tier, needs.priority) + taskMatch(task, model.strengths) * 1.2 + speed.score;
    if (needs.priority === "cheapest") score += 3;
    if (needs.priority === "local" || needs.priority === "privacy") score += 2;
    if (needs.priority === "fastest") score += speed.score;
    if (memory.placement === "unknown") score -= 1;
    if (!model.tools && (task === "coding" || task === "agentic")) score -= 1;

    const limitations: string[] = [];
    if (!model.tools) limitations.push("No native tool calling.");
    if (!model.vision) limitations.push("Text only, no image input.");
    if (memory.placement === "split") limitations.push("Doesn't fully fit in VRAM; part runs from system RAM, which is much slower.");
    if (memory.placement === "unknown") limitations.push("Enter your RAM to confirm it fits.");
    if (model.license !== "Apache-2.0" && model.license !== "MIT") limitations.push(`${model.license}: ${model.licenseNote}`);
    const context = Math.min(needs.contextTokens, model.maxContext);
    const requirement = `≈ ${memory.totalGB.toFixed(1)} GB (${memory.weightsGB.toFixed(1)} GB weights + ${memory.kvGB.toFixed(1)} GB KV cache at ${Math.round(context / 1024)}K context + ${memory.overheadGB.toFixed(1)} GB runtime)${memory.usableGB !== null ? ` · ${memory.usableGB.toFixed(1)} GB usable on your device` : ""}`;
    const placementText = memory.placement === "gpu" ? "fits in your GPU memory" : memory.placement === "unified" ? "fits in unified memory" : memory.placement === "cpu" ? "fits in RAM" : memory.placement === "split" ? "fits only partly on the GPU" : "";

    results.push({
      key: `local:${model.id}`,
      kind: "local",
      label: model.label,
      model: model.ollama,
      provider: "ollama",
      providerLabel: "Your computer (Ollama)",
      tier: model.tier,
      useCase: strengthsPhrase(model.strengths),
      quality: `${TIER_LABEL[model.tier]} (curated)`,
      speed: speed.label,
      cost: "Free: no per-token charge, uses your electricity",
      monthlyCostUsd: 0,
      localRequirements: requirement,
      privacy: "Local: prompts stay on your computer",
      limitations,
      reason: `Picked because it ${joinClauses([placementText, taskMatch(task, model.strengths) === 2 ? `is good at ${STRENGTH_LABEL[TASK_STRENGTHS[task][0]] ?? task}` : "", "keeps your data on your device"].filter(Boolean))}.`,
      available: memory.placement !== "unknown",
      action: { type: "install", command: `ollama pull ${model.ollama}` },
      score,
    });
  }
  return results;
}

export function recommend(needs: AdvisorNeeds, hardware: HardwareProfile, catalog: ModelCatalog | null): AdviceResult {
  const notes: string[] = [];
  const wantsLocalOnly = localOnly(needs);
  const local = localCandidates(needs, hardware);
  const hosted = wantsLocalOnly || !hardware.online ? [] : hostedCandidates(needs, catalog);
  if (!hardware.online && !wantsLocalOnly) notes.push("You're offline, so only local models are shown.");
  if (wantsLocalOnly) notes.push("Showing local models only, so your prompts never leave your device.");
  if (hardware.ramGB === null) notes.push("Add your RAM to get reliable local-model advice.");
  if (["ios", "android"].includes(hardware.os)) notes.push("Phones run small models only through HANNAH's on-device mode; Ollama models need a computer.");

  const byScore = (a: Recommendation, b: Recommendation) => b.score - a.score;
  if (needs.budget === "hybrid") {
    // Routine work stays local: keep the task when a local model can do it, otherwise use general private work.
    const routineTask: Task = ["chat", "coding", "vision"].includes(needs.task) ? needs.task : "private-docs";
    const routineNeeds: AdvisorNeeds = { ...needs, task: routineTask, priority: "local" };
    const localPick = localCandidates(routineNeeds, hardware).sort(byScore)[0] ?? null;
    const cloudPick = hardware.online ? hostedCandidates({ ...needs, priority: needs.priority === "local" ? "best" : needs.priority }, catalog).sort(byScore)[0] ?? null : null;
    notes.push("Hybrid: routine and private requests run locally, and demanding work goes to the cloud model.");
    const recommendations = [...local, ...hosted].sort(byScore).slice(0, 8);
    return { recommendations, hybrid: { local: localPick, cloud: cloudPick }, notes };
  }
  const recommendations = [...local, ...hosted].sort(byScore).slice(0, 8);
  if (!recommendations.length) notes.push("Nothing matches every requirement. Try a smaller context, a different budget, or add more memory details.");
  return { recommendations, hybrid: null, notes };
}

/** Make a hosted pick the model the chat uses (read by ChatUI on load). */
export function applyToChat(provider: string, model: string) {
  try {
    window.localStorage.setItem("hannah.cloudProvider", provider);
    window.localStorage.setItem(`hannah.cloudModel:${provider}`, model);
    return true;
  } catch {
    return false;
  }
}
