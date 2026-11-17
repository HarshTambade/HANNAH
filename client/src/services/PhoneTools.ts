/**
 * Chat tools for the Phone Bridge, on a computer (web or desktop app):
 * "Hey HANNAH, call Aman using my phone" → find Aman on the phone → you pick
 * the number → you confirm here → the phone's dialer opens with it.
 *
 * - Calls and SMS wait for the person's confirmation here (SafetyGuard), and
 *   then again on the phone (the dialer's Call button, the composer's Send).
 * - The result is only what the phone verifiably reported.
 * - Offered only to signed-in accounts and never on the phone itself, which
 *   uses make_call and send_message directly.
 */
import type { HANNAHTool } from "./DeviceTools";
import { getAccountHint } from "./api";
import { checkNumber, describeOutcome, isPhoneApp, PhoneBridgeApi, waitForPhone } from "./PhoneBridge";
import { thisDevice } from "./DeviceTasks";

const numberOrThrow = (input: unknown) => {
  const checked = checkNumber(String(input ?? ""));
  if ("refused" in checked) throw new Error(checked.refused);
  return checked.number;
};

const tools: HANNAHTool[] = [
  {
    name: "phone_find_contact",
    description: "Look up a person by name in the contacts on the user's paired phone (not uploaded anywhere; only the matching names and numbers come back). Use before phone_call or phone_text when the user names someone instead of giving a number. If more than one person or number matches, ask the user which one.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "The name to look up, for example Aman." } }, required: ["name"] },
    execute: async (args) => {
      const { command, phone } = await PhoneBridgeApi.send({ action: "lookup", query: String(args.name ?? ""), deviceName: thisDevice().name });
      const done = await waitForPhone(command.id, { timeoutMs: 40_000, platform: phone.platform });
      if (done.status !== "resolved") return { ok: false, phone: phone.name, message: describeOutcome(done, phone.name) };
      return { ok: true, phone: phone.name, matches: done.result?.matches ?? [], note: done.result?.matches?.length ? "Ask the user to choose if there's more than one person or number." : "No contact matched; ask for the number." };
    },
  },
  {
    name: "phone_call",
    description: "Place a call through the user's own paired phone: after the user confirms, the phone's dialer opens with the number, and the user taps Call on the phone. Not for emergency numbers. Report exactly the outcome returned; never say the call connected.",
    requiresApproval: true,
    sensitive: "make_call",
    approvalDetails: (args) => ({ call: args.name ? `${String(args.name)} (${String(args.number)})` : String(args.number), using: "your paired phone's dialer" }),
    inputSchema: { type: "object", properties: { number: { type: "string", description: "The phone number, with country code where known." }, name: { type: "string", description: "Who it is, if known." } }, required: ["number"] },
    execute: async (args) => {
      const number = numberOrThrow(args.number);
      const { command, phone } = await PhoneBridgeApi.send({ action: "call", number, name: typeof args.name === "string" ? args.name : undefined, deviceName: thisDevice().name });
      const done = await waitForPhone(command.id, { platform: phone.platform });
      return { ok: done.status === "dialer-opened", status: done.status, phone: phone.name, message: describeOutcome(done, phone.name) };
    },
  },
  {
    name: "phone_text",
    description: "Prepare an SMS on the user's own paired phone: after the user confirms, the phone's messaging app opens with the recipient and message filled in, and the user taps Send there. Report exactly the outcome returned; never say it was delivered.",
    requiresApproval: true,
    sensitive: "send_message",
    approvalDetails: (args) => ({ to: args.name ? `${String(args.name)} (${String(args.number)})` : String(args.number), message: String(args.message ?? ""), using: "your paired phone's messaging app" }),
    inputSchema: { type: "object", properties: { number: { type: "string" }, name: { type: "string" }, message: { type: "string", description: "The text, up to 1000 characters." } }, required: ["number", "message"] },
    execute: async (args) => {
      const number = numberOrThrow(args.number);
      const { command, phone } = await PhoneBridgeApi.send({ action: "sms", number, body: String(args.message ?? ""), name: typeof args.name === "string" ? args.name : undefined, deviceName: thisDevice().name });
      const done = await waitForPhone(command.id, { platform: phone.platform, timeoutMs: phone.platform === "ios" ? 120_000 : 45_000 });
      return { ok: ["composer-opened", "sent"].includes(done.status), status: done.status, phone: phone.name, message: describeOutcome(done, phone.name) };
    },
  },
];

export function getPhoneTools(): HANNAHTool[] {
  return getAccountHint() && !isPhoneApp() ? tools : [];
}
