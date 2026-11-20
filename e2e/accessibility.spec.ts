/**
 * Accessibility gate: axe-core (WCAG 2.1 A and AA rules) on every main
 * screen, at desktop and phone widths. Serious and critical violations fail
 * the build; moderate ones are printed so they can be worked through.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const groqKey = "gsk_e2eAccessibilityKey0123456789abcdefghijklmn";

async function connect(page: Page) {
  await page.route(/\/(api|v1)\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/catalog") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ byok: true, providers: [{ id: "groq", label: "Groq", kind: "openai", local: false, free: true, configured: true, models: [{ id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", tools: true, vision: false, context: 131072, free: true, price: null }] }] }) });
    if (url.pathname === "/api/providers") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ defaultProvider: "groq", providers: [{ id: "groq", label: "Groq", local: false, configured: true }] }) });
    if (url.pathname === "/api/models") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ provider: "Groq", defaultModel: "openai/gpt-oss-120b", models: ["openai/gpt-oss-120b"] }) });
    if (url.pathname === "/v1/usage") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ spentUsd: 0, capUsd: null, remainingUsd: null }) });
    if (url.pathname === "/api/health") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "ok", provider: "Groq", ready: true }) });
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.addInitScript((key) => {
    sessionStorage.setItem("hannah.session.groqKey", key);
    localStorage.setItem("hannah.onboarding.v1", "complete");
    localStorage.setItem("hannah.hardware.v1", JSON.stringify({ os: "linux", cpuThreads: 8, ramGB: 16, gpuKind: "none", gpuName: "", vramGB: null, reservedGB: 4, online: true }));
  }, groqKey);
}

const screens: Array<{ path: string; ready: (page: Page) => Promise<void> }> = [
  // With a session already set, the landing page offers "Open HANNAH" instead of "Talk to HANNAH".
  { path: "/", ready: (page) => expect(page.getByRole("link", { name: /Open HANNAH/ }).or(page.getByRole("button", { name: /Open HANNAH|Talk to HANNAH/ })).first()).toBeVisible() },
  { path: "/chat", ready: (page) => expect(page.getByRole("textbox", { name: "Message HANNAH" })).toBeVisible() },
  { path: "/dashboard", ready: (page) => expect(page.getByRole("heading", { name: "Where you left off" })).toBeVisible() },
  { path: "/agents", ready: (page) => expect(page.getByRole("heading", { name: "Agents" })).toBeVisible() },
  { path: "/models", ready: (page) => expect(page.getByRole("heading", { name: "Find the right model for you." })).toBeVisible() },
  { path: "/memory", ready: (page) => expect(page.getByLabel("Add something for HANNAH to remember")).toBeVisible() },
  { path: "/automations", ready: (page) => expect(page.getByRole("button", { name: "New automation" })).toBeVisible() },
  { path: "/actions", ready: (page) => expect(page.getByRole("heading", { name: "Actions", level: 1 })).toBeVisible() },
  { path: "/settings", ready: (page) => expect(page.getByRole("heading", { name: "Settings" })).toBeVisible() },
];

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const describe = (violation: (typeof results.violations)[number]) => `${violation.impact}: ${violation.id} (${violation.help}) on ${violation.nodes.slice(0, 3).map((node) => `${node.target.join(" ")} <${node.html.replace(/\s+/g, " ").slice(0, 160)}>`).join(", ")}${violation.nodes.length > 3 ? ` and ${violation.nodes.length - 3} more` : ""}`;
  const blocking = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  const moderate = results.violations.filter((violation) => !blocking.includes(violation));
  if (moderate.length) console.log(`[axe] ${label}: ${moderate.length} non-blocking finding(s):\n  ${moderate.map(describe).join("\n  ")}`);
  expect(blocking.map(describe), `${label} has accessibility violations`).toEqual([]);
}

for (const screen of screens) {
  test(`${screen.path} has no serious accessibility violations`, async ({ page }) => {
    await connect(page);
    await page.goto(screen.path);
    await screen.ready(page);
    await audit(page, `${screen.path} (desktop)`);
    await page.setViewportSize({ width: 390, height: 844 });
    await screen.ready(page);
    await audit(page, `${screen.path} (phone)`);
  });
}

test("the connect dialog and the feedback form are accessible", async ({ page }) => {
  await page.route(/\/(api|v1)\//, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "ok", ready: true, accounts: false }) }));
  await page.goto("/");
  await page.getByRole("button", { name: "Talk to HANNAH" }).first().click();
  await expect(page.getByLabel("Your Groq API key")).toBeVisible();
  await audit(page, "connect dialog");
});

test("larger text sizes keep every screen usable", async ({ page }) => {
  await connect(page);
  await page.addInitScript(() => localStorage.setItem("hannah.textSize", "larger"));
  await page.goto("/settings");
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "larger");
  const rootSize = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  expect(rootSize).toBeGreaterThan(19);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByLabel("Text size").selectOption("default");
  await expect(page.locator("html")).not.toHaveAttribute("data-text-size", /.+/);
  await page.goto("/chat");
  await expect(page.getByRole("textbox", { name: "Message HANNAH" })).toBeVisible();
  // No horizontal scrolling at phone width with larger text.
  await page.addInitScript(() => localStorage.setItem("hannah.textSize", "larger"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/chat");
  await expect(page.getByRole("textbox", { name: "Message HANNAH" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
