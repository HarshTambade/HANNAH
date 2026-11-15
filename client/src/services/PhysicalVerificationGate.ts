export type VerificationMethod = {
  id: string;
  name: string;
  description: string;
  type: "api_call" | "document_check" | "user_confirmation" | "external_service";
  estimatedLatencyMs: number;
};

export type VerificationRequest = {
  id: string;
  task: string;
  proposedMethod: VerificationMethod | null;
  userApproved: boolean;
  executed: boolean;
  result: string | null;
  status: "pending" | "approved" | "completed" | "rejected" | "skipped";
  createdAt: string;
  completedAt: string | null;
};

const KEY = "shanaya.physicalVerification.v1";

function readRequests(): VerificationRequest[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRequests(requests: VerificationRequest[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(requests.slice(-500)));
  } catch {
    // Best effort.
  }
}

export const PhysicalVerificationGate = {
  defaultMethods: [] as VerificationMethod[],

  registerMethod(method: VerificationMethod) {
    this.defaultMethods.push(method);
  },

  listMethods(): VerificationMethod[] {
    return [...this.defaultMethods];
  },

  proposeVerification(task: string, methodId?: string): VerificationRequest {
    const method = methodId
      ? this.defaultMethods.find((m) => m.id === methodId)
      : this.defaultMethods[0];
    const request: VerificationRequest = {
      id: crypto.randomUUID(),
      task,
      proposedMethod: method ?? null,
      userApproved: false,
      executed: false,
      result: null,
      status: "pending",
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    const requests = readRequests();
    requests.push(request);
    writeRequests(requests);
    return request;
  },

  approve(requestId: string): VerificationRequest {
    const requests = readRequests();
    const index = requests.findIndex((r) => r.id === requestId);
    if (index < 0) throw new Error(`Verification request ${requestId} not found.`);
    requests[index].userApproved = true;
    requests[index].status = "approved";
    writeRequests(requests);
    return requests[index];
  },

  reject(requestId: string): VerificationRequest {
    const requests = readRequests();
    const index = requests.findIndex((r) => r.id === requestId);
    if (index < 0) throw new Error(`Verification request ${requestId} not found.`);
    requests[index].status = "rejected";
    writeRequests(requests);
    return requests[index];
  },

  complete(requestId: string, result: string): VerificationRequest {
    const requests = readRequests();
    const index = requests.findIndex((r) => r.id === requestId);
    if (index < 0) throw new Error(`Verification request ${requestId} not found.`);
    requests[index].executed = true;
    requests[index].result = result;
    requests[index].status = "completed";
    requests[index].completedAt = new Date().toISOString();
    writeRequests(requests);
    return requests[index];
  },

  requiresVerification(task: string): boolean {
    const realWorldKeywords = [
      "shipment", "booking", "reservation", "order", "purchase",
      "delivery", "appointment", "account", "balance", "transaction",
    ];
    const lower = task.toLowerCase();
    return realWorldKeywords.some((kw) => lower.includes(kw));
  },

  list(): VerificationRequest[] {
    return readRequests();
  },
};