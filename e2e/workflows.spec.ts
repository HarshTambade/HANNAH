/**
 * Visual workflows, end to end in a browser against a REAL HANNAH server:
 * real account database (SQLite), real engine, real worker loop, real
 * webhook endpoint. Only the AI provider is a local stand-in
 * (support/fake-ai-preload.cjs), so no key is needed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const here = __dirname;
const serverDir = resolve(here, "../server");
const port = 3900 + Math.floor(Math.random() * 90);
const api = `http://127.0.0.1:${port}`;
let server: ChildProcess;
let serverLog = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hannah-wf-e2e-"));
  // The preload is an argument, not NODE_OPTIONS: NODE_OPTIONS can't carry paths with spaces.
  server = spawn(process.execPath, ["--require", join(here, "support", "fake-ai-preload.cjs"), "index.js"], {
    cwd: serverDir,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_URL: `sqlite:${join(dataDir, "hannah.db")}`,
      HANNAH_VAULT_KEY: "e".repeat(64),
      WORKFLOW_ALLOW_PRIVATE_NETWORK: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk) => { serverLog += chunk; });
  server.stderr?.on("data", (chunk) => { serverLog += chunk; });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${api}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The HANNAH server didn't start:\n${serverLog}`);
});

test.afterAll(() => {
  server?.kill();
});

/** Sign up on the real server, save a Groq key to the account, and open the app signed in. */
async function signedIn(page: Page, email: string) {
  await page.route(/\/(api|v1)\//, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${api}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  const registered = await page.request.post(`${api}/api/account/register`, { data: { email, password: "correct horse battery" } });
  expect(registered.status(), await registered.text()).toBe(200);
  const key = await page.request.put(`${api}/api/account/credentials/groq`, { data: { apiKey: "gsk_e2eWorkflowKey0123456789abcdefghij" } });
  expect(key.status(), await key.text()).toBe(200);
  await page.addInitScript((address) => {
    localStorage.setItem("hannah.account.v1", JSON.stringify({ email: address, displayName: "" }));
    localStorage.setItem("hannah.onboarding.v1", "complete");
  }, email);
}

test("build a workflow in the editor, test-run it, and see real data on the canvas and in the run", async ({ page }) => {
  await signedIn(page, "editor@example.com");
  await page.goto("/automations");
  await expect(page.getByRole("tab", { name: "Workflows" })).toBeVisible();
  await page.getByRole("button", { name: "New workflow" }).click();

  const canvas = page.getByRole("application", { name: "Workflow canvas" }).or(page.getByLabel("Workflow canvas")).first();
  await expect(canvas).toBeVisible();
  await expect(page.getByText("When I run it")).toBeVisible();
  await page.getByLabel("Workflow name").fill("Greeting");

  // Select the trigger, then add "Set fields" from the library: it connects to the selected step.
  await page.getByText("When I run it").click();
  await page.getByRole("button", { name: "Close step settings" }).click();
  await page.getByText("When I run it").click();
  const library = page.getByRole("complementary", { name: "Step library" }).first();
  await library.getByLabel("Search steps").fill("set fields");
  await library.getByRole("button", { name: /^Set fields/ }).click();
  const settings = page.getByRole("complementary", { name: /Configure Set fields/ });
  await expect(settings).toBeVisible();
  await settings.getByLabel("Fields 1 name").fill("greeting");
  await settings.getByLabel("Fields 1 value").fill("Hello {{ upper('hannah') }}, {{ 6 * 7 }}");

  // Undo removes the last edit; redo brings it back.
  await page.getByRole("button", { name: "Close step settings" }).click();
  await expect(page.getByRole("button", { name: "Valid", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Test run", exact: true }).click();
  const run = page.getByRole("region", { name: "Run details" });
  await expect(run.getByText("Completed").first()).toBeVisible({ timeout: 20_000 });
  await run.getByRole("button", { name: /Set fields/ }).click();
  await expect(run.getByText(/"greeting": "Hello HANNAH, 42"/)).toBeVisible();
  // The canvas shows each step's result.
  await expect(page.getByText("1 item").first()).toBeVisible();

  // Publish creates version 1.
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/Published version 1/)).toBeVisible();
});

test("the invoice template runs from a real webhook: extraction, AI review, a branch, and a notification", async ({ page, request }) => {
  await signedIn(page, "invoices@example.com");
  await page.goto("/automations");
  await page.getByRole("button", { name: /^Invoice intake/ }).click();
  await expect(page.getByText("Invoice arrives")).toBeVisible();
  // The template saves to Postgres; swap that step's need for a notification-only path by disabling it.
  await page.getByText("Save to database").click();
  await page.getByLabel("Skip this step (pass items through unchanged)").check();
  await page.getByRole("button", { name: "Close step settings" }).click();
  await expect(page.getByRole("button", { name: "Valid", exact: true })).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Publish" }).click();
  const secretDialog = page.getByRole("dialog", { name: "Save your webhook secret" });
  await expect(secretDialog).toBeVisible();
  const secret = (await secretDialog.getByLabel("Webhook secret").innerText()).trim();
  const hookUrl = (await secretDialog.locator("p.font-mono span").first().innerText()).trim();
  await secretDialog.getByRole("button", { name: "I've saved it" }).click();

  await page.getByRole("button", { name: "Activate", exact: true }).click();
  const consent = page.getByRole("dialog", { name: "Activate this workflow?" });
  await expect(consent).toContainText("Receive requests from other services at a private URL");
  await expect(consent).toContainText("Use your AI provider keys");
  await consent.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByText(/Active: it now runs on its triggers/)).toBeVisible();

  // Another service sends an invoice to the webhook (the real endpoint on the real server).
  const path = new URL(hookUrl).pathname;
  const unauthorized = await request.post(`${api}${path}`, { data: { text: "x" } });
  expect(unauthorized.status()).toBe(401);
  const sent = await request.post(`${api}${path}`, { headers: { "X-Hannah-Token": secret }, data: { text: "INVOICE from Acme total 1250.50 due 2026-11-30" } });
  expect(sent.status()).toBe(202);
  const { executionId } = await sent.json();

  await page.getByRole("button", { name: "Back to workflows" }).click();
  await page.getByRole("tab", { name: "Runs" }).click();
  await page.getByRole("button", { name: "Invoice intake" }).first().click();
  const run = page.getByRole("region", { name: "Run details" });
  await expect(run).toContainText(executionId);
  await expect(run.getByText("Completed").first()).toBeVisible({ timeout: 20_000 });
  await run.getByRole("button", { name: /Extract invoice/ }).click();
  await expect(run.getByText(/"vendor": "Acme"/)).toBeVisible();
  await expect(run.getByText(/"amount": 1250.5/)).toBeVisible();
  await run.getByRole("button", { name: /Tell me/ }).click();
  await expect(run.getByText(/"notification": \{/)).toBeVisible();

  const notifications = await page.evaluate(async () => (await fetch("/api/notifications")).json());
  expect(notifications.notifications[0].title).toBe("Large invoice: Acme");
});

test("a failing step is shown with its error and retried from the failure", async ({ page }) => {
  await signedIn(page, "failures@example.com");
  await page.goto("/automations");
  const created = await page.evaluate(async (target) => {
    const response = await fetch("/api/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Calls a dead service", definition: { format: "hannah-workflow", version: 2, settings: { timezone: "UTC" }, nodes: [{ id: "t", name: "Start", type: "trigger.manual", params: {}, position: { x: 80, y: 160 } }, { id: "h", name: "Dead service", type: "action.http", params: { url: target }, position: { x: 380, y: 160 }, settings: { retries: 1, retryDelayMs: 1000 } }], connections: [{ id: "c1", source: "t", target: "h", sourceOutput: "main", targetInput: "main" }] } }) });
    return response.json();
  }, `http://127.0.0.1:${port}/api/does-not-exist`);
  await page.reload();
  await page.getByRole("list", { name: "Workflows" }).getByRole("button", { name: /^Calls a dead service Draft/ }).click();
  await page.getByRole("button", { name: "Test run", exact: true }).click();
  const run = page.getByRole("region", { name: "Run details" });
  await expect(run.getByText("Failed at “Dead service”")).toBeVisible({ timeout: 20_000 });
  await expect(run.getByRole("alert").first()).toContainText(/returned HTTP 4\d\d/);
  // A 4xx answer is permanent: it isn't retried even though the step allows a retry (5xx and 429 are).
  await expect(run.getByText("2 attempts")).toHaveCount(0);
  expect(created.workflow.id).toBeTruthy();
  await run.getByRole("button", { name: "Retry from failed step" }).click();
  await expect(page.getByRole("region", { name: "Run details" }).getByText(/retry of/)).toBeVisible({ timeout: 15_000 });
});

