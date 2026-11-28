"use strict";

/**
 * Maintenance and diagnostics as actions, so chat, voice, agents and MCP
 * hosts reach them the same way as everything else:
 *
 *   maintenance.report    "is anything wearing out?"      read only
 *   diagnostics.report    "what's wrong with the system?" runs the checks; may run
 *                         automatic low-risk recoveries, nothing else
 *   diagnostics.recover   a person-approved recovery request; always asks, never
 *                         covered by a standing permission
 *
 * None of them changes a robot's limits, safety settings or hardware.
 */
const clip = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function opsActions({ maintenance, diagnostics }) {
  if (!maintenance || !diagnostics) return [];
  const brief = (finding) => ({
    id: finding.id, asset: finding.assetId, component: finding.component, metric: finding.metric, label: finding.label, title: finding.title, priority: finding.priority, confidence: finding.confidence,
    simulated: finding.simulated, description: finding.description, evidence: (finding.evidence || []).map((item) => item.statement), possibleCauses: finding.possibleCauses, causesStatus: finding.causesStatus, inspect: finding.inspection,
    firstSeenAt: finding.firstSeenAt, lastSeenAt: finding.lastSeenAt, verdict: finding.feedback, failureDate: null,
  });
  return [
    {
      id: "maintenance.report", service: "maintenance", kind: "read", title: "Report wear and maintenance findings",
      description: "Whether anything is wearing out, from the measurements robots, Robot OS and hubs reported: findings labelled measured anomaly, suspected cause or confirmed fault, each with evidence, possible causes, what to inspect, priority and a statistical confidence; open maintenance tasks; and the precision people's verdicts give the detectors. Never a failure date.",
      needs: "Robots or devices that report motor, battery or controller measurements",
      input: { type: "object", properties: { asset: { type: "string", description: "Optional: one robot or device, by name or id." } } },
      normalize: (raw) => ({ asset: clip(raw?.asset, 80) || null }),
      async execute(params, ctx) {
        const report = await maintenance.report(ctx.db, ctx.userId, { assetId: params.asset ? (await maintenance.asset(ctx.db, ctx.userId, params.asset)).id : null });
        return { summary: report.summary, findings: report.findings.slice(0, 20).map(brief), openTasks: report.tasks.map((task) => ({ title: task.title, dueAt: task.dueAt, overdue: task.overdue })), precision: report.precision.overall, measuredSeries: report.coverage.length, baselinesReady: report.coverage.filter((entry) => entry.baselineReady).length, basis: report.basis, rules: "Say which label each finding has. A measured anomaly or suspected cause is not a fault. Never give a failure date. Say when a finding is from a simulation." };
      },
      verify: async () => ({ confirmed: true, evidence: "Read from stored measurements and findings." }),
    },
    {
      id: "diagnostics.report", service: "maintenance", kind: "read", title: "Diagnose the system",
      description: "Run HANNAH's self-diagnostics: the server (memory, event loop, disk, database), model providers, local inference, the memory store and queues, and the account's robots, Robot OS services, hubs and devices. Returns each subsystem's status with what was measured, and open incidents with their evidence, possible causes, the recovery that fits and its policy (automatic, needs approval, administrator only, prohibited). Low-risk automatic recoveries may run and are verified; nothing else changes.",
      needs: "Nothing",
      input: { type: "object", properties: {} },
      normalize: () => ({}),
      async execute(_params, ctx) {
        const result = await diagnostics.diagnose(ctx.db, { userId: ctx.userId, actor: { kind: "agent", label: "diagnostics (automatic)", admin: false } });
        return {
          summary: result.summary, checkedAt: result.checkedAt,
          subsystems: Object.fromEntries(Object.entries(result.subsystems).map(([name, entry]) => [name, { status: entry.status, checks: entry.checks.map((item) => ({ component: item.component, status: item.status, evidence: item.evidence })) }])),
          incidents: result.incidents.filter((incident) => incident.status !== "resolved").slice(0, 15).map((incident) => ({ id: incident.id, title: incident.title, severity: incident.severity, status: incident.status, server: incident.server, simulated: incident.simulated, evidence: incident.evidence, possibleCauses: incident.causes, causesStatus: incident.causesStatus, recovery: incident.suggestions?.[0] ? { action: incident.suggestions[0].action, title: incident.suggestions[0].title, policy: incident.suggestions[0].policy } : null, manual: incident.manual, recent: incident.recoveries.slice(0, 2).map((item) => ({ action: item.action, status: item.status, evidence: item.verification?.evidence || item.result?.reason || null })) })),
          rules: "Report the measurements as measured and the causes as possibilities. A prohibited action is never run: say what a person has to do. To ask for an approval-required recovery use diagnostics_recover.",
        };
      },
      verify: async () => ({ confirmed: true, evidence: "Checks ran now." }),
    },
    {
      id: "diagnostics.recover", service: "maintenance", kind: "write", standing: false, title: "Run an approved recovery",
      description: "Run a recovery that a person approved (restart a non-critical Robot OS service, reload a validated configuration, restore a robot's last validated version). Created by diagnostics; the stored action and its parameters run, nothing else.",
      needs: "A recovery request from diagnostics, and a signed-in person's approval",
      input: { type: "object", properties: { recoveryId: { type: "string" } }, required: ["recoveryId"] },
      normalize: (raw) => ({ recoveryId: clip(raw?.recoveryId, 80) }),
      assess: async (params, ctx) => {
        const row = (await ctx.db.query("SELECT action, target_id, params FROM hannah_diag_recoveries WHERE id = $1 AND user_id = $2", [params.recoveryId, ctx.userId])).rows[0];
        return { resource: { type: "recovery", id: params.recoveryId }, account: row ? `${row.action} on ${row.target_id}` : "", flags: [], risk: "medium", row };
      },
      preview: (params, _ctx, assessed) => {
        const action = assessed.row ? diagnostics.actions().find((item) => item.id === assessed.row.action) : null;
        return { title: action ? `${action.title}: ${assessed.row.target_id}` : "Recovery", lines: [{ label: "Action", value: action?.title || "unknown" }, { label: "Target", value: assessed.row?.target_id || "unknown" }, { label: "Policy", value: "needs a person's approval" }, { label: "Undo", value: action?.undo || "—" }], body: action?.description || "", warnings: ["The robot checks the signed command and its own safety state before applying it. Motor safety, emergency stops, power and safety settings are never touched."] };
      },
      async execute(params, ctx) {
        const recovery = await diagnostics.executeApproved(ctx.db, ctx.userId, params.recoveryId, { by: "a signed-in person" });
        return { recoveryId: recovery.id, status: recovery.status, verification: recovery.verification };
      },
      verify: async (response) => ({ confirmed: response.status === "verified", evidence: response.verification?.evidence || `The recovery is ${response.status}.` }),
    },
  ];
}

module.exports = { opsActions };
