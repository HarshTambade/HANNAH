/**
 * In-app Human-in-the-Loop approvals. When a screen (the chat) is mounted to
 * show approval cards, SafetyGuard routes confirmations here instead of the
 * browser's blocking confirm() dialog. With no host mounted, SafetyGuard keeps
 * using the native dialog, so an action can never run unconfirmed.
 */
export type ApprovalRequest = {
  id: string;
  action: string;
  title: string;
  message: string;
  createdAt: number;
};

type Pending = ApprovalRequest & { resolve: (approved: boolean) => void };

const pending: Pending[] = [];
const listeners = new Set<(requests: ApprovalRequest[]) => void>();
let hosts = 0;

function snapshot(): ApprovalRequest[] {
  return pending.map(({ resolve: _resolve, ...request }) => request);
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
        while (pending.length) pending.shift()!.resolve(false);
        notify();
      }
    };
  },
  request(action: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `approval-${Date.now()}`;
      pending.push({ id, action, title: titleFor(action), message, createdAt: Date.now(), resolve });
      notify();
    });
  },
  respond(id: string, approved: boolean) {
    const index = pending.findIndex((request) => request.id === id);
    if (index < 0) return;
    const [request] = pending.splice(index, 1);
    request.resolve(approved);
    notify();
  },
};
