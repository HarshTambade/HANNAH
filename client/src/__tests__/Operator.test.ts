import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The client side of the Action Engine against a scripted server: what is
// asked of it, when the approval card appears, what happens on each answer,
// and what a model is told afterwards.
vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }, confirm: vi.fn(() => true) }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" }, registerPlugin: () => ({}) }));
vi.mock("@capacitor/dialog", () => ({ Dialog: { confirm: vi.fn() } }));
vi.mock("../services/DesktopBridge", () => ({ getDesktopBridge: () => null }));
vi.mock("../services/DeviceTasks", () => ({ DeviceTasks: { requestApproval: async () => null } }));
let signedIn = true;
vi.mock("../services/api", async (original) => ({ ...(await original<typeof import("../services/api")>()), isAccountSession: () => signedIn, usesBearerSession: () => false }));

type Call = { path: string; method: string; body: Record<string, unknown> | null };
const calls: Call[] = [];
let respond: (call: Call) => unknown = () => ({});
vi.mock("../services/Account", () => ({
  accountRequest: async (path: string, init: RequestInit = {}) => {
    const call = { path, method: init.method || "GET", body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const result = respond(call);
    if (result instanceof Error) throw result;
    return result;
  },
}));

const { Operator, getOperatorTools, previewText } = await import("../services/Operator");
const { ApprovalCenter } = await import("../services/ApprovalCenter");
const { executeHANNAHTool } = await import("../services/DeviceTools");
const { HITLDeniedError } = await import("../services/SafetyGuard");
type Tool = import("../services/DeviceTools").HANNAHTool;

const record = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "act-1", action: "mail.send", service: "mail", kind: "send", status, executor: "server", request: "", intent: "", agent: "", source: "chat", taskId: null, resource: null, account: "me@example.com",
  preview: { title: "Send an email to priya@client.example", lines: [{ label: "To", value: "priya@client.example" }, { label: "Subject", value: "Report" }], body: "I will share it tomorrow.", warnings: ["An email can't be unsent."] },
  permission: { outcome: status === "waiting-approval" ? "ask" : "allow", reason: "Email is set to Approval before action." }, approval: null, response: null, verification: null, error: null,
  outcome: `outcome for ${status}`, final: status !== "waiting-approval", createdAt: 1, updatedAt: 1, executedAt: null, expiresAt: null, ...extra,
});
/** A screen that shows approval cards and answers each one. */
function host(answer: boolean) {
  const seen: string[] = [];
  const detach = ApprovalCenter.attachHost((requests) => { for (const request of requests) { seen.push(request.message); queueMicrotask(() => ApprovalCenter.respond(request.id, answer)); } });
  return { seen, detach };
}
const sendTool: Tool = {
  name: "email_send", description: "", inputSchema: { type: "object", properties: {} }, requiresApproval: true, sensitive: "send_email",
  engine: { action: "mail.send", params: (args) => ({ to: [String(args.to)], subject: String(args.subject), body: String(args.body) }) },
  execute: vi.fn(async () => ({ sent: true, legacy: true })),
};

beforeEach(() => { signedIn = true; calls.length = 0; respond = () => ({}); (sendTool.execute as ReturnType<typeof vi.fn>).mockClear(); });
afterEach(() => vi.restoreAllMocks());

