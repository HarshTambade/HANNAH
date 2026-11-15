import { expect, test } from "@playwright/test";

test("landing navigation sections and marketplace actions work", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  for (const [label, target] of [
    ["The experience", "experience"],
    ["How it works", "how-it-works"],
    ["Hybrid AI", "modes"],
    ["Your privacy", "privacy"],
  ]) {
    await navigation.getByRole("link", { name: label }).click();
    await expect(page.locator(`#${target}`)).toBeInViewport();
  }

  await navigation.getByRole("button", { name: "Marketplace" }).click();
  await expect(page.getByRole("heading", { name: "Agents and skills for the way you work." })).toBeVisible();

  const studyCoach = page.getByRole("article").filter({ hasText: "Study coach" });
  await studyCoach.getByRole("button", { name: "Install" }).click();
  await studyCoach.getByRole("button", { name: "Activate Study coach" }).click();
  await expect(studyCoach.getByRole("button", { name: "Deactivate Study coach" })).toBeVisible();

  await page.getByRole("button", { name: "skills", exact: true }).click();
  const conciseReplies = page.getByRole("article").filter({ hasText: "Concise replies" });
  await conciseReplies.getByRole("button", { name: "Install" }).click();
  await conciseReplies.getByRole("switch", { name: "Enable Concise replies" }).click();
  await expect(conciseReplies.getByRole("switch", { name: "Disable Concise replies" })).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: /An AI companion/ })).toBeVisible();

  await navigation.getByRole("button", { name: "Integrations" }).click();
  await expect(page.getByRole("heading", { name: "Bring Shanaya into your workflow." })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: /An AI companion/ })).toBeVisible();

  await navigation.getByRole("button", { name: "First-time setup" }).click();
  await expect(page.getByRole("heading", { name: /A companion that keeps your confidence/ })).toBeVisible();
  await page.getByRole("button", { name: "Set up later" }).click();
  await expect(page.getByRole("heading", { name: /An AI companion/ })).toBeVisible();
});

test("mobile navigation exposes and opens every section", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page.getByRole("button", { name: "Open navigation" }).click();
  const navigation = page.getByRole("navigation", { name: "Mobile main navigation" });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("link", { name: "Hybrid AI" }).click();
  await expect(page.locator("#modes")).toBeInViewport();

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("navigation", { name: "Mobile main navigation" }).getByRole("button", { name: "Marketplace" }).click();
  await expect(page.getByRole("heading", { name: "Agents and skills for the way you work." })).toBeVisible();

  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("navigation", { name: "Mobile main navigation" }).getByRole("button", { name: "Integrations" }).click();
  await expect(page.getByRole("heading", { name: "Bring Shanaya into your workflow." })).toBeVisible();
});

test("landing scroll keeps the navbar available and About has a built route", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  const landingScroller = page.locator("main.landing-page");
  await expect.poll(() => landingScroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("link", { name: "How it works" }).click();
  await expect(page.locator("#how-it-works")).toBeInViewport();
  await expect(navigation).toBeInViewport();
  await expect.poll(() => landingScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.goto("/about/");
  await expect(page).toHaveTitle(/About Shanaya/);
  await expect(page.getByRole("heading", { name: /Meet Shanaya, an AI companion/ })).toBeVisible();
  await page.getByRole("link", { name: "Features" }).click();
  await expect(page.locator("#features")).toBeInViewport();
});
