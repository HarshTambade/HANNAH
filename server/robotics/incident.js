"use strict";

/**
 * "Why did my robot stop?": an incident report built from stored records only.
 *
 * investigate() is deterministic: the same records give the same report. It
 *
 *   1. finds the stop: a mission that ended without succeeding, an emergency
 *      stop, a fault, a lost link, a navigation failure, a sensor that stopped
 *      reporting (the latest one, or the one for a given mission or time);
 *   2. takes every timeline item from two minutes before it to fifteen
 *      seconds after, in order;
 *   3. states what the records show as "confirmed (from records)", each line
 *      citing the ids of the records it rests on;
 *   4. lists plausible causes as "suspected", each from a fixed rule, with the
 *      records that point to it and what would confirm it. A suspected cause is
 *      never written as a fact, and none is invented when no rule matches;
 *   5. compares with the robot's history (the same kind of stop in 30 days),
 *      says what is missing (no black box upload, unsynchronised clocks), and
 *      lists recovery steps for a person. HANNAH carries none of them out.
 *
 * narrate() asks a model for a short summary of the report, and accepts it
 * only if every sentence cites ids from the report and nothing else; it is
 * always labelled as model-written and never replaces the report.
 */

const BEFORE_MS = 120_000;
const AFTER_MS = 15_000;
const HISTORY_MS = 30 * 86_400_000;
const NOT_SUCCEEDED = new Set(["failed", "cancelled", "timed-out", "lost", "rejected", "expired", "unverified"]);

const clip = (value, max = 240) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const seconds = (ms) => `${(Math.abs(ms) / 1000).toFixed(1)} s`;
const iso = (at) => new Date(at).toISOString().replace("T", " ").slice(0, 19) + " UTC";

/** What kind of stop an item is, or null. */
function stopKind(item) {
  const type = String(item.type || "");
  if (type === "estop-engaged" || (type === "estop-changed" && item.details?.active === true)) return "estop";
  if (/^mission-/.test(type) && NOT_SUCCEEDED.has(type.slice(8))) return item.details?.capability === "stop_motion" || /stop_motion/.test(item.summary || "") ? null : "mission";
  if (type === "fault" || /controller-fault|fault-set|fault-needs-operator/.test(type)) return "fault";
  if (type === "link-lost") return "link";
  if (type === "nav-failed" || type === "nav-goal-failed") return "navigation";
  if (type === "sensor-lost" && ["error", "critical"].includes(item.severity)) return "sensor";
  if (type === "mode-changed" && ["estopped", "fault"].includes(item.details?.to)) return "mode";
  if (type === "motion-denied") return "safety";
  return null;
}

const isStopRequest = (item) => (item.type === "action-requested" && item.details?.action === "robots.stop_motion") || (item.type === "mission-issued" && item.details?.capability === "stop_motion");

function fact(id, text, evidence, at) {
  return { id, text, evidence: [...new Set(evidence)].filter(Boolean), at };
}

const RECOVERY = {
  estop: ["Make sure the area around the robot is safe before anything else.", "Find out why the emergency stop was pressed or why its circuit opened; the record shows that it engaged, not who or what engaged it.", "Release the emergency stop on the robot itself. HANNAH can't release it and doesn't try.", "The robot stays still after a release until it is given a new mission."],
  link: ["Check the robot's network connection (Wi-Fi signal, cable, router) and that it can reach HANNAH's server.", "The robot stopped by itself when the link went quiet; once the link is back, start the mission again yourself. Nothing restarts on its own."],
  sensor: ["Check the sensor named in the record: its cable, power and mounting.", "Look at its readings under the robot's diagnostics once it reports again before sending the robot anywhere."],
  navigation: ["Look at what the range sensor reported around the robot (Surroundings) and clear the route if something is in the way.", "If the route is clear, check that the goal is reachable on the robot's map."],
  fault: ["Read the fault code on the robot or its motor controller and follow the controller's manual.", "Clear the fault on the robot itself once the cause is fixed; HANNAH doesn't clear motor or safety faults remotely."],
  battery: ["Charge the robot (send it to its dock if it can still drive safely, or carry it there)."],
  timeout: ["The mission ran past its time limit: check what slowed it (obstacles, the route length) before running it again."],
  refused: ["The robot's own safety checks refused the command: read the reason and change the request, not the robot's limits."],
  request: ["The stop was asked for. Start a new mission when you want the robot to move again."],
  mode: ["The robot reported a fault or emergency-stop mode: see the matching recorded event above."],
  safety: ["Robot OS's safety gateway refused motion: check its state (e-stop latch, required sensors) on the robot."],
  unknown: ["No recorded cause was found. Check the robot directly and look at its own logs; consider allowing black box recordings to be uploaded."],
};

