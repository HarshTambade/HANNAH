"use strict";

/**
 * Actions a device performs itself: HANNAH's server can't write a file on a
 * laptop, run a command there, press a button in the desktop browser or open
 * the phone's dialer. The device asks here first, acts only when the record
 * says "authorized", and reports what happened; so these actions follow the
 * same permission levels and standing permissions, appear in the same
 * history, and stop with the same emergency stop as everything else.
 *
 * The device sends a short description of what it is about to do (never file
 * contents or typed text beyond a preview). Operating-system prompts (the
 * desktop app's own dialogs, the phone's permission sheets) still appear:
 * nothing here replaces them.
 */
const clip = (value, max) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);

function deviceAction({ id, service, kind, title, description, resourceType, standing, warnings = [] }) {
  return {
    id, service, kind, title, description, executor: "device", standing,
    needs: "A device signed in to this account",
    input: { type: "object", properties: { summary: { type: "string" }, target: { type: "string" }, detail: { type: "string" }, device: { type: "string" } }, required: ["summary"] },
    normalize: (raw) => ({ summary: clip(raw.summary, 1600), target: clip(raw.target, 300), detail: clip(raw.detail, 1200), device: clip(raw.device, 80), tool: clip(raw.tool, 80) }),
    assess: (params) => ({ resource: params.target ? { type: resourceType, id: params.target } : null, account: params.device }),
    preview: (params) => ({ title, lines: [...(params.target ? [{ label: "On", value: params.target }] : []), ...(params.device ? [{ label: "Device", value: params.device }] : [])], body: params.summary, warnings }),
  };
}

function deviceActions() {
  return [
    deviceAction({ id: "files.write", service: "files", kind: "write", title: "Write a file", description: "Create or replace a file in a folder shared with HANNAH or in its private storage.", resourceType: "path" }),
    deviceAction({ id: "files.delete", service: "files", kind: "destroy", title: "Delete a file", description: "Permanently delete a file.", resourceType: "path", warnings: ["A deleted file can't be brought back by HANNAH."] }),
    deviceAction({ id: "device.command", service: "device", kind: "write", title: "Run a command", description: "Run one program in a shared folder on the desktop.", resourceType: "command", warnings: ["A command can change files and reach the network."] }),
    deviceAction({ id: "device.control", service: "device", kind: "write", title: "Control the desktop", description: "Open, focus or operate apps on the desktop.", resourceType: "app" }),
    deviceAction({ id: "device.setting", service: "device", kind: "write", title: "Change a device setting", description: "Turn a device setting on or off.", resourceType: "setting" }),
    deviceAction({ id: "browser.submit", service: "browser", kind: "send", title: "Type or press in the browser", description: "Fill a field or press a button that changes something on a website.", resourceType: "site", warnings: ["Submitting a form on a website can't be undone by HANNAH."] }),
    deviceAction({ id: "connectors.call", service: "connectors", kind: "send", title: "Use an outside tool", description: "Call a tool of a connected service (an MCP connector).", resourceType: "tool", warnings: ["It runs on the outside service; HANNAH can't check what it changes."] }),
    deviceAction({ id: "messages.device_text", service: "messages", kind: "send", title: "Open a text message", description: "Open the phone's or computer's own messaging app with a message ready.", resourceType: "recipient" }),
    deviceAction({ id: "messages.device_call", service: "messages", kind: "send", title: "Start a phone call", description: "Open the dialer or place a call through the linked phone.", resourceType: "recipient" }),
    deviceAction({ id: "bookings.payment", service: "bookings", kind: "spend", standing: false, title: "Pay or purchase", description: "Any step that pays, purchases or commits money. Always asks.", resourceType: "merchant", warnings: ["Money leaves your account. This always needs your approval."] }),
  ];
}

module.exports = { deviceActions };
