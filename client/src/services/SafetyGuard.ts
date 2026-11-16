import { Capacitor } from "@capacitor/core";
import { Dialog } from "@capacitor/dialog";
import { trackEvent } from "./events";
import { getDesktopBridge } from "./DesktopBridge";
import { SideEffectLedger } from "./SideEffectLedger";
import { GuardianAgent } from "./GuardianAgent";
import { ApprovalCenter } from "./ApprovalCenter";

export type SensitiveAction = "send_message" | "make_call" | "make_payment" | "toggle_setting" | "store_memory" | "delete_memory" | "delete_credential" | "read_file" | "desktop_action" | "write_file" | "delete_file";

export class HITLDeniedError extends Error {
  constructor(message = "Action cancelled. HANNAH did not make any changes.") { super(message); this.name = "HITLDeniedError"; }
}

/** Raised when GuardianAgent refuses an action; it stops the task like a declined confirmation. */
export class GuardianBlockedError extends HITLDeniedError {
  constructor(readonly tool: string, readonly reason: string) {
    super(`HANNAH's Guardian stopped “${tool.replaceAll("_", " ")}” before it ran. ${reason} Nothing was changed.`);
    this.name = "GuardianBlockedError";
  }
}

function describeAction(action: SensitiveAction, args: Record<string, unknown>) {
  if (action === "send_message") {
    return `Open a text message draft to ${String(args.recipient ?? "the requested recipient")} with this message:\n\n${String(args.message ?? "")}`;
  }
  if (action === "make_call") {
    return `Open the phone dialer for ${String(args.recipient ?? "the requested number")}? HANNAH will not place the call automatically.`;
  }
  if (action === "delete_memory") {
    return `Delete this saved information from HANNAH's on-device memory?\n\n${String(args.summary ?? "Matching memory entries")}`;
  }
  if (action === "store_memory") {
    return `Save this information in HANNAH's on-device memory?\n\n${String(args.summary ?? "Requested information").slice(0, 700)}`;
  }
  if (action === "delete_credential") {
    return `Remove this saved provider credential from HANNAH on this device?\n\n${String(args.summary ?? "Saved credential")}`;
  }
  if (action === "read_file") {
    return `Read this private app file and share its contents with the selected AI model?\n\n${String(args.path ?? "")}`;
  }
  if (action === "toggle_setting") {
    return `Change the ${String(args.setting ?? "requested")} device setting to ${String(args.enabled ?? "the requested state")}?`;
  }
  if (action === "desktop_action") {
    return `Allow HANNAH to perform this desktop action?\n\n${String(args.summary ?? "Control the current desktop")}`;
  }
  if (action === "write_file") {
    const content = typeof args.content === "string" ? args.content : typeof args.preview === "string" ? args.preview : "";
    const bytes = typeof args.bytes === "number" ? args.bytes : new TextEncoder().encode(content).length;
    return `Create or replace this file in HANNAH's private app storage?\n\nPath: ${String(args.path ?? "")}\nSize: ${bytes.toLocaleString()} bytes${content ? `\n\n${content.slice(0, 700)}${content.length > 700 ? "…" : ""}` : ""}`;
  }
  if (action === "delete_file") {
    return `Permanently delete this file from HANNAH's private app storage?\n\n${String(args.path ?? "")}`;
  }
  return `Continue with this payment action?\n\n${String(args.summary ?? "No payment details were provided")}`;
}

export class SafetyGuard {
  /**
   * GuardianAgent review. Every tool call, desktop action, and memory change
   * passes through here before it can run or reach a confirmation prompt.
   */
  static screen(tool: string, args: Record<string, unknown>, intent?: string) {
    const decision = GuardianAgent.evaluate({ tool, args, intent });
    if (!decision.allowed) {
      throw new GuardianBlockedError(tool, decision.reason);
    }
    return decision;
  }

  static async confirm(action: SensitiveAction, args: Record<string, unknown>) {
    const message = describeAction(action, args);
    let approved = false;
    // Prefer the in-app approval card when the chat is open to show it.
    if (ApprovalCenter.hasHost()) {
      approved = await ApprovalCenter.request(action, message);
      trackEvent(approved ? "tool_confirmation_approved" : "tool_confirmation_rejected", { action });
      if (approved) {
        SideEffectLedger.record(`safety_guard:${action}`, String(args.target ?? args.path ?? args.recipient ?? args.summary ?? action));
      }
      return approved;
    }
    if (Capacitor.isNativePlatform()) {
      try {
        const result = await Dialog.confirm({
          title: "Confirm with HANNAH",
          message,
          okButtonTitle: "Continue",
          cancelButtonTitle: "Cancel",
        });
        approved = result.value;
        trackEvent(approved ? "tool_confirmation_approved" : "tool_confirmation_rejected", { action });
        if (approved) {
          SideEffectLedger.record(`safety_guard:${action}`, String(args.target ?? args.path ?? args.recipient ?? args.summary ?? action));
        }
        return approved;
      } catch {
        // Electron/WebView builds may not have the native Dialog implementation installed.
      }
    }
    approved = typeof window !== "undefined" && window.confirm(message);
    trackEvent(approved ? "tool_confirmation_approved" : "tool_confirmation_rejected", { action });
    if (approved) {
      SideEffectLedger.record(`safety_guard:${action}`, String(args.target ?? args.path ?? args.recipient ?? args.summary ?? action));
    }
    return approved;
  }

  /** Guardian review followed by Human-in-the-Loop confirmation. */
  static async require(action: SensitiveAction, args: Record<string, unknown>, intent?: string) {
    SafetyGuard.screen(action, args, intent);
    if (!await SafetyGuard.confirm(action, args)) {
      throw new HITLDeniedError();
    }
  }

  static async authorizeDesktop(action: string, args: Record<string, unknown>) {
    SafetyGuard.screen(`desktop_${action}`, args, typeof args.summary === "string" ? args.summary : undefined);
    const bridge = getDesktopBridge();
    const token = await bridge?.confirmAction(action, args);
    if (!token) throw new Error("Action cancelled. HANNAH did not control the desktop.");
    SideEffectLedger.record(`desktop:${action}`, String(args.summary ?? args.target ?? action));
    return token;
  }
}
