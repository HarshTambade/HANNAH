"use strict";

/**
 * Which model a robot can run, from the hardware it actually reported.
 *
 * The inputs are the robot's latest edge resources report (memory, GPU and
 * VRAM, storage, network link, battery, temperatures and the Edge Resource
 * Manager's own warnings) and the open-weight profiles in
 * shared/model-profiles.json, the same file and the same memory estimate
 * (weights + fp16 KV cache + runtime overhead) as the client's model advisor
 * (client/src/services/ModelAdvisor.ts). A robot is sized by the memory it
 * has free now, not by what is installed, because the safety and navigation
 * stack lives in that memory too.
 *
 * Degradation never touches collision avoidance or safety functions: the
 * decisions only ever name AI reasoning and optional perception. Moving
 * reasoning off the robot needs a remote resource the owner approved, a
 * network link the robot measured as up, and a privacy setting that allows it.
 *
 * Anything the robot couldn't measure is listed in `missing`; advice that
 * depends on it says so instead of assuming a value.
 */
const profiles = require("../../shared/model-profiles.json");

const TIER_RANK = { frontier: 4, strong: 3, efficient: 2, small: 1, unrated: 1.5 };
const STORAGE_RESERVE_GB = 2;
const metric = (node) => (node && node.available === true ? node.value : null);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const gb = (mb) => (finite(mb) ? Math.round((mb / 1024) * 10) / 10 : null);

/** The hardware facts a report gives, with what it couldn't give. */
function hardwareFromReport(view) {
  const snap = view?.snapshot || {};
  const missing = [];
  const need = (label, value) => { if (value === null || value === undefined) missing.push(label); return value; };
  const ramGB = need("installed memory", gb(metric(snap.memory?.total_mb)));
  const availableRamGB = need("free memory", gb(metric(snap.memory?.available_mb)));
  const gpus = snap.gpu?.devices || [];
  const gpu = gpus[0] || null;
  let gpuKind = "unknown";
  if (gpu) gpuKind = gpu.shared_memory ? "integrated" : "discrete";
  else if (snap.gpu?.status && snap.gpu.status.available === false) gpuKind = "none-reported";
  if (gpuKind === "unknown" || gpuKind === "none-reported") missing.push("GPU");
  const vramTotal = gpu && !gpu.shared_memory ? gb(metric(gpu.memory_total_mb)) : null;
  const vramUsed = gpu && !gpu.shared_memory ? gb(metric(gpu.memory_used_mb)) : null;
  if (gpuKind === "discrete" && vramTotal === null) missing.push("video memory");
  const disks = (snap.storage || []).map((disk) => ({ path: disk.path, freeGB: metric(disk.free_gb) })).filter((disk) => finite(disk.freeGB));
  const storageFreeGB = need("free storage", disks.length ? Math.max(...disks.map((disk) => disk.freeGB)) : null);
  const online = need("network link", metric(snap.network?.link_up));
  const batteryPct = metric(snap.battery?.percent);
  const batteryStatus = metric(snap.battery?.status);
  const externalPower = metric(snap.power?.external_power);
  return {
    ramGB, availableRamGB, gpuKind, gpuName: gpu?.name || null, vramGB: vramTotal, vramFreeGB: vramTotal !== null && vramUsed !== null ? Math.max(0, Math.round((vramTotal - vramUsed) * 10) / 10) : null,
    storageFreeGB, online: online === null ? null : Boolean(online), batteryPct, discharging: batteryStatus === null ? null : !["charging", "full"].includes(batteryStatus), externalPower: externalPower === null ? null : Boolean(externalPower),
    cpuTempC: metric(snap.cpu?.temperature_c), missing,
  };
}

function kvGB(model, context) {
  return (2 * model.layers * model.kvHeads * model.headDim * 2 * Math.min(context, model.maxContext)) / 1024 ** 3;
}

