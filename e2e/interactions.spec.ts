import { expect, test, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Press every control on every screen, signed in against a real server with a
 * database, and fail on any uncaught error, console error or 5xx it causes.
 * Native confirm dialogs are dismissed, so nothing destructive is confirmed;
 * a control that navigates away is followed by going back to the screen.
 * Groq calls go to a local stand-in (support/fake-ai-preload.cjs).
 */
const here = __dirname;
const serverDir = join(here, "..", "server");
const SCREENS = ["/chat", "/dashboard", "/agents", "/models", "/memory", "/automations", "/actions", "/settings", "/integrations", "/marketplace"];
const IGNORED = [/WebGL|THREE\.|GL_INVALID|webgl/i, /fonts\.(googleapis|gstatic)\.com/i, /play\(\) failed|NotAllowedError/i, /net::ERR_/i, /open-meteo|algolia/i, /getUserMedia|microphone|Permission denied|NotFoundError: Requested device not found/i, /speechSynthesis|SpeechRecognition/i];
// Controls whose job is to leave HANNAH or start an outside sign-in.
const SKIP = /^(sign out|log out|disconnect|connect google|connect microsoft|download|open in|install the app|delete everything|delete my account)/i;

async function startServer(env: Record<string, string>) {
  const port = 5000 + Math.floor(Math.random() * 3000);
  const url = `http://127.0.0.1:${port}`;
  let log = "";
  const child = spawn(process.execPath, ["--require", join(here, "support", "fake-ai-preload.cjs"), "index.js"], {
    cwd: serverDir,
    env: { ...process.env, NODE_ENV: "development", PORT: String(port), HOST: "127.0.0.1", WORKFLOW_WORKER: "off", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${url}/api/health`)).ok) return { child, url }; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The server didn't start:\n${log}`);
}

let api = "";

// One worker for the whole file: the crawl presses hundreds of controls on software-rendered
// pages, and running both setups at once starved the rest of the suite of CPU.
test.describe.configure({ mode: "serial" });

async function proxy(page: Page) {
  await page.route(/\/(api|v1)\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(api).origin) return route.continue();
    await route.fulfill({ response: await route.fetch({ url: `${api}${url.pathname}${url.search}` }) });
  });
}

/** A guest on a server without a database: how the live site runs. */
async function asGuest(page: Page) {
  await proxy(page);
  await page.addInitScript(() => {
    sessionStorage.setItem("hannah.session.groqKey", "gsk_e2eGuestKey0123456789abcdefghijklmn");
    localStorage.setItem("hannah.session.groqKey", "gsk_e2eGuestKey0123456789abcdefghijklmn");
    localStorage.setItem("hannah.onboarding.v1", "complete");
  });
}

async function signIn(page: Page) {
  await proxy(page);
  const email = `clicks-${Date.now()}@example.com`;
  expect((await page.request.post(`${api}/api/account/register`, { data: { email, password: "correct horse battery" } })).status()).toBe(200);
  expect((await page.request.put(`${api}/api/account/credentials/groq`, { data: { apiKey: "gsk_e2eClicksKey0123456789abcdefghijklm" } })).status()).toBe(200);
  await page.addInitScript((address) => {
    localStorage.setItem("hannah.account.v1", JSON.stringify({ email: address, displayName: "" }));
    localStorage.setItem("hannah.onboarding.v1", "complete");
  }, email);
}

for (const mode of ["signed in", "guest"] as const) test.describe(`${mode}`, () => {
  test.describe.configure({ mode: "serial" });
  let server: { child: ReturnType<typeof spawn>; url: string };
  test.beforeAll(async () => {
    server = await startServer(mode === "guest" ? { DATABASE_URL: "" } : { DATABASE_URL: `sqlite:${join(mkdtempSync(join(tmpdir(), "hannah-clicks-")), "hannah.db")}`, HANNAH_VAULT_KEY: "a".repeat(64) });
  });
  test.afterAll(() => { server?.child.kill(); });

for (const screen of SCREENS) {
  test(`every control on ${screen} works without errors`, async ({ page }) => {
    test.setTimeout(240_000);
    api = server.url;
    if (mode === "guest") await asGuest(page);
    else await signIn(page);
    const problems: string[] = [];
    let current = "(load)";
    page.on("pageerror", (error) => problems.push(`[${current}] uncaught: ${error.message}`));
    page.on("console", (message) => {
      // The browser logs every 4xx as "Failed to load resource"; those are judged by status below.
      if (message.type() === "error" && !/Failed to load resource/.test(message.text()) && !IGNORED.some((pattern) => pattern.test(message.text()))) problems.push(`[${current}] console: ${message.text().slice(0, 240)}`);
    });
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (/^\/(api|v1)\//.test(path) && response.status() >= 500) problems.push(`[${current}] server ${response.status()}: ${response.request().method()} ${path}`);
      // A signed-in app calling a route it isn't allowed to use is a bug (the feature can't work for anyone).
      if (/^\/(api|v1)\//.test(path) && (response.status() === 401 || response.status() === 403)) problems.push(`[${current}] refused ${response.status()}: ${response.request().method()} ${path}`);
      // HANNAH_E2E_LOG_4XX=1 also lists refused requests, to trace a console error back to its route.
      if (process.env.HANNAH_E2E_LOG_4XX && /^\/(api|v1)\//.test(path) && response.status() >= 400) void response.text().then((text) => console.log(`[${current}] ${response.status()} ${response.request().method()} ${path} ${text.slice(0, 300)}`)).catch(() => undefined);
    });
    page.on("dialog", (dialog) => void dialog.dismiss());
    await page.goto(screen);
    await page.waitForLoadState("networkidle").catch(() => undefined);

    const seen = new Set<string>();
    for (let round = 0; round < 120; round += 1) {
      // Fresh list each time: a click can open panels with more controls.
      const controls = page.locator("main button:visible, main [role=tab]:visible, main [role=switch]:visible, [role=dialog] button:visible");
      const count = await controls.count();
      let clicked = false;
      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index);
        const name = ((await control.getAttribute("aria-label").catch(() => null)) || (await control.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim().slice(0, 60);
        const key = `${name}#${await control.evaluate((element) => element.outerHTML.length).catch(() => 0)}`;
        if (!name || seen.has(key) || SKIP.test(name) || await control.isDisabled().catch(() => true)) continue;
        seen.add(key);
        current = name;
        await control.click({ timeout: 3000, trial: false }).catch(() => undefined);
        await page.waitForTimeout(250);
        if (!page.url().endsWith(screen)) {
          await page.goto(screen);
          await page.waitForLoadState("networkidle").catch(() => undefined);
        }
        await page.keyboard.press("Escape").catch(() => undefined);
        clicked = true;
        break;
      }
      if (!clicked) break;
    }
    await expect(page.getByRole("heading", { name: /something went wrong|crashed/i })).toHaveCount(0);
    expect(problems, problems.join("\n")).toEqual([]);
  });
}
});
