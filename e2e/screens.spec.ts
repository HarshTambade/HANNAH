import { expect, test, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every screen, the way people actually use HANNAH, against a real server:
 *
 * - signed in, on a server with its database (all account features on);
 * - as a guest with a Groq key, on a server without a database, the way the
 *   live site runs today, where account features must say they're off
 *   instead of failing.
 *
 * A screen passes when it renders its main content with no uncaught error,
 * no console error, and no 5xx from HANNAH's own API. Calls to Groq go to
 * a local stand-in (support/fake-ai-preload.cjs); nothing else is mocked.
 */
const here = __dirname;
const serverDir = join(here, "..", "server");
const SCREENS = ["/chat", "/dashboard", "/agents", "/models", "/memory", "/automations", "/actions", "/settings", "/integrations", "/marketplace", "/"];
// Things a browser reports that aren't HANNAH's bugs: an absent avatar model on a headless GPU, a blocked font, audio autoplay.
const IGNORED = [/WebGL|THREE\.|GL_INVALID|webgl/i, /fonts\.(googleapis|gstatic)\.com/i, /play\(\) failed|NotAllowedError: play/i, /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_REFUSED)/i, /api\.open-meteo\.com|hn\.algolia\.com/i, /Download the React DevTools/i];

/** A port nothing is using, from the operating system (a random pick now and then hit one that was taken). */
function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(env: Record<string, string>) {
  const port = await freePort();
  let log = "";
  const child = spawn(process.execPath, ["--require", join(here, "support", "fake-ai-preload.cjs"), "index.js"], {
    cwd: serverDir,
    env: { ...process.env, NODE_ENV: "development", PORT: String(port), HOST: "127.0.0.1", WORKFLOW_WORKER: "off", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  return { child, url: `http://127.0.0.1:${port}`, log: () => log };
}

async function waitFor(url: string, log: () => string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The HANNAH server didn't start:\n${log()}`);
}

/** Record what goes wrong on the page while it's used. */
function watch(page: Page, api: string) {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (!IGNORED.some((pattern) => pattern.test(text))) problems.push(`console: ${text.slice(0, 300)}`);
  });
  // Which request it was, when the browser only says "Failed to load resource".
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText || "";
    if (!/ERR_ABORTED/.test(reason)) console.log(`[request failed] ${request.method()} ${request.url().slice(0, 200)} ${reason}`);
  });
  page.on("response", (response) => {
    const own = /\/(api|v1)\//.test(new URL(response.url()).pathname);
    if (own && response.status() >= 400) problems.push(`server ${response.status()}: ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
  return problems;
}

async function proxyApi(page: Page, api: string) {
  await page.route(/\/(api|v1)\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(api).origin) return route.continue();
    // The test server closes idle keep-alive connections; a request that picked one up at that moment is sent again, once.
    const target = `${api}${url.pathname}${url.search}`;
    const response = await route.fetch({ url: target }).catch((error: Error) => {
      if (!/ECONNRESET|socket hang up/i.test(error.message)) throw error;
      return route.fetch({ url: target });
    });
    await route.fulfill({ response });
  });
}

async function visitEveryScreen(page: Page, problems: string[]) {
  const results: string[] = [];
  for (const path of SCREENS) {
    const before = problems.length;
    await page.goto(path);
    await expect(page.locator("main, [role=main], #root > *").first()).toBeVisible();
    // Let the screen's first requests and effects run.
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await expect(page.getByRole("heading", { name: /something went wrong|crashed/i })).toHaveCount(0);
    results.push(...problems.slice(before).map((problem) => `${path} → ${problem}`));
  }
  return results;
}

test.describe("every screen, signed in, with a database", () => {
  test.describe.configure({ mode: "serial" });
  let server: Awaited<ReturnType<typeof startServer>>;
  test.beforeAll(async () => {
    server = await startServer({ DATABASE_URL: `sqlite:${join(mkdtempSync(join(tmpdir(), "hannah-screens-")), "hannah.db")}`, HANNAH_VAULT_KEY: "f".repeat(64) });
    await waitFor(server.url, server.log);
  });
  test.afterAll(() => { server?.child.kill(); });

  test("renders every screen without errors", async ({ page }) => {
    const problems = watch(page, server.url);
    await proxyApi(page, server.url);
    const email = `screens-${Date.now()}@example.com`;
    expect((await page.request.post(`${server.url}/api/account/register`, { data: { email, password: "correct horse battery" } })).status()).toBe(200);
    expect((await page.request.put(`${server.url}/api/account/credentials/groq`, { data: { apiKey: "gsk_e2eScreensKey0123456789abcdefghijk" } })).status()).toBe(200);
    await page.addInitScript((address) => {
      localStorage.setItem("hannah.account.v1", JSON.stringify({ email: address, displayName: "" }));
      localStorage.setItem("hannah.onboarding.v1", "complete");
    }, email);
    const found = await visitEveryScreen(page, problems);
    expect(found, found.join("\n")).toEqual([]);
  });
});

test.describe("every screen, as a guest, without a database (like the live site)", () => {
  test.describe.configure({ mode: "serial" });
  let server: Awaited<ReturnType<typeof startServer>>;
  test.beforeAll(async () => {
    server = await startServer({ DATABASE_URL: "", HANNAH_GUEST_ACCESS: "true" });
    await waitFor(server.url, server.log);
  });
  test.afterAll(() => { server?.child.kill(); });

  test("renders every screen without errors, and account features say they're off", async ({ page }) => {
    const problems = watch(page, server.url);
    await proxyApi(page, server.url);
    await page.addInitScript(() => {
      sessionStorage.setItem("hannah.session.groqKey", "gsk_e2eGuestKey0123456789abcdefghijklmn");
      localStorage.setItem("hannah.session.groqKey", "gsk_e2eGuestKey0123456789abcdefghijklmn");
      localStorage.setItem("hannah.onboarding.v1", "complete");
    });
    const found = await visitEveryScreen(page, problems);
    expect(found, found.join("\n")).toEqual([]);
  });
});
