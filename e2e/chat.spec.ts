import { expect, test } from "@playwright/test";

const apiToken = "e2e-hannah-token-0123456789-abcdefghijklmnopqrstuv";
const groqKey = "gsk_e2eVisitorKey0123456789abcdefghijklmnop";

test("a visitor connects with only a Groq key and chats with the WebGL avatar", async ({ page }) => {
  const protectedRequests: Array<{ authorization: string; groqKey: string }> = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    // Public endpoints (health, whether this server offers accounts) need no credentials.
    if (!["/api/health", "/api/account/status", "/api/db/status"].includes(url.pathname)) {
      protectedRequests.push({ authorization: request.headers().authorization ?? "", groqKey: request.headers()["x-groq-api-key"] ?? "" });
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
    window.localStorage.setItem("hannah.onboarding.v1", "complete");
  });
  await page.goto("/");
  const webglAvailable = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  });
  expect(webglAvailable, "Chromium must provide WebGL for the avatar scene.").toBe(true);
  await expect(page.locator("canvas").first()).toBeVisible();

  await page.getByRole("button", { name: "Talk to HANNAH" }).first().click();
  await page.getByLabel("Your Groq API key").fill(groqKey);
  await page.getByRole("button", { name: "Continue to HANNAH" }).click();

  const avatarRegion = page.getByRole("region", { name: "HANNAH avatar" });
  const message = page.getByRole("textbox", { name: "Message HANNAH" });
  await expect(message).toBeVisible();
  await message.fill("I had a long day. Can we talk?");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByText("I'm glad you reached out.")).toBeVisible();
  await expect(avatarRegion).toHaveAttribute("data-emotion", "happy");
  await expect(avatarRegion).toHaveAttribute("data-avatar-motion", /^(animation|procedural)$/);
  // She "says" the reply, then settles back to idle.
  await expect(avatarRegion).toHaveAttribute("data-avatar-activity", /^(speaking|idle)$/);
  await expect(avatarRegion).toHaveAttribute("data-avatar-activity", "idle");
  // No operator token exists: every request authenticates with the visitor's own key.
  expect(protectedRequests.length).toBeGreaterThan(0);
  expect(protectedRequests.every((request) => request.authorization === "" && request.groqKey === groqKey)).toBe(true);

  // The dashboard reflects the real turn that just happened.
  await page.getByRole("navigation", { name: "App navigation" }).getByRole("button", { name: "Dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Where you left off" })).toBeVisible();
  await expect(page.getByText("I had a long day. Can we talk?")).toBeVisible();
  await expect(page.getByRole("region", { name: "Overview" }).getByText("1", { exact: true }).first()).toBeVisible();

  // History survives a reload because the key is kept for this tab.
  await page.reload();
  await page.getByRole("navigation", { name: "App navigation" }).getByRole("button", { name: "Chat" }).click();
  await expect(page.getByText("I'm glad you reached out.")).toBeVisible();
});

test("a rejected access token is reported before entering the app", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "A valid HANNAH API bearer token is required." }) }));
  await page.goto("/");
  await page.getByRole("button", { name: "Talk to HANNAH" }).first().click();
  await page.getByText("I have an access token").click();
  await page.getByLabel("HANNAH API access token").fill(apiToken);
  await page.getByRole("button", { name: "Continue to HANNAH" }).click();
  await expect(page.getByRole("alert")).toContainText("access token was not accepted");
  await expect(page.getByRole("textbox", { name: "Message HANNAH" })).toHaveCount(0);
});

test("a Groq key is checked before entering the app", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Groq did not accept that API key.", reason: "groq-key-rejected" }) }));
  await page.goto("/");
  await page.getByRole("button", { name: "Talk to HANNAH" }).first().click();

  await page.getByRole("button", { name: "Continue to HANNAH" }).click();
  await expect(page.getByRole("alert")).toContainText("Paste your Groq API key");

  await page.getByLabel("Your Groq API key").fill("sk-not-a-groq-key");
  await page.getByRole("button", { name: "Continue to HANNAH" }).click();
  await expect(page.getByRole("alert")).toContainText("doesn't look like a Groq key");

  await page.getByLabel("Your Groq API key").fill(groqKey);
  await page.getByRole("button", { name: "Continue to HANNAH" }).click();
  await expect(page.getByRole("alert")).toContainText("Groq didn't accept that key");
  await expect(page.getByRole("textbox", { name: "Message HANNAH" })).toHaveCount(0);
});