/**
 * @param {object} input
 * @param {object} input.robot      the robot view (id, name, simulated, limits)
 * @param {Array}  input.timeline   timeline items, any order
 * @param {Array}  [input.telemetry] samples {at, x, y, v, w, battery, mode, estop}
 * @param {Array}  [input.history]  timeline items from the last 30 days (for comparison)
 * @param {string} [input.missionId]
 * @param {number} [input.at]       look for the stop at or before this time
 */
function investigate({ robot, timeline = [], telemetry = [], history = [], missionId = null, at = null, now = Date.now(), question = "Why did my robot stop?" }) {
  const items = [...timeline].sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
  const kind = robot.simulated ? "simulation" : "physical";
  const base = { question, robot: { id: robot.id, name: robot.name, kind }, generatedAt: now, method: "Deterministic rules over stored records (black box events, missions, actions, telemetry). No model was used for this report." };
  let anchor = null;
  if (missionId) {
    anchor = [...items].reverse().find((item) => item.missionId === missionId && stopKind(item)) || null;
    if (!anchor) return { ...base, found: false, reason: `Mission ${missionId} has no recorded stop or failure.`, evidenceIds: [] };
  } else {
    const limit = Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) + 5_000 : Infinity;
    anchor = [...items].reverse().find((item) => item.at <= limit && stopKind(item)) || null;
    if (!anchor) return { ...base, found: false, reason: "No stop, fault, lost link or failed mission is recorded in the time searched.", evidenceIds: [], gaps: items.length ? [] : ["There are no records at all for this time."] };
  }
  // A failed mission is usually the consequence. Look for the first stop-like item close before it as the stop itself.
  const window = { from: anchor.at - BEFORE_MS, to: anchor.at + AFTER_MS };
  const sequence = items.filter((item) => item.at >= window.from && item.at <= window.to);
  const before = sequence.filter((item) => item.at <= anchor.at + 2_000);
  const nearBefore = (predicate, ms = 30_000) => [...before].reverse().find((item) => item !== anchor && item.at >= anchor.at - ms && predicate(item)) || null;

  const confirmed = [];
  const add = (text, evidence, at2) => confirmed.push(fact(`c${confirmed.length + 1}`, text, evidence, at2));
  add(`${iso(anchor.at)}: ${clip(anchor.summary)} (${anchor.origin === "server" ? "HANNAH's record" : "recorded by the robot"}).`, [anchor.id], anchor.at);
  for (const item of sequence) {
    if (item === anchor) continue;
    const kindOf = stopKind(item);
    const notable = kindOf || isStopRequest(item) || /^(estop|link|sensor)-(released|restored)$/.test(item.type) || /^approval-/.test(item.type) || item.type === "command-rejected" || item.type === "mission-issued" || /^action-(denied|failed)$/.test(item.type);
    if (!notable) continue;
    const offset = item.at - anchor.at;
    add(`${seconds(offset)} ${offset <= 0 ? "before" : "after"}: ${clip(item.summary)}`, [item.id], item.at);
  }
  const last = [...telemetry].filter((sample) => sample.at <= anchor.at).sort((a, b) => a.at - b.at).pop() || null;
  const after = [...telemetry].filter((sample) => sample.at > anchor.at && sample.at <= window.to).sort((a, b) => a.at - b.at).pop() || null;
  const tel = (sample) => `tel_${sample.at}`;
  if (last) add(`The last telemetry sample before the stop (${seconds(anchor.at - last.at)} earlier) shows mode ${last.mode || "unknown"}, speed ${Number(last.v ?? 0).toFixed(2)} m/s${last.battery !== null && last.battery !== undefined ? `, battery ${last.battery}%` : ""}${last.estop ? ", emergency stop engaged" : ""}.`, [tel(last)], last.at);
  if (after) add(`${seconds(after.at - anchor.at)} after, the robot reported speed ${Number(after.v ?? 0).toFixed(2)} m/s, mode ${after.mode || "unknown"}.`, [tel(after)], after.at);
  const minimum = robot.limits?.minBatteryPercent;
  const lowBattery = last && Number.isFinite(last.battery) && Number.isFinite(minimum) && last.battery < minimum;

  // ---------- suspected causes, each from one rule ----------
  const suspected = [];
  const suspect = (cause, rule, evidence, check, recovery) => suspected.push({ id: `s${suspected.length + 1}`, cause, status: "suspected", rule, evidence: [...new Set(evidence)].filter(Boolean), check, recovery });
  const estop = stopKind(anchor) === "estop" ? anchor : nearBefore((item) => stopKind(item) === "estop");
  const request = nearBefore(isStopRequest, 60_000);
  const link = stopKind(anchor) === "link" ? anchor : nearBefore((item) => item.type === "link-lost", 60_000);
  const sensor = stopKind(anchor) === "sensor" ? anchor : nearBefore((item) => item.type === "sensor-lost");
  const nav = stopKind(anchor) === "navigation" ? anchor : nearBefore((item) => stopKind(item) === "navigation", 10_000);
  const fault = stopKind(anchor) === "fault" ? anchor : nearBefore((item) => stopKind(item) === "fault");
  const refused = nearBefore((item) => item.type === "command-rejected" || item.type === "mission-rejected" || item.type === "motion-denied");
  const status = anchor.details?.status || String(anchor.type).replace(/^mission-/, "");
  if (estop) suspect(robot.simulated ? "The simulated emergency-stop input was set (by a scenario, a test or the simulator's inputs file)." : "The emergency stop was pressed, or its circuit opened.", "an emergency stop was recorded at or shortly before the stop", [estop.id, anchor.id], "Check the robot's emergency stop button and circuit. The record shows that it engaged, not who or what engaged it.", RECOVERY.estop);
  if (request) suspect(`The stop was asked for: ${clip(request.summary, 160)}`, "a stop request was recorded shortly before the stop", [request.id, anchor.id], "Compare the request's time with the stop's; ask whoever sent it.", RECOVERY.request);
  if (link) suspect("The robot lost contact with HANNAH and stopped by itself (its link watchdog holds the robot when the link is silent).", "a lost link was recorded shortly before the stop", [link.id, anchor.id], "Check the robot's network around that time.", RECOVERY.link);
  if (sensor) suspect(`Navigation stopped because ${sensor.deviceId ? `the ${sensor.deviceId} sensor` : "a sensor"} stopped reporting.`, "a sensor stopped reporting shortly before the stop", [sensor.id, anchor.id, ...(nav ? [nav.id] : [])], "Check the sensor; see whether its readings came back.", RECOVERY.sensor);
  if (nav && !sensor) {
    const reason = clip(nav.details?.reason || nav.summary, 160);
    suspect(/blocked|no path/i.test(reason) ? `The route was blocked: ${reason}` : `The robot's planner gave up: ${reason}`, "a navigation failure was recorded at the stop", [nav.id, anchor.id], "Look at what the range sensor reported (Surroundings) and the map.", RECOVERY.navigation);
  }
  if (fault) suspect(`A robot or motor-controller fault: ${clip(fault.summary, 160)}`, "a fault was recorded at or shortly before the stop", [fault.id, anchor.id], "Read the fault on the robot or its controller.", RECOVERY.fault);
  if (lowBattery) suspect(`The battery was below the robot's minimum (${last.battery}% < ${minimum}%).`, "the last telemetry sample shows a battery under the minimum", [tel(last), anchor.id], "Check the charge on the robot.", RECOVERY.battery);
  if (status === "timed-out") suspect("The mission ran out of time.", "the mission ended timed-out", [anchor.id], "Compare the mission's time limit with how long the route takes.", RECOVERY.timeout);
  if (refused) suspect(`The robot's own checks refused a command: ${clip(refused.summary, 160)}`, "a refusal was recorded shortly before the stop", [refused.id], "Read the refusal's reason.", RECOVERY.refused);

  // ---------- history, gaps, clocks ----------
  const anchorKind = stopKind(anchor);
  const similar = history.filter((item) => item.id !== anchor.id && stopKind(item) === anchorKind && item.at >= anchor.at - HISTORY_MS && item.at < window.from && (anchorKind !== "mission" || item.type === anchor.type));
  const historyFact = { kind: anchorKind, count: similar.length, evidence: similar.slice(-10).map((item) => item.id), text: similar.length ? `The same kind of stop (${anchorKind}${anchorKind === "mission" ? `: ${anchor.type}` : ""}) is recorded ${similar.length} other time${similar.length === 1 ? "" : "s"} in the 30 days before this one.` : `No other stop of this kind (${anchorKind}) is recorded in the 30 days before.` };
  const gaps = [];
  if (!sequence.some((item) => item.origin === "robot-blackbox" || item.origin === "robot-os")) gaps.push("The robot's black box uploaded nothing for this time: only HANNAH's own records and the robot's regular reports were used.");
  if (!telemetry.length) gaps.push("No telemetry samples are stored for this time (HANNAH keeps them for two hours unless recordings are uploaded).");
  if (!suspected.length) gaps.push("No rule matched: the records don't point to a cause. Nothing is suspected rather than guessed.");
  const unsynced = sequence.filter((item) => item.origin !== "server" && item.clock && !item.clock.synced);
  const clockNotes = [];
  if (unsynced.length) clockNotes.push(`${unsynced.length} robot record${unsynced.length === 1 ? "" : "s"} in this window carry a robot time that wasn't synchronised with HANNAH; their order against HANNAH's records is uncertain.`);
  for (let index = 1; index < sequence.length; index += 1) {
    const [a, b] = [sequence[index - 1], sequence[index]];
    if (a.origin === b.origin) continue;
    const spread = (a.clock?.uncertaintyMs ?? (a.origin === "server" ? 0 : Infinity)) + (b.clock?.uncertaintyMs ?? (b.origin === "server" ? 0 : Infinity));
    if (Number.isFinite(spread) && spread > 0 && b.at - a.at <= spread) clockNotes.push(`${a.id} and ${b.id} are ${b.at - a.at} ms apart, within their clocks' uncertainty (${spread} ms): they may have happened in the other order.`);
    if (clockNotes.length > 6) break;
  }
  const evidenceIds = [...new Set([...confirmed.flatMap((item) => item.evidence), ...suspected.flatMap((item) => item.evidence), ...historyFact.evidence])];
  return {
    ...base, found: true, label: kind === "simulation" ? "Simulation: these records come from a simulated robot." : "Physical robot: these are its records; HANNAH did not inspect the robot.",
    anchor: { id: anchor.id, at: anchor.at, type: anchor.type, kind: anchorKind, summary: anchor.summary, missionId: anchor.missionId || null },
    window, sequence: sequence.map((item) => ({ id: item.id, at: item.at, source: item.source, type: item.type, severity: item.severity, summary: item.summary, origin: item.origin, missionId: item.missionId || null, deviceId: item.deviceId || null, clock: item.clock })),
    confirmed, suspected: suspected.length ? suspected : [], history: historyFact,
    recovery: { note: "Steps for a person. HANNAH carries out none of them by itself, and never releases an emergency stop or clears a safety or motor fault remotely.", steps: [...new Set((suspected.length ? suspected : [{ recovery: RECOVERY.unknown }]).flatMap((item) => item.recovery))] },
    gaps, clock: { notes: clockNotes }, evidenceIds,
  };
}

