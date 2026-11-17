"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { evaluate, resolveValue, checkExpressions } = require("./expressions");
const { checkUrl } = require("./http");
const { execute, executeSingleNode, nextScheduledRun, permissionManifest, validateWorkflow, sanitize } = require("./engine");

const workflow = { id: "wf-1", name: "Invoices", timezone: "Asia/Kolkata" };
const base = (nodes, connections, settings = {}) => ({ format: "hannah-workflow", version: 2, nodes, connections, settings });
const connect = (source, target, sourceOutput = "main", targetInput = "main") => ({ id: `${source}-${target}-${sourceOutput}`, source, target, sourceOutput, targetInput });

function fakeServices(overrides = {}) {
  const calls = { ai: [], notify: [], mail: [], memory: [] };
  return {
    calls,
    services: {
      ai: async (request) => {
        calls.ai.push(request);
        if (request.json) return { text: JSON.stringify({ vendor: "Acme Supplies", amount: "1,250.50", date: "2026-11-02" }), model: "fake-model", provider: "fake" };
        return { text: `answer to: ${request.prompt.slice(0, 40)}`, model: "fake-model", provider: "fake" };
      },
      notify: async (message) => { calls.notify.push(message); return { id: `n${calls.notify.length}` }; },
      mail: async (mail) => { calls.mail.push(mail); return { sent: mail.mode === "send", draft: mail.mode === "draft" }; },
      appendAccountItem: async (namespace, item) => { calls.memory.push({ namespace, item }); return { id: "m1", ...item }; },
      searchMemories: async () => [{ content: "Invoices over 1000 need Riya's sign-off" }],
      credential: async () => null,
      ...overrides,
    },
  };
}

const run = (definition, options = {}) => execute({
  definition,
  execution: { id: "ex-1", mode: "manual", triggerNodeId: definition.nodes[0].id, triggerData: options.triggerData, state: options.state },
  workflow,
  services: options.services ?? fakeServices().services,
  signal: options.signal,
  resume: options.resume,
  sleep: options.sleep ?? (async () => {}),
  onCheckpoint: options.onCheckpoint,
});