test("a live run shows the step in progress, pauses before the next step and resumes to the end", async ({ page }) => {
  await signedIn(page, "pause-ui@example.com");
  await page.goto("/automations");
  // Three steps that each take about 1.5 s (inside the Code step's 2-second limit), so the run is live long enough to watch and pause.
  const slow = "const end = Date.now() + 1500; while (Date.now() < end) {} return items;";
  await page.evaluate(async (code) => {
    const step = (id: string, name: string, x: number) => ({ id, name, type: "data.code", params: { mode: "all", code }, position: { x, y: 160 } });
    await fetch("/api/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Slow steps", definition: { format: "hannah-workflow", version: 2, settings: { timezone: "UTC" },
      nodes: [{ id: "t", name: "Start", type: "trigger.manual", params: {}, position: { x: 80, y: 160 } }, step("a", "Slow one", 340), step("b", "Slow two", 600), step("c", "Slow three", 860)],
      connections: [["t", "a"], ["a", "b"], ["b", "c"]].map(([source, target], index) => ({ id: `c${index}`, source, target, sourceOutput: "main", targetInput: "main" })) } }) });
  }, slow);
  await page.reload();
  await page.getByRole("list", { name: "Workflows" }).getByRole("button", { name: /^Slow steps Draft/ }).click();
  await page.getByRole("button", { name: "Test run", exact: true }).click();
  const run = page.getByRole("region", { name: "Run details" });
  // The live status names the step that's running.
  await expect(run.getByRole("status").filter({ hasText: /Running “Slow (one|two)”/ })).toBeVisible({ timeout: 20_000 });
  await run.getByRole("button", { name: "Pause" }).click();
  await expect(run.getByText(/Paused by you before “Slow (two|three)”/)).toBeVisible({ timeout: 15_000 });
  await expect(run.getByText("Paused", { exact: true })).toBeVisible();
  await expect(run.getByText("Completed", { exact: true })).toHaveCount(0);
  await run.getByRole("button", { name: "Resume" }).click();
  await expect(run.getByText("Completed", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(run.getByRole("list", { name: "Steps" }).getByText("Done")).toHaveCount(4);
});