/** One model on this robot: does it fit, where, and why (or why not). */
function fit(model, hw, contextTokens) {
  const kv = kvGB(model, contextTokens);
  const overhead = 0.6 + model.weightsGB * 0.05;
  const total = model.weightsGB + kv + overhead;
  const need = `≈ ${total.toFixed(1)} GB (${model.weightsGB} GB weights + ${kv.toFixed(1)} GB KV cache + ${overhead.toFixed(1)} GB runtime)`;
  if (hw.storageFreeGB !== null && model.weightsGB > hw.storageFreeGB - STORAGE_RESERVE_GB) {
    return { fits: false, placement: "no-storage", totalGB: total, reason: `Needs ${model.weightsGB} GB to store; the robot has ${hw.storageFreeGB} GB free (keeping ${STORAGE_RESERVE_GB} GB for logs and updates).` };
  }
  if (hw.gpuKind === "discrete" && hw.vramGB !== null) {
    const usable = Math.min(hw.vramGB * 0.92, hw.vramFreeGB ?? hw.vramGB * 0.92);
    if (total <= usable) return { fits: true, placement: "gpu", totalGB: total, reason: `${need} fits in the ${usable.toFixed(1)} GB of video memory free on ${hw.gpuName || "its GPU"}.` };
  }
  if (hw.availableRamGB === null) return { fits: null, placement: "unknown", totalGB: total, reason: `${need}; the robot didn't report its free memory, so whether it fits is unknown.` };
  const share = hw.gpuKind === "integrated" ? 0.8 : 0.7;
  const usable = hw.availableRamGB * share;
  const where = hw.gpuKind === "integrated" ? "shared CPU/GPU memory" : "system memory (CPU)";
  if (total <= usable) return { fits: true, placement: hw.gpuKind === "integrated" ? "unified" : "cpu", totalGB: total, reason: `${need} fits in ${usable.toFixed(1)} GB of free ${where} (${Math.round(share * 100)}% of what is free now, leaving the rest for the safety and navigation stack).` };
  return { fits: false, placement: "too-large", totalGB: total, reason: `${need} is more than the ${usable.toFixed(1)} GB of free ${where} it may use.` };
}

/** Degradation level from the Edge Resource Manager's warnings and the measured power state. */
function degradationLevel(view, hw) {
  const warnings = view?.evaluation?.warnings || [];
  const reasons = warnings.map((item) => `${item.message} (${item.severity}, measured by ${item.source})`);
  const critical = warnings.some((item) => item.severity === "critical" && ["thermal", "memory", "overload", "power"].includes(item.kind));
  const warned = warnings.some((item) => ["thermal", "memory", "overload", "power"].includes(item.kind));
  return { level: critical ? "minimal" : warned ? "reduced" : "normal", reasons, onBattery: hw.discharging === true && hw.externalPower !== true };
}

/**
 * Advice for one robot: models that fit and the degradation decision, each with its reason.
 * options: { task, contextTokens, approvedRemote: string|null, privacy: "local-only" | "allow-approved-remote" }
 */
