import { expect, test } from "@playwright/test";

test("landing navigation sections and marketplace actions work", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  for (const [label, target] of [
    ["Features", "features"],
    ["Privacy", "privacy"],
    ["Download", "download"],
    ["FAQ", "faq"],
  ]) {
    await navigation.getByRole("link", { name: label }).click();
    await expect(page.locator(`#${target}`)).toBeInViewport();
  }
  // In-page links scroll without putting "#section" in the address bar.
  await expect(page).toHaveURL(/\/$/);

  await navigation.getByRole("link", { name: "Marketplace" }).click();
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
  await expect(page.getByRole("heading", { name: /Your Personal AI/ })).toBeVisible();

  await navigation.getByRole("link", { name: "Integrations" }).click();
  await expect(page.getByRole("heading", { name: "Bring HANNAH into your workflow." })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: /Your Personal AI/ })).toBeVisible();
});

test("app screens require a connection and the browser back button works", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/dashboard");
  // Without a saved token the app asks the visitor to connect first.
  await expect(page.getByRole("dialog", { name: /Connect with HANNAH/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Marketplace" }).click();
  await expect(page).toHaveURL(/\/marketplace$/);
  await page.goBack();
  await expect(page.getByRole("heading", { name: /Your Personal AI/ })).toBeVisible();
});

test("mobile navigation exposes and opens every section", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page.getByRole("button", { name: "Open navigation" }).click();
  const navigation = page.getByRole("navigation", { name: "Mobile main navigation" });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("link", { name: "Features" }).click();
  await expect(page.locator("#features")).toBeInViewport();

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("navigation", { name: "Mobile main navigation" }).getByRole("link", { name: "Marketplace" }).click();
  await expect(page.getByRole("heading", { name: "Agents and skills for the way you work." })).toBeVisible();

  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("navigation", { name: "Mobile main navigation" }).getByRole("link", { name: "Integrations" }).click();
  await expect(page.getByRole("heading", { name: "Bring HANNAH into your workflow." })).toBeVisible();
});

test("landing scroll keeps the navbar available and About has a built route", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  const landingScroller = page.locator("main.landing-page");
  await expect.poll(async () => landingScroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("link", { name: "Privacy" }).click();
  await expect(page.locator("#privacy")).toBeInViewport();
  await expect(navigation).toBeInViewport();
  await expect.poll(async () => landingScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.goto("/about/");
  await expect(page).toHaveTitle(/About HANNAH/);
  await expect(page.getByRole("heading", { name: /Meet HANNAH, an AI companion/ })).toBeVisible();
  await page.getByRole("link", { name: "Features" }).click();
  await expect(page.locator("#features")).toBeInViewport();
});