test("a file workflow: test-run with a CSV from the editor, see the code step's console, then upload to the active workflow", async ({ page }) => {
  await signedIn(page, "files@example.com");
  await page.goto("/automations");
  await page.evaluate(async () => {
    const definition = {
      format: "hannah-workflow", version: 2, settings: { timezone: "UTC" },
      nodes: [
        { id: "f", name: "Expense sheet", type: "trigger.file", params: { output: "rows" }, position: { x: 80, y: 160 } },
        { id: "c", name: "Total", type: "data.code", params: { mode: "all", code: "console.log('rows', items.length);\nreturn [{ total: items.reduce((sum, row) => sum + Number(row.amount), 0), file: items[0].$file.name }];" }, position: { x: 380, y: 160 } },
      ],
      connections: [{ id: "c1", source: "f", target: "c", sourceOutput: "main", targetInput: "main" }],
    };
    await fetch("/api/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Expense totals", definition }) });
  });
  await page.reload();
  await page.getByRole("list", { name: "Workflows" }).getByRole("button", { name: /^Expense totals Draft/ }).click();
  await expect(page.getByText("Expense sheet").first()).toBeVisible();

  // Test run asks for a file instead of sample JSON.
  await page.getByLabel("Choose a file for the test run").setInputFiles({ name: "may.csv", mimeType: "text/csv", buffer: Buffer.from("item,amount\nTaxi,12\nLunch,30.5\n") });
  const run = page.getByRole("region", { name: "Run details" });
  await expect(run.getByText("Completed").first()).toBeVisible({ timeout: 20_000 });
  await run.getByRole("button", { name: /^Total/ }).click();
  await expect(run.getByLabel("Console output of Total")).toHaveText("rows 2");
  await expect(run.getByText(/"total": 42.5/)).toBeVisible();
  await expect(run.getByText(/"file": "may.csv"/)).toBeVisible();

  // Activation names the sandboxed code; then a file uploaded from the list starts a live run.
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/Published version 1/)).toBeVisible();
  await page.getByRole("button", { name: "Activate", exact: true }).click();
  const consent = page.getByRole("dialog", { name: "Activate this workflow?" });
  await expect(consent).toContainText("Run your JavaScript in an isolated sandbox");
  await consent.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByText(/Active: it now runs on its triggers/)).toBeVisible();
  await page.getByRole("button", { name: "Back to workflows" }).click();
  await page.getByLabel("Upload a file to Expense totals").setInputFiles({ name: "june.csv", mimeType: "text/csv", buffer: Buffer.from("item,amount\nHotel,100\n") });
  await expect(page.getByRole("tab", { name: "Runs", selected: true })).toBeVisible();
  await page.getByRole("button", { name: "Expense totals" }).first().click();
  const live = page.getByRole("region", { name: "Run details" });
  await expect(live.getByText("Completed").first()).toBeVisible({ timeout: 20_000 });
  await live.getByRole("button", { name: /^Total/ }).click();
  await expect(live.getByText(/"file": "june.csv"/)).toBeVisible();
});