function adviseForRobot(view, { task = "chat", contextTokens = 4096, approvedRemote = null, privacy = "allow-approved-remote" } = {}) {
  const notes = [];
  if (!view) {
    return { available: false, reason: "This robot hasn't sent an edge resources report. Advice needs its measured hardware; nothing is assumed.", hardware: null, recommendations: [], degradation: null, notes };
  }
  const hw = hardwareFromReport(view);
  if (!view.fresh) notes.push(`The latest report is ${view.ageS} s old; this advice is from the robot's last known state, not its current one.`);
  if (view.simulatedHost) notes.push("These measurements are of the computer running a simulated robot, not of robot hardware.");
  if (hw.missing.length) notes.push(`Not measurable on this robot: ${hw.missing.join(", ")}.`);
  const context = Math.max(512, Math.min(131072, Number(contextTokens) || 4096));
  const candidates = profiles.open.filter((model) => (task === "agentic" ? model.tools : true));
  const fitted = candidates.map((model) => ({ id: model.id, label: model.label, ollama: model.ollama, tier: model.tier, weightsGB: model.weightsGB, ...fit(model, hw, context) }));
  const degradation = degradationLevel(view, hw);
  const fitting = fitted.filter((item) => item.fits === true);
  const byQuality = [...fitting].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || a.totalGB - b.totalGB);
  const smallest = [...fitting].sort((a, b) => a.totalGB - b.totalGB)[0] || null;

  const remoteAllowed = privacy !== "local-only" && Boolean(approvedRemote);
  const remoteUsable = remoteAllowed && hw.online === true;
  const remoteWhyNot = privacy === "local-only" ? "reasoning is set to stay on the robot" : !approvedRemote ? "no remote resource is approved for this robot" : hw.online === null ? "the robot's network link can't be measured" : hw.online === false ? "the robot reports no network link" : "";

  let chosen = null;
  const decisions = [];
  if (hw.availableRamGB === null && !fitting.length) {
    decisions.push({ workload: "ai_reasoning", action: remoteUsable ? "offload-to-approved-remote" : "no-local-model", resource: remoteUsable ? approvedRemote : null, reason: `The robot's free memory isn't measurable, so no local model can be recommended.${remoteUsable ? ` Reasoning can go to ${approvedRemote}.` : ` Remote reasoning isn't available: ${remoteWhyNot}.`}` });
  } else if (degradation.level === "normal") {
    chosen = byQuality[0] || null;
    decisions.push(chosen
      ? { workload: "ai_reasoning", action: "run-local", model: chosen.ollama, reason: `No resource warnings. ${chosen.label} is the strongest model that fits: ${chosen.reason}` }
      : { workload: "ai_reasoning", action: remoteUsable ? "offload-to-approved-remote" : "no-local-model", resource: remoteUsable ? approvedRemote : null, reason: `No profiled model fits this robot's free memory.${remoteUsable ? ` Reasoning can go to ${approvedRemote}.` : ` Remote reasoning isn't available: ${remoteWhyNot}.`}` });
  } else if (degradation.level === "reduced") {
    chosen = smallest;
    decisions.push(chosen
      ? { workload: "ai_reasoning", action: "use-smaller-model", model: chosen.ollama, reason: `${degradation.reasons.join("; ")}. Using the smallest model that fits, ${chosen.label}, to cut heat, memory and power.` }
      : { workload: "ai_reasoning", action: remoteUsable ? "offload-to-approved-remote" : "pause-local-reasoning", resource: remoteUsable ? approvedRemote : null, reason: `${degradation.reasons.join("; ")}. No model fits locally.${remoteUsable ? "" : ` ${remoteWhyNot}.`}` });
  } else {
    if (remoteUsable) {
      decisions.push({ workload: "ai_reasoning", action: "offload-to-approved-remote", resource: approvedRemote, reason: `${degradation.reasons.join("; ")}. Eligible reasoning moves to ${approvedRemote}; requests marked private stay on the robot with ${smallest ? smallest.label : "no local model"}.` });
      chosen = smallest;
    } else {
      chosen = smallest;
      decisions.push({ workload: "ai_reasoning", action: smallest ? "use-smaller-model" : "pause-local-reasoning", model: smallest?.ollama || null, reason: `${degradation.reasons.join("; ")}. Remote reasoning isn't available (${remoteWhyNot}), so ${smallest ? `only the smallest model, ${smallest.label}, runs` : "local reasoning pauses until the condition clears"}.` });
    }
    decisions.push({ workload: "perception", action: "shed-optional", reason: "Optional perception (detectors beyond the safety sensors) runs at a lower CPU quota until the condition clears." });
  }
  if (degradation.onBattery && degradation.level === "normal" && chosen && TIER_RANK[chosen.tier] >= 3) notes.push("The robot is on battery; a larger model shortens its run time.");
  decisions.push({ workload: "critical_safety", action: "unchanged", reason: "Safety functions keep full priority; no policy throttles, sheds or offloads them." });
  decisions.push({ workload: "navigation", action: "unchanged", reason: "Navigation and collision avoidance keep full priority; no policy throttles, sheds or offloads them." });

  const ranked = [...fitted].sort((a, b) => (b.fits === true) - (a.fits === true) || TIER_RANK[b.tier] - TIER_RANK[a.tier] || a.totalGB - b.totalGB);
  return {
    available: true, reportId: view.id, measuredAt: view.measuredAt, fresh: view.fresh, measuredOn: view.measuredOn, hardware: hw,
    contextTokens: context, chosen: chosen ? { model: chosen.ollama, label: chosen.label, tier: chosen.tier, placement: chosen.placement, reason: chosen.reason } : null,
    recommendations: ranked.slice(0, 8).map(({ totalGB, ...rest }) => ({ ...rest, totalGB: Math.round(totalGB * 10) / 10 })),
    degradation: { level: degradation.level, reasons: degradation.reasons, decisions },
    notes,
  };
}

module.exports = { adviseForRobot, fit, hardwareFromReport };
