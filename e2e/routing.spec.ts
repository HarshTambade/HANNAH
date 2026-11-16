import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// Tests run from the client folder (npm run test:e2e --prefix client).
const appVersion = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")).version as string;

const groqKey = "gsk_e2eRoutingKey0123456789abcdefghijklmnop";

// A connected visitor with every API call answered, so screens render fully.
async function connected(page: Page) {
  await page.route(/\/(api|v1)\//, async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/providers") return json({ defaultProvider: "groq", providers: [{ id: "groq", label: "Groq", local: false, configured: true }] });
    if (url.pathname === "/api/models") return json({ provider: "Groq", defaultModel: "llama-3.1-8b-instant", models: ["llama-3.1-8b-instant"] });
    if (url.pathname === "/api/catalog") return json({ byok: true, providers: [] });
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.addInitScript((key) => {
    sessionStorage.setItem("hannah.session.groqKey", key);
    localStorage.setItem("hannah.onboarding.v1", "complete");
  }, groqKey);
}

const screens: Array<[string, string, RegExp]> = [
  ["/chat", "Chat", /Chat · HANNAH/],
  ["/dashboard", "Dashboard", /Dashboard · HANNAH/],
  ["/agents", "Agents", /Agents · HANNAH/],
  ["/models", "Models", /Models · HANNAH/],
  ["/memory", "Memory & style", /Memory & style · HANNAH/],
  ["/automations", "Automations", /Automations · HANNAH/],
  ["/settings", "Settings", /Settings · HANNAH/],
];

test("every app screen has a real address that survives a refresh", async ({ page }) => {
  await connected(page);
  for (const [path, label, title] of screens) {
    await page.goto(path);
    await expect(page).toHaveTitle(title);
    const tab = page.getByRole("navigation", { name: "App navigation" }).getByRole("link", { name: label, exact: true });
    await expect(tab).toHaveAttribute("aria-current", "page");
    await expect(tab).toHaveAttribute("href", path);
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page).toHaveTitle(title);
  }
});

test("tabs change the path without a hash, and back and forward work", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await connected(page);
  await page.goto("/chat");
  const nav = page.getByRole("navigation", { name: "App navigation" });
  await nav.getByRole("link", { name: "Models", exact: true }).click();
  await expect(page).toHaveURL(/\/models$/);
  await nav.getByRole("link", { name: "Agents", exact: true }).click();
  await expect(page).toHaveURL(/\/agents$/);
  expect(new URL(page.url()).hash).toBe("");

  await page.goBack();
  await expect(page).toHaveURL(/\/models$/);
  await expect(page.getByRole("heading", { name: "Find the right model for you." })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/chat$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/models$/);
});

test("phones get a bottom tab bar that navigates", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await connected(page);
  await page.goto("/dashboard");
  const tabs = page.getByRole("navigation", { name: "App navigation" });
  const box = await tabs.boundingBox();
  expect(box && box.y + box.height).toBeGreaterThan(780);
  await tabs.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
});

test("old #/ links redirect to the real path", async ({ page }) => {
  await connected(page);
  await page.goto("/#/models");
  await expect(page).toHaveURL(/\/models$/);
  await expect(page.getByRole("heading", { name: "Find the right model for you." })).toBeVisible();
});

test("an unknown address shows a page-not-found screen", async ({ page }) => {
  await connected(page);
  const response = await page.goto("/no-such-page");
  expect(response?.status()).toBeLessThan(500);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page).toHaveTitle(/Page not found/);
  await page.getByRole("button", { name: "Open chat" }).click();
  await expect(page).toHaveURL(/\/chat$/);
});

test("a signed-out visitor who opens a screen lands there after connecting", async ({ page }) => {
  await page.route(/\/(api|v1)\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/models") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ provider: "Groq", defaultModel: "m", models: ["m"] }) });
    if (url.pathname === "/api/providers") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ defaultProvider: "groq", providers: [{ id: "groq", label: "Groq", local: false, configured: true }] }) });
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.goto("/models");
  await expect(page.getByRole("dialog", { name: /Connect with HANNAH/ })).toBeVisible();
  await page.getByLabel("Your Groq API key").fill(groqKey);
  await page.getByRole("button", { name: "Continue to HANNAH" }).click();
  await expect(page).toHaveURL(/\/models$/);
});

test("the landing page shows the app version and working download links", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Your Personal AI.");
  await expect(page.getByRole("link", { name: "HANNAH home" })).toContainText(`v${appVersion}`);
  await expect(page.getByRole("heading", { name: `HANNAH ${appVersion} for every device.` })).toBeVisible();
  const download = page.locator("#download");
  await expect(download.getByRole("link", { name: "Installer (64-bit)" })).toHaveAttribute("href", /\/download\/windows$/);
  await expect(download.getByRole("link", { name: "Apple silicon (M1 and later)" })).toHaveAttribute("href", /\/download\/macos-arm64$/);
  for (const href of await page.locator("a[href^='https://github.com/']").evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href))) {
    expect(href).toContain("github.com/HarshTambade/Shanaya-Your-AI-companion");
  }
});

test.describe("with the offline service worker", () => {
  test.use({ serviceWorkers: "allow" });

  test("download links reach the server even when the offline service worker controls the page", async ({ page, context }) => {
    let reachedServer = false;
    await context.route("**/download/**", (route) => {
      reachedServer = true;
      return route.fulfill({ status: 200, headers: { "content-type": "application/vnd.android.package-archive", "content-disposition": "attachment; filename=HANNAH-Android.apk" }, body: "APK" });
    });
    await page.goto("/");
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload();
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    const download = page.waitForEvent("download");
    await page.locator("#download").getByRole("link", { name: "APK" }).click();
    expect((await download).suggestedFilename()).toBe("HANNAH-Android.apk");
    expect(reachedServer).toBe(true);
    await expect(page.getByText("Page not found")).toHaveCount(0);
  });
});

test("public pages arrive as real HTML, readable without running JavaScript", async ({ request }) => {
  // Trailing slash: the preview server only serves a folder's index.html that way (Vercel serves both).
  for (const [path, heading] of [["/", "Your Personal AI"], ["/integrations/", "Bring HANNAH into your workflow."], ["/marketplace/", "Agents and skills for the way you work."]] as const) {
    const html = await (await request.get(path)).text();
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(html).toContain("<h1");
    expect(text).toContain(heading);
    expect(html.match(/<title>/g)).toHaveLength(1);
  }
  const home = await (await request.get("/")).text();
  expect(home).toContain("Is HANNAH open source?");
  expect(home).toContain('href="/integrations"');
  expect(home).toContain('href="/marketplace"');
  // App screens stay out of search results.
  expect(await (await request.get("/chat/")).text()).toContain('content="noindex,follow"');
});
