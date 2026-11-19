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
  await expect(page.getByRole("heading", { name: "Connect your tools. Shape how she works." })).toBeVisible();
  await page.getByRole("tab", { name: "Agents and skills" }).click();

  // One click adds a package and turns it on; adding another agent replaces the active one.
  const studyCoach = page.getByRole("article").filter({ hasText: "Study coach" });
  await studyCoach.getByRole("button", { name: "Use Study coach" }).click();
  await expect(page.getByRole("status")).toContainText("Study coach is on");
  await expect(studyCoach.getByRole("button", { name: "Turn off Study coach" })).toBeVisible();
  const researcher = page.getByRole("article").filter({ hasText: "Research analyst" });
  await researcher.getByRole("button", { name: "Use Research analyst" }).click();
  await expect(researcher.getByRole("button", { name: "Turn off Research analyst" })).toBeVisible();
  await expect(studyCoach.getByRole("button", { name: "Use Study coach" })).toBeVisible();
  await expect(page.getByText("Active agent: Research analyst")).toBeVisible();

  await page.getByRole("button", { name: "skills", exact: true }).click();
  const conciseReplies = page.getByRole("article").filter({ hasText: "Concise replies" });
  await conciseReplies.getByRole("switch", { name: "Turn on Concise replies" }).click();
  await expect(conciseReplies.getByRole("switch", { name: "Turn off Concise replies" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Skills on: 1 of 5")).toBeVisible();

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
  await expect(page.getByRole("heading", { name: "Connect your tools. Shape how she works." })).toBeVisible();

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
  // In-page links on About scroll without putting "#features" in the address bar.
  await expect(page).toHaveURL(/\/about\/$/);
  expect(new URL(page.url()).hash).toBe("");

  // About's "home page" link goes to /#features: the landing page scrolls there and drops the hash.
  await page.getByRole("link", { name: "home page" }).click();
  await expect(page.locator("#features")).toBeInViewport();
  await expect(page).toHaveURL(/\/$/);
  expect(new URL(page.url()).hash).toBe("");
});

test("the home page's prompts lead a new visitor to connect, then into chat with the message and agent ready", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  // Counts come from the product's own data.
  await expect(page.getByLabel("HANNAH in numbers")).toContainText("agents and skills");
  await page.getByRole("button", { name: "Try it: Learn something properly" }).click();
  // Not connected yet: the connect dialog comes first, and the message waits.
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => window.sessionStorage.getItem("hannah.chat.draft"))).toContain("photosynthesis");
  expect(await page.evaluate(() => JSON.parse(window.localStorage.getItem("hannah.marketplace.v1") || "{}").activeAgentId)).toBe("study-coach");
  await page.keyboard.press("Escape");

  await page.getByLabel("Your first message to HANNAH").fill("What is the capital of Australia?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => window.sessionStorage.getItem("hannah.chat.draft"))).toBe("What is the capital of Australia?");
});
