"use strict";

/**
 * Installing a hardware package on a robot, and rolling one back, as actions.
 * Both always ask a person (standing: false): code that touches a robot is
 * never installed by a standing grant, a developer key or a model alone.
 * assess() runs every check first; a package that fails one is refused and
 * never shown for approval. execute() checks again.
 */
const clip = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function hardwarePackageActions({ packages }) {
  if (!packages) return [];
  const input = { packageId: { type: "string" }, version: { type: "string" }, target: { type: "string", description: "The robot's id." } };
  return [
    {
      id: "packages.install", service: "robots", kind: "write", standing: false, title: "Install a hardware package on a robot",
      description: "Install a signed, verified hardware package on a robot with exactly the permissions and hardware interfaces it declares.",
      needs: "A package in your hardware packages, a robot in your account",
      input: { type: "object", properties: input, required: ["packageId", "version", "target"] },
      normalize: (raw) => ({ packageId: clip(raw?.packageId, 120), version: clip(raw?.version, 40), target: clip(raw?.target, 80) }),
      async assess(params, ctx) {
        const verdict = await packages.assessInstall(ctx.db, ctx.userId, params);
        return { resource: { type: "robot", id: params.target }, account: params.target, flags: verdict.ok ? ["it installs code or configuration on a robot"] : [`forbidden:${verdict.problems.join(" ")}`], verdict };
      },
      preview(params, _ctx, assessed) {
        const review = assessed.verdict?.report?.review;
        return {
          title: `Install ${review?.name || params.packageId} ${params.version} on ${assessed.verdict?.robot?.name || params.target}`,
          lines: review ? [
            { label: "Publisher", value: `${review.publisher} (signature checked)` },
            { label: "Status", value: `${assessed.verdict.report.status.label}: ${assessed.verdict.report.status.detail}` },
            { label: "Permissions", value: review.permissions.map((item) => item.label).join("; ") || "none" },
            { label: "Hardware", value: review.hardwareInterfaces.map((item) => `${item.type} ${item.match}`).join(", ") || "none" },
            { label: "Risk", value: review.risk },
          ] : [],
          body: assessed.verdict?.ok ? "It gets only what it declares; anything else it tries is refused and recorded." : (assessed.verdict?.problems || []).join("\n"),
          warnings: review?.warnings || [],
        };
      },
      async execute(params, ctx) { return packages.install(ctx.db, ctx.userId, params); },
      async verify(response) { return { confirmed: response?.status === "active", evidence: response ? `${response.packageId} ${response.version} is ${response.status} on ${response.target}.` : "No install record." }; },
    },
    {
      id: "packages.rollback", service: "robots", kind: "write", standing: false, title: "Roll a hardware package back to its previous version",
      description: "Go back to the version installed before. That version is verified again first.",
      needs: "An installed package with an earlier version",
      input: { type: "object", properties: { packageId: input.packageId, target: input.target }, required: ["packageId", "target"] },
      normalize: (raw) => ({ packageId: clip(raw?.packageId, 120), target: clip(raw?.target, 80) }),
      assess: async (params) => ({ resource: { type: "robot", id: params.target }, account: params.target, flags: ["it changes code or configuration on a robot"] }),
      preview: (params) => ({ title: `Roll back ${params.packageId} on ${params.target}`, lines: [], body: "The earlier version is checked again (signature, files, revocation, compatibility) before it is restored." }),
      async execute(params, ctx) { return packages.rollback(ctx.db, ctx.userId, params); },
      async verify(response) { return { confirmed: response?.status === "active", evidence: response ? `${response.packageId} is at ${response.version} on ${response.target}.` : "No install record." }; },
    },
  ];
}

module.exports = { hardwarePackageActions };
