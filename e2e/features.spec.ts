import { expect, test, type Page } from "@playwright/test";

const groqKey = "gsk_e2eFeatureKey0123456789abcdefghijklmnop";

async function connectAsGuest(page: Page) {
  await page.route(/\/(api|v1)\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/catalog") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ byok: true, providers: [{ id: "groq", label: "Groq", kind: "openai", local: false, free: true, configured: true, models: [
        { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", tools: true, vision: false, context: 131072, free: true, price: null },
        { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant", tools: true, vision: false, context: 131072, free: true, price: null },
      ] }] }) });
    }
    if (url.pathname === "/v1/usage") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ spentUsd: 0, capUsd: null, remainingUsd: null }) });
    if (url.pathname === "/api/health") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "ok", provider: "Groq", ready: true }) });
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.addInitScript((key) => {
    sessionStorage.setItem("hannah.session.groqKey", key);
    localStorage.setItem("hannah.hardware.v1", JSON.stringify({ os: "linux", cpuThreads: 8, ramGB: 16, gpuKind: "none", gpuName: "", vramGB: null, reservedGB: 4, online: true }));
  }, groqKey);
}

test("the model advisor recommends models for the user's device", async ({ page }) => {
  await connectAsGuest(page);
  await page.goto("/#/models");
  await expect(page.getByRole("heading", { name: "Find the right model for you." })).toBeVisible();
  await page.getByRole("radiogroup", { name: "Optimize for" }).getByRole("radio", { name: "Privacy-first" }).click();
  await expect(page.getByText("Showing local models only")).toBeVisible();
  const top = page.getByRole("article").first();
  await expect(top).toContainText("Top pick");
  await expect(top).toContainText("Local: prompts stay on your computer");
  await expect(top).toContainText("KV cache");
});

test("reminders can be added and cancelled from the dashboard", async ({ page }) => {
  await connectAsGuest(page);
  await page.goto("/#/dashboard");
  const card = page.getByRole("region", { name: "Reminders" });
  await card.getByLabel("Reminder").fill("Review the pull request");
  await card.getByRole("button", { name: "Add" }).click();
  await expect(card.getByText("Review the pull request")).toBeVisible();
  await card.getByRole("button", { name: "Cancel reminder: Review the pull request" }).click();
  await expect(card.getByText("No upcoming reminders")).toBeVisible();
});

test("a community instruction skill installs only after its manifest is checked", async ({ page }) => {
  await connectAsGuest(page);
  await page.goto("/#/marketplace");
  const panel = page.getByRole("region", { name: "Community skills" });
  await panel.getByLabel("Manifest JSON").fill(JSON.stringify({ manifestVersion: 1, type: "executable-plugin" }));
  await panel.getByRole("button", { name: "Check manifest" }).click();
  await expect(panel.getByRole("alert")).toContainText("Can't install this skill");

  await panel.getByRole("button", { name: "Load an example" }).click();
  await panel.getByRole("button", { name: "Check manifest" }).click();
  await expect(panel.getByText("None: guidance text only")).toBeVisible();
  await panel.getByRole("button", { name: "Install skill" }).click();
  const toggle = panel.getByRole("switch", { name: "Turn on Meeting notes" });
  await toggle.click();
  await expect(panel.getByRole("switch", { name: "Turn off Meeting notes" })).toHaveAttribute("aria-checked", "true");
});
