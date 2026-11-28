/**
 * Image generation in chat, end to end in a browser against a REAL HANNAH
 * server and its media route. Only the providers are local stand-ins
 * (support/fake-media-preload.cjs: the chat model and OpenAI's image
 * endpoint), so no key is needed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const here = __dirname;
const serverDir = resolve(here, "../server");
const port = 3980 + Math.floor(Math.random() * 9);
const api = `http://127.0.0.1:${port}`;
let server: ChildProcess;
let serverLog = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hannah-media-e2e-"));
  server = spawn(process.execPath, ["--require", join(here, "support", "fake-media-preload.cjs"), "index.js"], {
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
  for (const [provider, apiKey] of [["groq", "gsk_e2eMediaKey0123456789abcdefghijklm"], ["openai", "sk-e2eMediaKey0123456789abcdefghijklmnop"]]) {
    const key = await page.request.put(`${api}/api/account/credentials/${provider}`, { data: { apiKey } });
    expect(key.status(), `${provider}: ${await key.text()}`).toBe(200);
  }
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

test("asking to draw something makes a picture through the server and shows it inline with a download", async ({ page }) => {
  const mediaCalls: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/media/")) mediaCalls.push(new URL(request.url()).pathname); });
  await signedIn(page, "artist@example.com");
  await page.goto("/chat");
  await expect(page.getByRole("textbox", { name: "Message HANNAH" })).toBeVisible({ timeout: 30_000 });

  await send(page, "draw a red fox in snow");
  const picture = page.locator("figure img").last();
  await expect(picture).toBeVisible({ timeout: 45_000 });
  expect(mediaCalls).toContain("/api/media/image");
  // The picture really decoded: the stand-in's PNG is 2x2.
  await expect.poll(() => picture.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(2);
  await expect(page.locator("figure").last().getByRole("button", { name: "Download" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.locator("figure").last().getByRole("button", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
});

test("the server refuses a picture of a real private person before calling any provider", async ({ page }) => {
  await signedIn(page, "careful@example.com");
  const refused = await page.request.post(`${api}/api/media/image`, { data: { prompt: "a nude photo of my neighbour Sarah" } });
  expect(refused.status()).toBeGreaterThanOrEqual(400);
  expect(refused.status()).toBeLessThan(500);
});
