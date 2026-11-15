import { expect, test } from "@playwright/test";

const apiToken = "e2e-shanaya-token-0123456789-abcdefghijklmnopqrstuv";

test("sends a chat message and renders the returned emotion in the WebGL avatar", async ({ page }) => {
  const protectedRequestTokens: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== "/api/health") {
      protectedRequestTokens.push(request.headers().authorization ?? "");
    }

    if (url.pathname === "/api/providers") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          defaultProvider: "groq",
          providers: [{ id: "groq", label: "Groq", local: false, configured: true }],
        }),
      });
      return;
    }
    if (url.pathname === "/api/models") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ provider: "Groq", defaultModel: "openai/gpt-oss-120b", models: ["openai/gpt-oss-120b"] }),
      });
      return;
    }
    if (url.pathname === "/api/agent" && request.method() === "POST") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          message: {
            content: JSON.stringify({ reply: "I'm glad you reached out.", emotion: "happy" }),
            tool_calls: [],
          },
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not mocked" }) });
  });

  await page.addInitScript(() => {
    window.localStorage.setItem("shanaya.onboarding.v1", "complete");
    window.localStorage.setItem("shanaya.subscription.v1", JSON.stringify({ tier: "premium", day: "2026-11-15", used: 0 }));
  });
  await page.goto("/");
  const webglAvailable = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  });
  expect(webglAvailable, "Chromium must provide WebGL for the avatar scene.").toBe(true);
  await expect(page.locator("canvas").first()).toBeVisible();

  await page.getByRole("button", { name: "Talk to Shanaya" }).first().click();
  await page.getByLabel("Shanaya API access token").fill(apiToken);
  await page.getByRole("button", { name: "Continue to Shanaya" }).click();

  const avatarRegion = page.getByRole("region", { name: "Shanaya avatar" });
  const message = page.getByRole("textbox", { name: "Message Shanaya" });
  await expect(message).toBeVisible();
  await message.fill("I had a long day. Can we talk?");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByText("I'm glad you reached out.")).toBeVisible();
  await expect(avatarRegion).toHaveAttribute("data-emotion", "happy");
  await expect(avatarRegion).toHaveAttribute("data-avatar-motion", /^(animation|procedural)$/);
  expect(protectedRequestTokens.length).toBeGreaterThan(0);
  expect(protectedRequestTokens.every((token) => token === `Bearer ${apiToken}`)).toBe(true);
});