describe("the Action Engine on the client", () => {
  it("shows the engine's own preview on the approval card", () => {
    expect(previewText(record("waiting-approval"))).toBe("Send an email to priya@client.example?\n\nTo: priya@client.example\nSubject: Report\n\nI will share it tomorrow.\n\n• An email can't be unsent.");
  });

  it("a tool for a signed-in account is asked of the engine, approved on the card, and reported as the engine recorded it", async () => {
    respond = (call) => (call.path === "/api/actions" ? { record: record("waiting-approval") } : { record: record("done", { response: { id: "msg1" }, verification: { confirmed: true, evidence: "Gmail has it in Sent." } }) });
    const screen = host(true);
    const result = await executeHANNAHTool(sendTool, { to: "priya@client.example", subject: "Report", body: "I will share it tomorrow." }, { intent: "reply to Priya" });
    screen.detach();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /api/actions", "POST /api/actions/act-1/decision"]);
    expect(calls[0].body).toMatchObject({ action: "mail.send", params: { to: ["priya@client.example"], subject: "Report" }, intent: "reply to Priya" });
    expect(calls[1].body).toEqual({ approve: true });
    expect(screen.seen[0]).toContain("Send an email to priya@client.example?");
    expect(result).toEqual({ id: "msg1", status: "done", confirmed: "Gmail has it in Sent." });
    expect(sendTool.execute).not.toHaveBeenCalled();
  });

  it("declining stops the task; an action that is not allowed, failed or unconfirmed is never reported as done", async () => {
    respond = (call) => (call.path === "/api/actions" ? { record: record("waiting-approval") } : { record: record("declined") });
    const screen = host(false);
    await expect(executeHANNAHTool(sendTool, { to: "a@b.example", subject: "s", body: "b" })).rejects.toBeInstanceOf(HITLDeniedError);
    screen.detach();
    expect(calls[1].body).toEqual({ approve: false });
    for (const status of ["denied", "failed", "suggested", "unverified", "unknown"]) {
      respond = () => ({ record: record(status, { response: { id: "x" } }) });
      const result = await executeHANNAHTool(sendTool, { to: "a@b.example", subject: "s", body: "b" }) as { status: string; note: string };
      expect(result.status).toBe(status);
      expect(result.note).toMatch(status === "unverified" ? /not confirmed\. Don't say it is done/ : /did NOT happen/);
    }
  });

  it("with no screen to show the card, the action stays waiting and the model is told it has not happened", async () => {
    respond = () => ({ record: record("waiting-approval") });
    const result = await executeHANNAHTool(sendTool, { to: "a@b.example", subject: "s", body: "b" }) as { status: string };
    expect(result.status).toBe("waiting-approval");
    expect(calls).toHaveLength(1);
  });

  it("without an account the tool keeps its own approval on this device", async () => {
    signedIn = false;
    const screen = host(true);
    const result = await executeHANNAHTool(sendTool, { to: "a@b.example", subject: "s", body: "b" });
    screen.detach();
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ sent: true, legacy: true });
    expect(getOperatorTools()).toEqual([]);
  });
});