test("a file write waits for in-app approval and declining changes nothing", async ({ page }) => {
  let agentCalls = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/providers") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ defaultProvider: "groq", providers: [{ id: "groq", label: "Groq", local: false, configured: true }] }) });
    if (url.pathname === "/api/models") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ provider: "Groq", defaultModel: "openai/gpt-oss-120b", models: ["openai/gpt-oss-120b"] }) });
    if (url.pathname === "/api/agent") {
      agentCalls += 1;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ message: { content: "", tool_calls: [{ id: "write-1", type: "function", function: { name: "write_app_file", arguments: JSON.stringify({ path: "plan.md", content: "Monday: review" }) } }] } }) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.addInitScript((token) => sessionStorage.setItem("hannah.session.apiToken", token), apiToken);
  await page.goto("/#/chat");

  await page.getByRole("textbox", { name: "Message HANNAH" }).fill("Save my study plan to a file");
  await page.getByRole("button", { name: "Send message" }).click();

  const approval = page.getByRole("alertdialog", { name: "Write a file" });
  await expect(approval).toBeVisible();
  await expect(approval).toContainText("plan.md");
  await approval.getByRole("button", { name: "Decline" }).click();

  await expect(approval).toHaveCount(0);
  await expect(page.getByText("Action cancelled. HANNAH did not make any changes.")).toBeVisible();
  expect(agentCalls).toBe(1);
});

test("Team mode plans, runs specialists in parallel, verifies and shows the run on the Agents screen", async ({ page }) => {
  const phases: string[] = [];
  let agentCalls = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/providers") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ defaultProvider: "groq", providers: [{ id: "groq", label: "Groq", local: false, configured: true }] }) });
    if (url.pathname === "/api/models") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ provider: "Groq", defaultModel: "openai/gpt-oss-120b", models: ["openai/gpt-oss-120b"] }) });
    if (url.pathname === "/api/orchestrate") {
      const body = request.postDataJSON();
      phases.push(body.phase);
      if (body.phase === "plan") {
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ summary: "Two lookups", fallback: false, steps: [
          { id: "s1", agent: "research", task: "Explain what a bento layout is", dependsOn: [] },
          { id: "s2", agent: "memory", task: "Check what the user likes", dependsOn: [] },
        ] }) });
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ verdict: "pass", issues: [], revise: [], reply: "Here's the combined answer from your team.", emotion: "happy" }) });
    }
    if (url.pathname === "/api/agent") {
      agentCalls += 1;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ message: { content: JSON.stringify({ reply: `Step result ${agentCalls}`, emotion: "neutral" }), tool_calls: [] } }) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not mocked" }) });
  });
  await page.addInitScript((key) => {
    window.localStorage.setItem("hannah.onboarding.v1", "complete");
    window.sessionStorage.setItem("hannah.session.groqKey", key);
  }, groqKey);
  await page.goto("/#/chat");
  await page.getByRole("switch", { name: "Team" }).click();
  await expect(page.getByRole("switch", { name: "Team" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("textbox", { name: "Message HANNAH" }).fill("Explain bento layouts and check what I like");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Here's the combined answer from your team.")).toBeVisible();
  expect(phases).toEqual(["plan", "verify"]);
  expect(agentCalls).toBe(2);

  await page.getByRole("navigation", { name: "App navigation" }).getByRole("button", { name: "Agents" }).click();
  const activity = page.getByRole("region", { name: "Team activity" });
  await expect(activity).toContainText("Explain bento layouts and check what I like");
  await expect(activity).toContainText("Done");
  await expect(activity).toContainText("2/2 steps");
});
