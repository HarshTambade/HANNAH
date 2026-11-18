/**
 * In-app Human-in-the-Loop approvals. When a screen (the chat) is mounted to
 * show approval cards, SafetyGuard routes confirmations here instead of the
 * browser's blocking confirm() dialog. With no host mounted, SafetyGuard keeps
 * using the native dialog, so an action can never run unconfirmed.
 *
 * When you're signed in, each request is also mirrored to your other devices
 * (DeviceTasks): approve or deny it on your phone and the card here closes with
 * that answer. Whichever device answers first decides.
 */
import { DeviceTasks, type RemoteApproval } from "./DeviceTasks";

export type ApprovalRequest = {
  id: string;
  action: string;
  title: string;
  message: string;
  createdAt: number;
  /** Also waiting on your other signed-in devices. */
  shared?: boolean;
};

type Pending = ApprovalRequest & { resolve: (approved: boolean) => void; remote?: RemoteApproval; stop?: AbortController };

const pending: Pending[] = [];
const listeners = new Set<(requests: ApprovalRequest[]) => void>();
let hosts = 0;

function snapshot(): ApprovalRequest[] {
  return pending.map(({ resolve: _resolve, remote: _remote, stop: _stop, ...request }) => request);
}

function notify() {
  const current = snapshot();
  listeners.forEach((listener) => listener(current));
}

function titleFor(action: string) {
  const labels: Record<string, string> = {
    send_message: "Send a message",
    make_call: "Start a phone call",
    make_payment: "Make a payment",
    toggle_setting: "Change a device setting",
    store_memory: "Save to memory",
    delete_memory: "Delete saved memory",
    delete_credential: "Remove a saved key",
    read_file: "Read a private file",
    write_file: "Write a file",
    delete_file: "Delete a file",
    desktop_action: "Control your desktop",
    create_event: "Add a calendar event",
    save_email_draft: "Save an email draft",
    send_email: "Send an email",
    organize_email: "Organize an email",
    send_chat_message: "Post in Google Chat",
  };
  return labels[action] ?? action.replaceAll("_", " ");
}

export const ApprovalCenter = {
  hasHost() {
    return hosts > 0;
  },
  /** A screen that renders approval cards registers itself while mounted. */
  attachHost(listener: (requests: ApprovalRequest[]) => void) {
    hosts += 1;
    listeners.add(listener);
    listener(snapshot());
    return () => {
      hosts = Math.max(0, hosts - 1);
      listeners.delete(listener);
      // Without a host nobody can answer, so outstanding requests are declined.
      if (hosts === 0) {
        while (pending.length) {
          const request = pending.shift()!;
          request.stop?.abort();
          void request.remote?.withdraw();
          request.resolve(false);
        }
        notify();
      }
    };
  },
  request(action: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `approval-${Date.now()}`;
      const entry: Pending = { id, action, title: titleFor(action), message, createdAt: Date.now(), resolve };
      pending.push(entry);
      notify();
      void mirror(entry);
    });
  },
  /** `fromOtherDevice` is set when the answer came from another device, so it isn't sent back. */
  respond(id: string, approved: boolean, fromOtherDevice = false) {
    const index = pending.findIndex((request) => request.id === id);
    if (index < 0) return;
    const [request] = pending.splice(index, 1);
    request.stop?.abort();
    if (!fromOtherDevice) void request.remote?.answeredHere(approved);
    request.resolve(approved);
    notify();
  },
};

async function mirror(entry: Pending) {
  const remote = await DeviceTasks.requestApproval({ id: entry.id, title: entry.title, detail: entry.message }).catch(() => null);
  if (!remote) return;
  if (!pending.includes(entry)) {
    // Answered here while the request was being shared.
    void remote.withdraw();
    return;
  }
  entry.remote = remote;
  entry.stop = new AbortController();
  entry.shared = true;
  notify();
  const result = await remote.wait(entry.stop.signal);
  if (result.status === "approved" || result.status === "denied") ApprovalCenter.respond(entry.id, result.status === "approved", true);
}