describe("actions the device performs itself", () => {
  const writeTool: Tool = { name: "write_app_file", description: "", inputSchema: { type: "object", properties: {} }, requiresApproval: true, sensitive: "write_file", execute: vi.fn(async () => ({ written: true })) };
  // A block body: a value returned from beforeEach would be run as the test's cleanup.
  beforeEach(() => { (writeTool.execute as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue({ written: true }); });

  it("a standing permission lets it run without a card, and the outcome is reported", async () => {
    respond = (call) => ({ record: record(call.path === "/api/actions" ? "authorized" : "done", { action: "files.write", executor: "device" }) });
    const screen = host(false);
    await expect(executeHANNAHTool(writeTool, { path: "notes/today.md", content: "hello" })).resolves.toEqual({ written: true });
    screen.detach();
    await vi.waitFor(() => expect(calls.some((call) => call.path.endsWith("/report"))).toBe(true));
    expect(screen.seen).toEqual([]);
    expect(calls[0].body).toMatchObject({ action: "files.write", params: { target: "notes/today.md", tool: "write_app_file" } });
    expect(JSON.stringify(calls[0].body)).toContain("Path: notes/today.md");
    expect(calls.find((call) => call.path.endsWith("/report"))!.body).toMatchObject({ ok: true, verification: { confirmed: true } });
  });

  it("read-only or the emergency stop refuses it before the device does anything", async () => {
    respond = () => ({ record: record("denied", { outcome: "Not allowed: Write a file. Files is set to Read only." }) });
    await expect(executeHANNAHTool(writeTool, { path: "a.md", content: "x" })).rejects.toThrow(/Files is set to Read only/);
    expect(writeTool.execute).not.toHaveBeenCalled();
  });

  it("a failure on the device is reported as a failure", async () => {
    respond = (call) => ({ record: record(call.path === "/api/actions" ? "authorized" : "failed") });
    (writeTool.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Disk full"));
    await expect(executeHANNAHTool(writeTool, { path: "a.md", content: "x" })).rejects.toThrow("Disk full");
    await vi.waitFor(() => expect(calls.find((call) => call.path.endsWith("/report"))?.body).toEqual({ ok: false, error: "Disk full" }));
  });

  it("when the server can't be reached, HANNAH asks on this device as before", async () => {
    respond = () => new Error("Couldn't reach the HANNAH server.");
    const screen = host(true);
    await expect(executeHANNAHTool(writeTool, { path: "a.md", content: "x" })).resolves.toEqual({ written: true });
    screen.detach();
    expect(screen.seen[0]).toContain("Create or replace this file");
  });
});

describe("tools every agent gets", () => {
  const tool = (name: string) => getOperatorTools({ calendar: true }).find((item) => item.name === name)!;

  it("offers scheduling, messaging and code tools to a signed-in account; calendar ones only with a calendar", () => {
    const names = getOperatorTools({ calendar: true }).map((item) => item.name);
    expect(names).toEqual(expect.arrayContaining(["calendar_find_free_time", "calendar_schedule", "calendar_update_event", "calendar_delete_event", "message_people", "message_send", "code_repos", "code_overview", "code_search", "code_read_file", "code_github", "code_scan", "code_change", "code_publish", "code_task"]));
    expect(getOperatorTools().some((item) => item.name.startsWith("calendar_"))).toBe(false);
  });

  it("an ambiguous recipient is the server's refusal, passed on, not a guess", async () => {
    respond = () => Object.assign(new Error("More than one person on asha_bot matches “Rahul”. Use their id."), { reason: "ambiguous-recipient" });
    await expect(tool("message_send").execute({ channel: "telegram", to: "Rahul", text: "hi" })).rejects.toThrow(/More than one person/);
    expect(calls[0].body).toMatchObject({ action: "messages.send", params: { channel: "telegram", to: "Rahul", text: "hi" } });
  });

  it("a scan's findings say how each is known and never claim the repository is clean", async () => {
    const task = { id: "t1", repoId: "gh:a/b", repo: "a/b", kind: "scan", title: "Scan a/b", status: "completed", stage: "done", request: "", summary: "2 findings", createdAt: 1, updatedAt: 1, base: { sha: "abcdef1234", branch: "main", defaultBranch: "main" }, coverage: { files: 12, skipped: 1, truncated: false }, reviewed: { files: ["src/a.js"], dropped: 1, batches: 1 }, dependencies: { checked: 0, vulnerable: 0, note: "No lock file" },
      findings: [{ rule: "secret", severity: "critical", confidence: "certain", source: "check", file: "src/config.js", line: 4, title: "AWS access key in the repository", detail: "…", evidence: "const k = \"‹redacted›\";" }, { rule: "review-logic", severity: "high", confidence: "suspected", source: "review", file: "src/a.js", line: 9, title: "Off by one", detail: "…", evidence: "i <= n" }] };
    const streamed = `data: ${JSON.stringify({ type: "stage", message: "Reading a/b" })}\n\ndata: ${JSON.stringify({ type: "result", task })}\n\n`;
    const fetchMock = vi.fn(async () => new Response(streamed, { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await tool("code_scan").execute({ repo: "a/b", focus: "secrets" }) as { findings: Array<{ howKnown: string; where: string }>; note: string; coverage: { reviewedByModel: number } };
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ repoId: "a/b", kind: "scan", request: "secrets", options: { reviewBatches: 4 } });
    expect(result.findings.map((item) => item.howKnown)).toEqual(["a check of the text; certain", "suspected by reading the code; not reproduced"]);
    expect(result.findings[0].where).toBe("src/config.js:4");
    expect(result.coverage.reviewedByModel).toBe(1);
    expect(result.note).toMatch(/Don't call the repository bug-free/);
    vi.unstubAllGlobals();
    vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }, confirm: vi.fn(() => true) }));
  });

  it("a coding task that needs approval to run the project's tests asks on the card, then continues", async () => {
    const waiting = { id: "t2", kind: "change", status: "waiting-approval", stage: "verify", pending: { action: "act-9", what: "run “test”" } };
    const ready = { ...waiting, status: "ready", stage: "ready", pending: undefined };
    respond = (call) => ({ record: record(call.path.endsWith("/decision") ? "done" : "waiting-approval", { id: "act-9", action: "code.run", preview: { title: "Run “test” in shop", lines: [{ label: "Command", value: "npm run test --silent" }] } }) });
    const continued = vi.spyOn(Operator.code, "continue").mockResolvedValue(ready as never);
    const screen = host(true);
    const task = await Operator.code.drive(Promise.resolve(waiting as never));
    screen.detach();
    expect(task.status).toBe("ready");
    expect(screen.seen[0]).toContain("Command: npm run test --silent");
    expect(calls.map((call) => call.path)).toEqual(["/api/actions/act-9", "/api/actions/act-9/decision"]);
    expect(continued).toHaveBeenCalledTimes(1);
  });
});
