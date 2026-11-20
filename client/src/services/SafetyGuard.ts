import { Capacitor } from "@capacitor/core";
import { Dialog } from "@capacitor/dialog";
import { trackEvent } from "./events";
import { getDesktopBridge } from "./DesktopBridge";
import { SideEffectLedger } from "./SideEffectLedger";
import { GuardianAgent } from "./GuardianAgent";
import { ApprovalCenter } from "./ApprovalCenter";

export type SensitiveAction = "send_message" | "make_call" | "make_payment" | "toggle_setting" | "store_memory" | "delete_memory" | "delete_credential" | "read_file" | "desktop_action" | "write_file" | "delete_file" | "external_tool" | "create_event" | "save_email_draft" | "send_email" | "organize_email" | "send_chat_message";

/**
 * One risk scale for every action that needs the person's yes (chat, voice and
 * workflows alike): low reads approved information; medium changes something
 * of theirs that can be undone (a draft, a label, a file in a shared folder);
 * high reaches other people or the outside world (messages, calls, email,
 * outside tools); critical is money or can't be undone. A higher level never
 * gets fewer confirmations, whatever autonomy settings say.
 */
export type RiskLevel = "low" | "medium" | "high" | "critical";
export const ACTION_RISK: Record<SensitiveAction, RiskLevel> = {
  read_file: "low",
  store_memory: "medium", save_email_draft: "medium", organize_email: "medium", create_event: "medium", write_file: "medium", toggle_setting: "medium",
  send_message: "high", make_call: "high", send_email: "high", send_chat_message: "high", external_tool: "high", desktop_action: "high",
  make_payment: "critical", delete_file: "critical", delete_memory: "critical", delete_credential: "critical",
};
export const riskOf = (action: SensitiveAction): RiskLevel => ACTION_RISK[action] ?? "high";

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

export function describeAction(action: SensitiveAction, args: Record<string, unknown>) {
  if (action === "external_tool") {
    const shown = JSON.stringify(args.arguments ?? {}, null, 1);
    return `Run “${String(args.tool ?? "a tool")}” on ${String(args.server ?? "an outside MCP server")}? It's an outside tool, so HANNAH can't check what it changes.\n\nArguments:\n${shown.length > 600 ? `${shown.slice(0, 600)}…` : shown}`;
  }
  if (action === "send_email" || action === "save_email_draft") {
    const lines = [`To: ${String(args.to ?? "")}`, ...(args.cc ? [`Cc: ${String(args.cc)}`] : []), `Subject: ${String(args.subject ?? "")}`];
    const body = String(args.body ?? "");
    const from = args.provider ? ` from your ${args.provider === "microsoft" ? "Outlook" : "Gmail"} account` : "";
    return `${action === "send_email" ? `Send this email${from}? It can't be unsent.` : `Save this email as a draft${from}? It won't be sent.`}\n\n${lines.join("\n")}\n\n${body.slice(0, 1200)}${body.length > 1200 ? "…" : ""}`;
  }
  if (action === "organize_email") {
    const labels = Array.isArray(args.labels) ? args.labels.map(String).filter(Boolean) : [];
    const what = [args.archive === true ? "archive it (it leaves the inbox; nothing is deleted)" : "", labels.length ? `add ${labels.length === 1 ? "the label" : "the labels"} ${labels.join(", ")}` : ""].filter(Boolean).join(" and ");
    return `In your ${args.provider === "microsoft" ? "Outlook" : "Gmail"} account, ${what || "organize this email"}?\n\n${String(args.subject ?? args.id ?? "")}`;
  }
  if (action === "send_chat_message") {
    const text = String(args.text ?? "");
    return `Post this in Google Chat${args.spaceName ? ` (${String(args.spaceName)})` : ""}, as you? Everyone in that space can see it.\n\n${text.slice(0, 1200)}${text.length > 1200 ? "…" : ""}`;
  }
  if (action === "create_event") {
    const when = (value: unknown) => {
      const date = new Date(String(value ?? ""));
      return Number.isNaN(date.getTime()) ? String(value ?? "") : date.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    };
    return `Add this event to your ${args.provider === "microsoft" ? "Outlook" : args.provider === "google" ? "Google" : "connected"} calendar?\n\n${String(args.title ?? "")}\n${when(args.start)}${args.end ? ` – ${when(args.end)}` : " (1 hour)"}${args.location ? `\n${String(args.location)}` : ""}`;
  }
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
    return `Save this information in HANNAH's on-device memory?\n\n${String(args.summary ?? args.content ?? "Requested information").slice(0, 700)}`;
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