/** The model's summary is accepted only if every sentence cites at least one id and every id is in the report. */
function validateNarrative(text, report) {
  const allowed = new Set(report.evidenceIds || []);
  const problems = [];
  const body = String(text || "").trim();
  if (!body) return { ok: false, problems: ["The model returned nothing."] };
  const sentences = body.split(/(?<=[.!?])\s+(?=[A-Z0-9“"(])/).map((item) => item.trim()).filter(Boolean);
  for (const sentence of sentences) {
    const cited = [...sentence.matchAll(/\[([A-Za-z0-9_:-]+)\]/g)].map((match) => match[1]);
    if (!cited.length) problems.push(`A sentence cites no record: “${clip(sentence, 120)}”`);
    for (const id of cited) if (!allowed.has(id)) problems.push(`It cites ${id}, which isn't in the report's evidence.`);
    if (/\b(definitely|certainly|confirmed|verified|proven)\b/i.test(sentence) && report.suspected?.some((item) => item.evidence.some((id) => cited.includes(id))) && !/suspect/i.test(sentence)) problems.push(`A sentence states a suspected cause as certain: “${clip(sentence, 120)}”`);
  }
  return { ok: problems.length === 0, problems, sentences: sentences.length };
}

async function narrate(report, ask) {
  if (!report?.found) return { ok: false, label: "Model-written summary", problems: ["There is no incident to summarise."], text: null };
  const records = report.sequence.map((item) => `[${item.id}] ${new Date(item.at).toISOString()} ${item.source}/${item.type}: ${item.summary}`).join("\n");
  const prompt = [
    `Incident report for ${report.robot.name} (${report.robot.kind}).`, "", "Records (the only ones you may cite):", records,
    ...report.confirmed.flatMap((item) => item.evidence.filter((id) => id.startsWith("tel_")).map((id) => `[${id}] ${item.text}`)), "",
    "Confirmed (from records):", ...report.confirmed.map((item) => `- ${item.text} [${item.evidence.join("] [")}]`), "",
    "Suspected causes (NOT verified):", ...(report.suspected.length ? report.suspected.map((item) => `- ${item.cause} [${item.evidence.join("] [")}]`) : ["- none"]), "",
    "Write at most five sentences for the robot's owner explaining why the robot stopped. End every sentence with the ids of the records it rests on, in square brackets, e.g. [msn_x_finished]. Cite only ids listed above. Call every suspected cause suspected or possible; never say it is confirmed. Add no cause, number or event that isn't above.",
  ].join("\n");
  const answer = await ask({ system: "You summarise robot incident records. You only restate the given records, always cite their ids, and never present a suspected cause as a fact.", prompt, maxTokens: 500, temperature: 0 });
  const text = String(answer?.text || "").trim();
  const check = validateNarrative(text, report);
  return { ok: check.ok, label: "Model-written summary: it may only cite the records above and is not a verified finding.", text: check.ok ? text : null, rejectedText: check.ok ? null : text, problems: check.problems, model: answer?.model || null, provider: answer?.provider || null };
}

module.exports = { AFTER_MS, BEFORE_MS, investigate, narrate, stopKind, validateNarrative };