describe("expressions", () => {
  it("reads item data, compares, does arithmetic and calls the built-in functions", () => {
    const scope = { $json: { amount: "1,250.50", vendor: "Acme", lines: [{ qty: 2 }, { qty: 3 }] }, $node: { Extract: { json: { vendor: "Acme" } } } };
    assert.equal(evaluate("$json.amount > 1000", scope), true);
    assert.equal(evaluate("number($json.amount) * 2", scope), 2501);
    assert.equal(evaluate("$json.lines[1].qty + $json.lines.length", scope), 5);
    assert.equal(evaluate("$node['Extract'].json.vendor", scope), "Acme");
    assert.equal(evaluate("upper($json.vendor) + '!'", scope), "ACME!");
    assert.equal(evaluate("$json.missing ?? 'none'", scope), "none");
    assert.equal(evaluate("$json.amount > 2000 ? 'big' : 'small'", scope), "small");
    assert.equal(resolveValue("{{ $json.lines }}", scope).length, 2, "a whole-value expression keeps its type");
    assert.equal(resolveValue("Total {{ $json.amount }} from {{ $json.vendor }}", scope), "Total 1,250.50 from Acme");
    assert.deepEqual(resolveValue({ to: "{{ $json.vendor }}", list: ["{{ 1 + 1 }}"] }, scope), { to: "Acme", list: [2] });
  });

  it("can't reach prototypes, call methods or run code", () => {
    const scope = { $json: { text: "hi" } };
    assert.throws(() => evaluate("$json.constructor", scope), /can't be read/);
    assert.throws(() => evaluate("$json['__proto__']", scope), /can't be read/);
    assert.throws(() => evaluate("$json.text.toUpperCase()", scope), /built-in functions/);
    assert.throws(() => evaluate("process.exit(1)", scope), /Unknown function|built-in/);
    assert.throws(() => evaluate("require('fs')", scope), /Unknown function/);
    assert.throws(() => evaluate("globalThis", scope), /Unknown name/);
    assert.equal(evaluate("$json.toString", scope), undefined, "only own properties are readable");
    assert.deepEqual(checkExpressions({ a: "{{ $json.amount > }}", b: "{{ ok }} fine" }).length, 1);
    assert.match(checkExpressions("{{ $json.a ")[0], /unbalanced/);
  });
});

describe("outbound requests", () => {
  it("refuses internal addresses, odd schemes and credentials in URLs", () => {
    for (const url of ["http://localhost:3000/x", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/", "http://[::1]/", "http://192.168.1.1/", "file:///etc/passwd", "https://user:pass@example.com/", "http://metadata.google.internal/"]) {
      assert.throws(() => checkUrl(url), /internal|only call http|credentials/, url);
    }
    assert.equal(checkUrl("https://api.github.com/repos/a/b").host, "api.github.com");
  });
});

describe("validation", () => {
  it("accepts a correct workflow and reports what's wrong with a broken one", () => {
    const good = base([{ id: "t", name: "Start", type: "trigger.manual" }, { id: "a", name: "Ask", type: "ai.prompt", params: { prompt: "Hi {{ $json.name }}" } }], [connect("t", "a")]);
    assert.deepEqual(validateWorkflow(good).errors, []);

    const broken = base([
      { id: "t", name: "Start", type: "trigger.manual" },
      { id: "h", name: "Call", type: "action.http", params: { url: "" } },
      { id: "x", name: "Mystery", type: "nope.nope" },
      { id: "i", name: "Check", type: "logic.if", params: { conditions: [{ left: "{{ $json.a > }}", operator: "gt", right: "1" }] } },
      { id: "s", name: "Slack", type: "action.slack", params: { text: "hi" } },
      { id: "lonely", name: "Lonely", type: "data.set" },
      { id: "c1", name: "Loop A", type: "data.set" },
      { id: "c2", name: "Loop B", type: "data.set" },
      { id: "e", name: "Email trigger", type: "trigger.email" },
    ], [connect("t", "h"), connect("h", "i"), connect("i", "s", "maybe"), connect("c1", "c2"), connect("c2", "c1"), connect("h", "t")]);
    const { errors, warnings } = validateWorkflow(broken);
    const text = errors.map((error) => error.message).join(" | ");
    assert.match(text, /URL is required/);
    assert.match(text, /Unknown node type “nope.nope”/);
    assert.match(text, /Conditions: .*Expected|Conditions: .*ends too early/);
    assert.match(text, /has no output called maybe/);
    assert.match(text, /Choose a slackWebhook credential/);
    assert.match(text, /form a loop/);
    assert.match(text, /trigger and can't have incoming/);
    assert.match(text, /isn't available yet/);
    assert.ok(warnings.some((warning) => warning.message.includes("“Lonely” isn't connected")));
  });

  it("checks schedules, including the 5-minute minimum and time zones", () => {
    const schedule = (params, settings) => validateWorkflow(base([{ id: "t", name: "Every", type: "trigger.schedule", params }], [], settings)).errors.map((error) => error.message).join(" ");
    assert.equal(schedule({ mode: "cron", cron: "30 7 * * 1-5" }), "");
    assert.match(schedule({ mode: "cron", cron: "* * * * *" }), /at most every 5 minutes/);
    assert.match(schedule({ mode: "cron", cron: "61 7 * * *" }), /isn't valid/);
    assert.match(schedule({ mode: "interval", minutes: 1 }), /5 to 10,080/);
    assert.match(schedule({ mode: "daily", time: "8am" }), /look like 08:00|expected format/);
    assert.match(schedule({ mode: "daily", time: "08:00" }, { timezone: "Mars/Olympus" }), /isn't a time zone/);
    // 07:30 on weekdays in India, asked on Friday 08:30 IST: next is Monday 07:30 IST.
    assert.equal(new Date(nextScheduledRun({ mode: "weekly", time: "07:30", days: [1, 2, 3, 4, 5] }, "Asia/Kolkata", Date.parse("2026-11-20T03:00:00Z"))).toISOString(), "2026-11-23T02:00:00.000Z");
  });

  it("lists what a workflow may do before it's activated", () => {
    const definition = base([{ id: "t", name: "Start", type: "trigger.webhook" }, { id: "m", name: "Mail", type: "action.email", params: { mode: "send", approval: "on-activation", to: "a@b.c", subject: "s", body: "b" } }, { id: "h", name: "Call", type: "action.http", params: { url: "https://x.dev" } }], [connect("t", "m"), connect("m", "h")]);
    assert.deepEqual(permissionManifest(definition).map((entry) => entry.permission), ["network", "receive-webhooks", "send-email", "send-email-without-asking"]);
  });
});

describe("execution", () => {
  const invoice = base([
    { id: "t", name: "Invoice webhook", type: "trigger.webhook" },
    { id: "x", name: "Extract", type: "ai.extract", params: { text: "{{ $json.body.text }}" } },
    { id: "i", name: "Over 1000", type: "logic.if", params: { conditions: [{ left: "{{ $json.amount }}", operator: "gt", right: "1000" }] } },
    { id: "big", name: "Flag", type: "data.set", params: { fields: [{ name: "review", value: "{{ 'Needs sign-off: ' + $node['Extract'].json.vendor }}" }] } },
    { id: "small", name: "Auto approve", type: "data.set", params: { fields: [{ name: "review", value: "auto" }] } },
    { id: "n", name: "Notify", type: "action.notify", params: { title: "Invoice from {{ $json.vendor }}", body: "{{ $json.review }} ({{ $json.amount }})" } },
  ], [connect("t", "x"), connect("x", "i"), connect("i", "big", "true"), connect("i", "small", "false"), connect("big", "n")]);

  it("passes real data through every node: webhook → extract → condition → set → notify", async () => {
    const { services, calls } = fakeServices();
    const checkpoints = [];
    const result = await run(invoice, { services, triggerData: { body: { text: "INVOICE Acme Supplies total 1,250.50 due 2026-11-02" } }, onCheckpoint: async (_state, event) => checkpoints.push(`${event.nodeId}:${event.status}`) });
    assert.equal(result.status, "completed");
    assert.match(calls.ai[0].prompt, /INVOICE Acme Supplies total 1,250.50/, "the extractor saw the webhook's text");
    assert.deepEqual(calls.notify, [{ title: "Invoice from Acme Supplies", body: "Needs sign-off: Acme Supplies (1250.5)" }]);
    assert.equal(result.state.nodes.small.status, "skipped", "the false branch got no items");
    assert.equal(result.state.nodes.x.outputs.main[0].json.amount, 1250.5, "numbers were typed by the extractor");
    assert.ok(checkpoints.includes("x:done") && checkpoints.indexOf("x:done") < checkpoints.indexOf("n:done"), "checkpoints in order");
  });

  it("retries a failing node with backoff, then fails the run with the node named", async () => {
    let attempts = 0;
    const sleeps = [];
    const { services } = fakeServices({ notify: async () => { attempts += 1; throw Object.assign(new Error("Service unavailable"), { retryable: true }); } });
    const definition = base([{ id: "t", name: "Start", type: "trigger.manual" }, { id: "n", name: "Ping", type: "action.notify", params: { title: "x", body: "y" }, settings: { retries: 2, retryDelayMs: 1000 } }], [connect("t", "n")]);
    const result = await run(definition, { services, sleep: async (ms) => sleeps.push(ms) });
    assert.equal(result.status, "failed");
    assert.equal(attempts, 3);
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[1] > sleeps[0], "exponential backoff");
    assert.equal(result.errorNode, "n");
    assert.match(result.error, /Ping: Service unavailable \(after 3 attempts\)/);
  });

  it("continues past a failing node only when told to, and says so", async () => {
    const { services } = fakeServices({ notify: async () => { throw Object.assign(new Error("down"), { retryable: false }); } });
    const definition = base([{ id: "t", name: "Start", type: "trigger.manual" }, { id: "n", name: "Ping", type: "action.notify", params: { title: "x", body: "y" }, settings: { continueOnFail: true } }, { id: "s", name: "After", type: "data.set", params: { fields: [{ name: "seen", value: "{{ $json.error }}" }] } }], [connect("t", "n"), connect("n", "s")]);
    const result = await run(definition, { services });
    assert.equal(result.status, "completed");
    assert.match(result.error, /1 step failed and continued/);
    assert.equal(result.state.nodes.s.outputs.main[0].json.seen, "down");
  });

  it("stops before the next node when cancelled", async () => {
    const controller = new AbortController();
    const { services } = fakeServices({ notify: async () => { controller.abort(new Error("Cancelled from another device.")); return { id: "n1" }; } });
    const definition = base([{ id: "t", name: "Start", type: "trigger.manual" }, { id: "n", name: "Ping", type: "action.notify", params: { title: "x", body: "y" } }, { id: "s", name: "After", type: "data.set" }], [connect("t", "n"), connect("n", "s")]);
    const result = await run(definition, { services, signal: controller.signal });
    assert.equal(result.status, "cancelled");
    assert.equal(result.state.nodes.s, undefined, "the next node never ran");
  });

  it("waits for approval, then continues on approve and routes to denied on deny", async () => {
    const definition = base([{ id: "t", name: "Start", type: "trigger.manual" }, { id: "a", name: "OK?", type: "logic.approval", params: { message: "Pay {{ $json.amount }}?" } }, { id: "yes", name: "Paid", type: "data.set" }, { id: "no", name: "Refused", type: "data.set" }], [connect("t", "a"), connect("a", "yes", "approved"), connect("a", "no", "denied")]);
    const first = await run(definition, { triggerData: { amount: 90 } });
    assert.equal(first.status, "waiting-approval");
    assert.equal(first.waiting.message, "Pay 90?");
    const approved = await run(definition, { state: structuredClone(first.state), resume: { nodeId: "a", approved: true } });
    assert.equal(approved.status, "completed");
    assert.equal(approved.state.nodes.yes.status, "done");
    assert.equal(approved.state.nodes.no.status, "skipped");
    const denied = await run(definition, { state: structuredClone(first.state), resume: { nodeId: "a", approved: false } });
    assert.equal(denied.state.nodes.no.status, "done");
    assert.equal(denied.state.nodes.yes.status, "skipped");
  });

  it("asks before sending an email on every run, and a denial cancels without sending", async () => {
    const { services, calls } = fakeServices();
    const definition = base([{ id: "t", name: "Start", type: "trigger.manual" }, { id: "m", name: "Mail", type: "action.email", params: { mode: "send", to: "{{ $json.to }}", subject: "Hi", body: "Body" } }], [connect("t", "m")]);
    const first = await run(definition, { services, triggerData: { to: "sam@example.com" } });
    assert.equal(first.status, "waiting-approval");
    assert.equal(first.waiting.details.to, "sam@example.com", "the approval shows what will be sent");
    assert.equal(calls.mail.length, 0, "nothing sent before approval");
    const denied = await run(definition, { services, state: structuredClone(first.state), resume: { nodeId: "m", approved: false } });
    assert.equal(denied.status, "cancelled");
    assert.equal(calls.mail.length, 0);
    const approved = await run(definition, { services, state: structuredClone(first.state), resume: { nodeId: "m", approved: true } });
    assert.equal(approved.status, "completed");
    assert.deepEqual(calls.mail.map((mail) => mail.to), ["sam@example.com"]);
  });

  it("resumes after an interruption without re-running finished nodes", async () => {
    let notified = 0;
    const { services } = fakeServices({ notify: async () => { notified += 1; return { id: "n" }; } });
    const definition = base([{ id: "t", name: "Start", type: "trigger.manual" }, { id: "n", name: "Ping", type: "action.notify", params: { title: "x", body: "y" } }, { id: "s", name: "After", type: "data.set" }], [connect("t", "n"), connect("n", "s")]);
    // Simulate a worker that died after "Ping" finished.
    const partial = { nodes: { t: { status: "done", outputs: { main: [{ json: {} }] } }, n: { status: "done", outputs: { main: [{ json: { done: true } }] } } } };
    const result = await run(definition, { services, state: partial });
    assert.equal(result.status, "completed");
    assert.equal(notified, 0, "Ping didn't run again");
    assert.equal(result.state.nodes.s.outputs.main[0].json.done, true);
  });

  it("splits a list into items, merges branches and aggregates sums", async () => {
    const definition = base([
      { id: "t", name: "Start", type: "trigger.manual", params: { sample: { lines: [{ sku: "a", qty: 2 }, { sku: "b", qty: 5 }, { sku: "c", qty: 1 }] } } },
      { id: "sp", name: "Each line", type: "logic.split", params: { field: "lines" } },
      { id: "f", name: "Big", type: "logic.filter", params: { conditions: [{ left: "{{ $json.qty }}", operator: "gte", right: "2" }] } },
      { id: "ag", name: "Total", type: "logic.aggregate", params: { sum: "qty" } },
    ], [connect("t", "sp"), connect("sp", "f"), connect("f", "ag")]);
    const result = await run(definition);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.state.nodes.ag.outputs.main[0].json, { items: [{ sku: "a", qty: 2, $index: 0 }, { sku: "b", qty: 5, $index: 1 }], count: 2, sum_qty: 7 });
  });

  it("tests a single node with given input", async () => {
    const { services } = fakeServices();
    const result = await executeSingleNode({ node: { id: "s", name: "Set", type: "data.set", params: { fields: [{ name: "double", value: "{{ $json.n * 2 }}" }] } }, items: [{ json: { n: 21 } }], workflow, services });
    assert.equal(result.status, "done");
    assert.equal(result.outputs.main[0].json.double, 42);
  });

  it("hides secrets in what it shows", () => {
    assert.deepEqual(sanitize({ headers: { authorization: "Bearer x" }, apiKey: "abc", note: "gsk_abcdefghijklmnopqrstuvwxyz0123", ok: "fine" }), { headers: { authorization: "[redacted]" }, apiKey: "[redacted]", note: "[redacted]", ok: "fine" });
  });
});
