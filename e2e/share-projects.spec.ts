/**
 * Shared conversation links and projects, end to end in a browser against a
 * REAL HANNAH server (SQLite account database). Only the AI provider is a
 * local stand-in (support/fake-ai-preload.cjs), so no key is needed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const here = __dirname;
const serverDir = resolve(here, "../server");
const port = 3990 + Math.floor(Math.random() * 9);
const api = `http://127.0.0.1:${port}`;
let server: ChildProcess;
let serverLog = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hannah-share-e2e-"));
  server = spawn(process.execPath, ["--require", join(here, "support", "fake-ai-preload.cjs"), "index.js"], {
    cwd: serverDir,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_URL: `sqlite:${join(dataDir, "hannah.db")}`,
      HANNAH_VAULT_KEY: "e".repeat(64),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk) => { serverLog += chunk; });
  server.stderr?.on("data", (chunk) => { serverLog += chunk; });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${api}/api/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`The HANNAH server didn't start:\n${serverLog}`);
});

test.afterAll(() => {
  server?.kill();
});

/** Every API call goes to the real server; the agent requests are recorded. */
async function signedIn(page: Page, email: string, agentBodies: Array<Record<string, unknown>> = []) {
  await page.route(/\/(api|v1)\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/agent") {
      try { agentBodies.push(JSON.parse(route.request().postData() || "{}")); } catch { /* not JSON */ }
    }
    const response = await route.fetch({ url: `${api}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  const registered = await page.request.post(`${api}/api/account/register`, { data: { email, password: "correct horse battery" } });
  expect(registered.status(), await registered.text()).toBe(200);
  const key = await page.request.put(`${api}/api/account/credentials/groq`, { data: { apiKey: "gsk_e2eShareKey0123456789abcdefghijklm" } });
  expect(key.status(), await key.text()).toBe(200);
  await page.addInitScript((address) => {
    localStorage.setItem("hannah.account.v1", JSON.stringify({ email: address, displayName: "" }));
    localStorage.setItem("hannah.onboarding.v1", "complete");
  }, email);
}

async function send(page: Page, text: string) {
  const box = page.getByRole("textbox", { name: "Message HANNAH" });
  await box.fill(text);
  await box.press("Enter");
}

test("share a chat as a read-only link, open it without signing in, then delete it", async ({ page, browser }) => {
  await signedIn(page, "sharer@example.com");
  await page.goto("/chat");
  await expect(page.getByRole("textbox", { name: "Message HANNAH" })).toBeVisible({ timeout: 30_000 });
  await send(page, "Plan a picnic for Saturday <script>alert(1)</script>");
  await expect(page.getByText(/Reviewed:|picnic/i).last()).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Share this chat as a read-only link" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Your chat history stays on this device.", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: /^Publish \d+ messages?/ }).click();
  const link = await dialog.getByLabel("Shared link").inputValue();
  expect(link).toMatch(/\/s\/[\w-]+$/);
  const id = link.split("/s/")[1];

  // The public page, from the real server, for someone who isn't signed in.
  const visitor = await browser.newContext();
  const shared = await visitor.request.get(`${api}/s/${id}`);
  expect(shared.status()).toBe(200);
  const headers = shared.headers();
  expect(headers["content-security-policy"]).toContain("script-src 'none'");
  expect(headers["x-robots-tag"]).toContain("noindex");
  expect(headers["cache-control"]).toContain("no-store");
  const html = await shared.text();
  expect(html).toContain("Plan a picnic for Saturday");
  // The message's markup is shown as text, never run.
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&lt;script&gt;");
  const view = await visitor.newPage();
  await view.goto(`${api}/s/${id}`);
  await expect(view.getByText("Plan a picnic for Saturday", { exact: false }).last()).toBeVisible();
  await expect(view.locator("script")).toHaveCount(0);

  // Deleting the link stops it at once.
  page.once("dialog", (confirm) => void confirm.accept());
  await dialog.getByRole("button", { name: /^Delete the link/ }).first().click();
  await expect.poll(async () => (await visitor.request.get(`${api}/s/${id}`)).status()).toBe(404);
  await visitor.close();
});

test("a project's instructions go with every request in that project", async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = [];
  await signedIn(page, "projects@example.com", bodies);
  await page.goto("/chat");
  await expect(page.getByRole("textbox", { name: "Message HANNAH" })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Projects" }).click();
  const panel = page.getByRole("dialog");
  await panel.getByLabel("New project name").fill("Garden");
  await panel.getByRole("button", { name: "Create" }).click();
  await panel.getByRole("textbox").last().fill("Always answer as a gardener and mention the season.");
  await panel.getByRole("button", { name: "Save" }).click();
  await panel.getByRole("button", { name: "Move the open chat here" }).click();
  await panel.getByRole("button", { name: "Close projects" }).click();
  await expect(page.getByRole("button", { name: "Projects. This chat is in Garden" })).toBeVisible();

  await send(page, "What should I plant?");
  await expect.poll(() => bodies.length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(bodies.at(-1)?.project).toEqual({ name: "Garden", instructions: "Always answer as a gardener and mention the season." });

  // After a reload the chat is still in the project.
  await page.reload();
  await expect(page.getByRole("button", { name: "Projects. This chat is in Garden" })).toBeVisible({ timeout: 30_000 });
});
