import { Capacitor } from "@capacitor/core";
import { Dialog } from "@capacitor/dialog";
import { trackEvent } from "./events";
import { getDesktopBridge } from "./DesktopBridge";
import { SideEffectLedger } from "./SideEffectLedger";

export type SensitiveAction = "send_message" | "make_call" | "make_payment" | "toggle_setting" | "store_memory" | "delete_memory" | "delete_credential" | "read_file" | "desktop_action" | "write_file" | "delete_file";

function describeAction(action: SensitiveAction, args: Record<string, unknown>) {
  if (action === "send_message") {
    return `Open a text message draft to ${String(args.recipient ?? "the requested recipient")} with this message:\n\n${String(args.message ?? "")}`;
  }
  if (action === "make_call") {
    return `Open the phone dialer for ${String(args.recipient ?? "the requested number")}? Shanaya will not place the call automatically.`;
  }
  if (action === "delete_memory") {
    return `Delete this saved information from Shanaya's on-device memory?\n\n${String(args.summary ?? "Matching memory entries")}`;
  }
  if (action === "store_memory") {
    return `Save this information in Shanaya's on-device memory?\n\n${String(args.summary ?? "Requested information").slice(0, 700)}`;
  }
  if (action === "delete_credential") {
    return `Remove this saved provider credential from Shanaya on this device?\n\n${String(args.summary ?? "Saved credential")}`;
  }
  if (action === "read_file") {
    return `Read this private app file and share its contents with the selected AI model?\n\n${String(args.path ?? "")}`;
  }
  if (action === "toggle_setting") {
    return `Change the ${String(args.setting ?? "requested")} device setting to ${String(args.enabled ?? "the requested state")}?`;
  }
  if (action === "desktop_action") {
    return `Allow Shanaya to perform this desktop action?\n\n${String(args.summary ?? "Control the current desktop")}`;
  }
  if (action === "write_file") {
    return `Create or replace this file in Shanaya's private app storage?\n\nPath: ${String(args.path ?? "")}\nSize: ${String(args.bytes ?? "unknown")} bytes\nPreview: ${String(args.preview ?? "").slice(0, 700)}`;
  }
  if (action === "delete_file") {
    return `Permanently delete this file from Shanaya's private app storage?\n\n${String(args.path ?? "")}`;
  }
  return `Continue with this payment action?\n\n${String(args.summary ?? "No payment details were provided")}`;
}

export class SafetyGuard {
  static async confirm(action: SensitiveAction, args: Record<string, unknown>) {
    const message = describeAction(action, args);
    let approved = false;
    if (Capacitor.isNativePlatform()) {
      try {
        const result = await Dialog.confirm({
          title: "Confirm with Shanaya",
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

  static async require(action: SensitiveAction, args: Record<string, unknown>) {
    if (!await SafetyGuard.confirm(action, args)) {
      throw new Error("Action cancelled. Shanaya did not make any changes.");
    }
  }

  static async authorizeDesktop(action: string, args: Record<string, unknown>) {
    const bridge = getDesktopBridge();
    const token = await bridge?.confirmAction(action, args);
    if (!token) throw new Error("Action cancelled. Shanaya did not control the desktop.");
    SideEffectLedger.record(`desktop:${action}`, String(args.summary ?? args.target ?? action));
    return token;
  }
}
