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
  await page.getByRole("navigation", { name: "App navigation" }).getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Where you left off" })).toBeVisible();
  await expect(page.getByText("I had a long day. Can we talk?")).toBeVisible();
  await expect(page.getByRole("region", { name: "Overview" }).getByText("1", { exact: true }).first()).toBeVisible();

  // History survives a reload because the key is kept for this tab.
  await page.reload();
  await page.getByRole("navigation", { name: "App navigation" }).getByRole("link", { name: "Chat" }).click();
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
  await page.goto("/chat");

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
  await page.goto("/chat");
  await page.getByRole("switch", { name: "Team" }).click();
  await expect(page.getByRole("switch", { name: "Team" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("textbox", { name: "Message HANNAH" }).fill("Explain bento layouts and check what I like");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Here's the combined answer from your team.")).toBeVisible();
  expect(phases).toEqual(["plan", "verify"]);
  expect(agentCalls).toBe(2);

  await page.getByRole("navigation", { name: "App navigation" }).getByRole("link", { name: "Agents" }).click();
  const activity = page.getByRole("region", { name: "Team activity" });
  await expect(activity).toContainText("Explain bento layouts and check what I like");
  await expect(activity).toContainText("Done");
  await expect(activity).toContainText("2/2 steps");
});

test("Auto previews the route before sending and Private mode stays self-hosted", async ({ page }) => {
  const agentBodies: Array<Record<string, unknown>> = [];
  const previewBodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/providers") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ defaultProvider: "groq", providers: [{ id: "groq", label: "Groq", local: false, configured: true }] }) });
    if (url.pathname === "/api/models") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ provider: "Groq", defaultModel: "llama-3.1-8b-instant", models: ["llama-3.1-8b-instant"] }) });
    if (url.pathname === "/api/route/preview") {
      const body = request.postDataJSON() as { routing: { mode: string } };
      previewBodies.push(body);
      if (body.routing.mode === "private") {
        return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Private mode only uses models on your own hardware, and none is set up on this server.", code: "no_private_route" }) });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          mode: "balanced", modeLabel: "Balanced", level: "simple", task: "chat", reasons: ["short everyday message"],
          providerId: "groq", providerLabel: "Groq", model: "llama-3.1-8b-instant", tier: "small", local: false,
          estimate: { inputTokens: 520, outputTokens: 700, assumption: "about 700 reply tokens", usd: null, basis: "unverified", note: "No verified price on file." },
          reason: "Balanced: a small model for a simple chat request (short everyday message).",
          alternatives: [{ providerId: "groq", providerLabel: "Groq", model: "openai/gpt-oss-120b", tier: "frontier", local: false, estimate: { inputTokens: 520, outputTokens: 700, assumption: "about 700 reply tokens", usd: null, basis: "unverified" } }],
          limitations: [], privacy: "any",
        }),
      });
    }
    if (url.pathname === "/api/agent") {
      agentBodies.push(request.postDataJSON());
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ message: { content: JSON.stringify({ reply: "Routed hello.", emotion: "neutral" }), tool_calls: [] }, provider: "Groq", model: "llama-3.1-8b-instant" }) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.addInitScript((token) => {
    window.localStorage.setItem("hannah.onboarding.v1", "complete");
    window.localStorage.setItem("hannah.cloudModel:groq", "auto");
    sessionStorage.setItem("hannah.session.apiToken", token);
  }, apiToken);
  await page.goto("/chat");

  const message = page.getByRole("textbox", { name: "Message HANNAH" });
  await expect(message).toBeVisible();
  await message.fill("hi there");
  const chip = page.getByRole("button", { name: /^Route: Balanced uses Groq llama-3\.1-8b-instant/ });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByText("Balanced: a small model for a simple chat request")).toBeVisible();
  await expect(page.getByText("No verified price").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Use this" })).toBeVisible();

  // Switch to Private: the preview explains there's no self-hosted model before anything is sent.
  await page.getByRole("button", { name: "Inference and privacy settings" }).click();
  await page.getByRole("radio", { name: "Private" }).click();
  await expect(page.getByText("Private mode only uses models on your own hardware")).toBeVisible();
  expect(previewBodies.at(-1)?.routing).toEqual({ mode: "private" });

  // Back to Balanced, send, and the agent request carries the routing policy.
  await page.getByRole("radio", { name: "Balanced" }).click();
  await page.getByRole("button", { name: "Inference and privacy settings" }).click();
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Routed hello.")).toBeVisible();
  expect(agentBodies[0]).toMatchObject({ model: "auto", routing: { mode: "balanced" } });
});

test("“Remember on this browser” keeps a visitor connected in a new tab, without the key in the page's storage", async ({ context }) => {
  let remembered = false;
  const sentKeys: string[] = [];
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/session/key") {
      if (request.method() === "POST") remembered = request.headers()["x-groq-api-key"] === groqKey;
      if (request.method() === "DELETE") remembered = false;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(remembered ? { remembered: true, hint: `gsk_…${groqKey.slice(-4)}` } : { remembered: false }) });
    }
    if (!["/api/health", "/api/account/status", "/api/db/status"].includes(url.pathname)) sentKeys.push(request.headers()["x-groq-api-key"] ?? "");
    if (url.pathname === "/api/providers") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ defaultProvider: "groq", providers: [{ id: "groq", label: "Groq", local: false, configured: true }] }) });
    if (url.pathname === "/api/models") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ provider: "Groq", defaultModel: "openai/gpt-oss-120b", models: ["openai/gpt-oss-120b"] }) });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not mocked" }) });
  });
  await context.addInitScript(() => window.localStorage.setItem("hannah.onboarding.v1", "complete"));

  const first = await context.newPage();
  await first.goto("/");
  await first.getByRole("button", { name: "Talk to HANNAH" }).first().click();
  await first.getByLabel("Your Groq API key").fill(groqKey);
  await expect(first.getByRole("checkbox", { name: /Remember on this browser/ })).toBeChecked();
  await first.getByRole("button", { name: "Continue to HANNAH" }).click();
  await expect(first.getByRole("textbox", { name: "Message HANNAH" })).toBeVisible();
  await expect.poll(() => remembered).toBe(true);
  await first.close();

  // A new tab: sessionStorage is empty, so only the remembered key can connect it.
  const second = await context.newPage();
  sentKeys.length = 0;
  await second.goto("/chat");
  await expect(second.getByRole("textbox", { name: "Message HANNAH" })).toBeVisible();
  await expect(second.getByLabel("Your Groq API key")).toHaveCount(0);
  const stored = await second.evaluate(() => JSON.stringify({ ...window.localStorage, ...window.sessionStorage }));
  expect(stored).not.toContain(groqKey);
  expect(stored).toContain(`gsk_…${groqKey.slice(-4)}`);
  expect(sentKeys.length).toBeGreaterThan(0);
  expect(sentKeys.every((key) => key === ""), "the key travels in the cookie, not from the page").toBe(true);

  // Settings says so, and Disconnect forgets it.
  await second.goto("/settings");
  await expect(second.getByText(`Remembered on this browser · gsk_…${groqKey.slice(-4)}`)).toBeVisible();
  await second.getByRole("button", { name: "Disconnect this tab" }).click();
  await expect.poll(() => remembered).toBe(false);
  expect(await second.evaluate(() => window.localStorage.getItem("hannah.rememberedKey.v1"))).toBeNull();
});
