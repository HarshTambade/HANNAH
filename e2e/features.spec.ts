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
  await page.goto("/models");
  await expect(page.getByRole("heading", { name: "Find the right model for you." })).toBeVisible();
  await page.getByRole("radiogroup", { name: "Optimize for" }).getByRole("radio", { name: "Privacy-first" }).click();
  await expect(page.getByText("Showing local models only")).toBeVisible();
  const top = page.getByRole("article").first();
  await expect(top).toContainText("Top pick");
  await expect(top).toContainText("Local: prompts stay on your computer");
  await expect(top).toContainText("KV cache");
});

test("Use in chat opens the chat with the recommended model selected", async ({ page }) => {
  await connectAsGuest(page);
  await page.route(/\/api\/(providers|models)/, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/providers") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ defaultProvider: "groq", providers: [{ id: "groq", label: "Groq", local: false, configured: true }] }) });
    // The live list deliberately omits the advisor's pick: an explicit choice must still stick.
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ provider: "Groq", defaultModel: "llama-3.1-8b-instant", models: ["llama-3.1-8b-instant"] }) });
  });
  await page.addInitScript(() => localStorage.setItem("hannah.onboarding.v1", "complete"));
  await page.goto("/models");
  // Target the hosted card by name: the list re-sorts once the catalog arrives.
  const pick = page.getByRole("article", { name: "GPT-OSS 120B on Groq" });
  await expect(pick).toBeVisible();
  const modelId = "openai/gpt-oss-120b";
  await pick.getByRole("button", { name: "Use in chat" }).click();

  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole("textbox", { name: "Message HANNAH" })).toBeVisible();
  await page.getByRole("button", { name: "Inference and privacy settings" }).click();
  await expect(page.getByLabel(/Groq model/)).toHaveValue(modelId);
});

test("reminders can be added and cancelled from the dashboard", async ({ page }) => {
  await connectAsGuest(page);
  await page.goto("/dashboard");
  const card = page.getByRole("region", { name: "Reminders" });
  await card.getByLabel("Reminder").fill("Review the pull request");
  await card.getByRole("button", { name: "Add" }).click();
  await expect(card.getByText("Review the pull request")).toBeVisible();
  await card.getByRole("button", { name: "Cancel reminder: Review the pull request" }).click();
  await expect(card.getByText("No upcoming reminders")).toBeVisible();
});

test("a community instruction skill installs only after its manifest is checked", async ({ page }) => {
  await connectAsGuest(page);
  await page.goto("/marketplace");
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

test("the Agents screen shows each specialist's tools and can turn one off", async ({ page }) => {
  await connectAsGuest(page);
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  const research = page.getByRole("region", { name: "Research agent" });
  await expect(research).toContainText("read_app_file");
  await expect(research.getByLabel("Model")).toHaveValue("auto");
  const toggle = research.getByRole("switch", { name: "Turn off the Research agent" });
  await toggle.click();
  await expect(research.getByRole("switch", { name: "Turn on the Research agent" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("region", { name: "Team activity" })).toContainText("No team runs yet");
});

test("voice settings offer device and hosted engines with honest availability", async ({ page }) => {
  await connectAsGuest(page);
  await page.route("**/api/voice/providers", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    tts: [{ id: "openai", label: "OpenAI voices", hosted: true, available: false, voices: ["coral"], model: "gpt-4o-mini-tts" }],
    stt: [{ id: "groq-whisper", label: "Groq Whisper", hosted: true, available: true, model: "whisper-large-v3-turbo" }],
    mithi: false,
  }) }));
  await page.goto("/settings");
  const voice = page.getByRole("region", { name: "Voice" });
  await expect(voice.getByRole("radio", { name: /Device voice/ })).toBeVisible();
  await expect(voice.getByRole("radio", { name: /OpenAI voices/ })).toBeDisabled();
  await expect(voice).toContainText("Needs an OpenAI key");
  await voice.getByRole("radio", { name: /Groq Whisper/ }).check();
  await expect(voice.getByLabel("Interrupt by talking")).toBeChecked();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("hannah.voice.settings.v1") || "{}"));
  expect(stored.stt).toBe("groq-whisper");
});

test("signing in with an account opens the app", async ({ page }) => {
  let signedIn = false;
  await page.route(/\/(api|v1)\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/account/status") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({
        accounts: { enabled: true, signup: true, serverKeys: false },
        database: { configured: true, ready: true, kind: "postgres", provider: "supabase", schemaVersion: 2 },
        vault: true,
        user: signedIn ? { id: "u1", email: "ada@example.com", displayName: "Ada", via: "session", providers: ["groq"] } : null,
      }) });
    }
    if (url.pathname === "/api/account/login") {
      const body = route.request().postDataJSON();
      if (body.password !== "correct horse battery") return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "That email and password don't match an account." }) });
      signedIn = true;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ user: { id: "u1", email: "ada@example.com", displayName: "Ada" } }) });
    }
    if (url.pathname.startsWith("/api/account/data/")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ value: null, version: 0 }) });
    if (url.pathname === "/api/account/credentials") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ vault: true, credentials: [{ providerId: "groq", label: "Groq", hint: "gsk_…abcd", updatedAt: 1 }] }) });
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Talk to HANNAH/i }).first().click();
  await page.getByRole("button", { name: "Have an account? Sign in or create one" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Supabase");
  await dialog.getByLabel("Email").fill("ada@example.com");
  await dialog.getByLabel("Password").fill("wrong password");
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("don't match");
  await dialog.getByLabel("Password").fill("correct horse battery");
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await page.goto("/settings");
  const account = page.getByRole("region", { name: "Account" });
  await expect(account).toContainText("ada@example.com");
  await expect(account.getByRole("list", { name: "Saved provider keys" })).toContainText("gsk_…abcd");
});

test("the Integrations page explains bringing your own database", async ({ page }) => {
  await page.route(/\/(api|v1)\//, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/db/status") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ database: { configured: false, ready: false, kind: null, provider: null }, vault: false }) });
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.goto("/integrations");
  const card = page.getByRole("region", { name: "Database" });
  await expect(card).toContainText("Not connected");
  await card.getByRole("tab", { name: "Neon" }).click();
  await expect(card).toContainText("neon.tech");
  await card.getByRole("tab", { name: "SQLite" }).click();
  await expect(card).toContainText("sqlite:./data/hannah.db");
  await expect(card.getByRole("button", { name: "Test connection" })).toBeDisabled();
});

test("the Integrations guide covers every integration with readable examples", async ({ page }) => {
  await page.route(/\/(api|v1)\//, (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
  await page.goto("/integrations");
  for (const name of ["Authentication", "REST API", "OpenAI-compatible API", "MCP server", "Agent2Agent (A2A)", "Webhooks", "Server environment", "Limits and errors", "Troubleshooting"]) {
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
  }
  // The remote MCP example was once white text on a white card.
  const remote = page.locator("pre", { hasText: "Bearer <MCP_API_TOKEN>" });
  const colors = await remote.evaluate((element) => ({ text: getComputedStyle(element).color, background: getComputedStyle(element.parentElement!).backgroundColor }));
  expect(colors.text).not.toBe(colors.background);
  expect(colors.background).toBe("rgb(2, 6, 23)");
  await expect(page.locator("pre", { hasText: "HANNAH_API_TOKEN" }).first()).toBeVisible();
});

test("an automation runs, waits for approval before acting, and records the result", async ({ page }) => {
  await connectAsGuest(page);
  const prompts: string[] = [];
  const agentRequests: Array<{ provider: string; key: string | undefined; tools: unknown[] }> = [];
  // Agent tasks go through the same /api/agent call as chat, with the visitor's key.
  await page.route("**/api/agent", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    prompts.push(body.messages?.[0]?.content ?? "");
    agentRequests.push({ provider: body.provider, key: route.request().headers()["x-groq-api-key"], tools: body.tools });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ message: { content: JSON.stringify({ reply: "1. Ship the release\n2. Reply to Maya\n3. Walk", emotion: "happy" }), tool_calls: [] } }) });
  });
  const workflow = {
    version: 1, id: "wf-e2e", name: "Plan and remember", createdAt: "2026-11-16T00:00:00Z", updatedAt: "2026-11-16T00:00:00Z",
    nodes: [
      { id: "t", kind: "trigger", label: "Weekdays at 08:00", config: { schedule: { type: "daily", time: "08:00", days: [1, 2, 3, 4, 5] } }, position: { x: 0, y: 0 } },
      { id: "a", kind: "agent-task", label: "Plan my day", config: { task: "Plan my day in three bullets" }, position: { x: 300, y: 0 } },
      { id: "m", kind: "tool-action", label: "Save the result to memory", config: { action: "save-memory" }, position: { x: 600, y: 0 } },
      { id: "o", kind: "output", label: "Only keep it in run history", config: { channel: "log" }, position: { x: 900, y: 0 } },
    ],
    edges: [{ id: "1", source: "t", target: "a" }, { id: "2", source: "a", target: "m" }, { id: "3", source: "m", target: "o" }],
  };
  await page.addInitScript((value) => {
    if (!localStorage.getItem("hannah.tasks.v1")) localStorage.setItem("hannah.tasks.v1", JSON.stringify([{ id: value.id, title: value.name, prompt: "Workflow schema v1", status: "pending", progress: 0, kind: "workflow", workflow: value, createdAt: value.createdAt, updatedAt: value.updatedAt }]));
  }, workflow);
  await page.goto("/automations");
  await expect(page.getByText("Weekdays at 08:00").first()).toBeVisible();
  await page.getByRole("button", { name: "Run Plan and remember now" }).click();

  const approval = page.getByRole("region", { name: "Waiting for your approval" });
  await expect(approval).toContainText("Plan and remember wants to: Save the result to memory");
  await expect(approval).toContainText("Ship the release");
  expect(prompts).toEqual(["Plan my day in three bullets"]);
  expect(agentRequests).toEqual([{ provider: "groq", key: groqKey, tools: [] }]);
  expect(await page.evaluate(() => localStorage.getItem("hannah.memory.v1") ?? "")).not.toContain("Ship the release");

  await approval.getByRole("button", { name: "Approve" }).click();
  await expect(approval).toBeHidden();
  const history = page.getByRole("list", { name: "Automation runs" });
  await expect(history.locator("summary").getByText("Done", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("hannah.memory.v1") ?? "")).toContain("Ship the release");

  // Turning the schedule on shows when it runs next.
  await page.getByRole("checkbox", { name: "Run on schedule" }).check();
  await expect(page.getByText(/Weekdays at 08:00 · 3 steps · next /)).toBeVisible();
});

test("an automation is built step by step, runs, and can be edited and deleted", async ({ page }) => {
  await connectAsGuest(page);
  const prompts: string[] = [];
  await page.route("**/api/agent", async (route) => {
    prompts.push(JSON.parse(route.request().postData() || "{}").messages?.[0]?.content ?? "");
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ message: { content: JSON.stringify({ reply: "Try a lentil soup with a side salad.", emotion: "happy" }), tool_calls: [] } }) });
  });
  await page.goto("/automations");
  await expect(page.getByRole("list", { name: "Saved automations" })).toHaveCount(0);

  await page.getByRole("button", { name: "New automation" }).click();
  const editor = page.getByRole("region", { name: "New automation" });
  // Saving says what's missing, one thing at a time.
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByRole("alert")).toHaveText("Give this automation a name.");
  await editor.getByLabel("Name").fill("Lunch idea");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByRole("alert")).toHaveText("Step 1: say what HANNAH should do.");
  await editor.getByLabel("What should HANNAH do?").fill("Suggest a light lunch.");

  // Weekdays only, at 12:30.
  await editor.getByRole("button", { name: "Weekdays" }).click();
  await expect(editor.getByRole("button", { name: "Saturday" })).toHaveAttribute("aria-pressed", "false");
  await expect(editor.getByRole("button", { name: "Monday" })).toHaveAttribute("aria-pressed", "true");
  await editor.getByLabel("At", { exact: true }).fill("12:30");
  await expect(editor.getByText(/Weekdays at 12:30\. Next: /)).toBeVisible();

  // Steps are added in order and can be moved and removed; nothing to wire up.
  await editor.getByRole("group", { name: "Add a step" }).getByRole("button", { name: "Action" }).click();
  await expect(editor.getByRole("listitem", { name: "Step 3: Action" })).toBeVisible();
  await editor.getByRole("button", { name: "Move step 3 up" }).click();
  await expect(editor.getByRole("listitem", { name: "Step 2: Action" })).toBeVisible();
  await editor.getByRole("button", { name: "Remove step 2" }).click();
  await expect(editor.getByRole("listitem")).toHaveCount(2);

  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved “Lunch idea”" })).toContainText("Next run:");
  const saved = page.getByRole("list", { name: "Saved automations" });
  await expect(saved).toContainText("Weekdays at 12:30 · 2 steps");
  await expect(saved.getByRole("checkbox", { name: "Run on schedule" })).toBeChecked();

  await page.getByRole("button", { name: "Run Lunch idea now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "“Lunch idea” finished." })).toBeVisible();
  await expect(page.getByRole("list", { name: "Automation runs" })).toContainText("lentil soup");
  // This screen shows the result in place, so no floating card repeats it.
  await expect(page.getByRole("status", { name: "Automation" })).toHaveCount(0);
  expect(prompts).toEqual(["Suggest a light lunch."]);
  await expect(saved).toContainText("Last run");

  // Edit opens the same steps; changes are saved in place.
  await page.getByRole("button", { name: "Edit Lunch idea" }).click();
  const edit = page.getByRole("region", { name: "Edit automation" });
  await expect(edit.getByLabel("What should HANNAH do?")).toHaveValue("Suggest a light lunch.");
  await edit.getByLabel("Name").fill("Lunch ideas");
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(saved.getByText("Lunch ideas", { exact: true })).toBeVisible();
  await expect(saved.getByRole("listitem")).toHaveCount(1);

  // Delete asks first.
  await page.getByRole("button", { name: "Delete Lunch ideas" }).click();
  await page.getByRole("group", { name: "Delete Lunch ideas?" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("list", { name: "Saved automations" })).toHaveCount(0);
});

test("a template opens ready to save", async ({ page }) => {
  await connectAsGuest(page);
  await page.goto("/automations");
  await page.getByRole("button", { name: "Use the Friday review template" }).click();
  const editor = page.getByRole("region", { name: "New automation" });
  await expect(editor.getByLabel("Name")).toHaveValue("Friday review");
  await expect(editor.getByRole("button", { name: "Friday" })).toHaveAttribute("aria-pressed", "true");
  await expect(editor.getByRole("button", { name: "Monday" })).toHaveAttribute("aria-pressed", "false");
  await expect(editor.getByRole("listitem")).toHaveCount(3);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("list", { name: "Saved automations" })).toContainText("Fri at 16:00 · 3 steps");
});

test("the memory center records sources, refuses secrets, and chat sends only related memories", async ({ page }) => {
  await connectAsGuest(page);
  const sentMemories: string[][] = [];
  await page.route(/\/api\/(providers|models|agent)$/, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/providers") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ defaultProvider: "groq", providers: [{ id: "groq", label: "Groq", local: false, configured: true }] }) });
    if (url.pathname === "/api/models") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ provider: "Groq", defaultModel: "openai/gpt-oss-120b", models: ["openai/gpt-oss-120b"] }) });
    const body = JSON.parse(route.request().postData() || "{}");
    sentMemories.push(Array.isArray(body.memories) ? body.memories : []);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ message: { content: JSON.stringify({ reply: "Bruno is a beagle.", emotion: "happy" }), tool_calls: [] } }) });
  });
  await page.addInitScript(() => window.localStorage.setItem("hannah.onboarding.v1", "complete"));
  await page.goto("/memory");

  const input = page.getByLabel("Add something for HANNAH to remember");
  const add = async (text: string) => {
    await input.fill(text);
    await page.getByRole("button", { name: "Add", exact: true }).click();
  };
  await add("I prefer short answers");
  await expect(page.getByRole("status").filter({ hasText: "Saved under Preferences." })).toBeVisible();
  await add("My dog Bruno is a beagle");
  await add("I take medication for anxiety");
  await expect(page.getByRole("status").filter({ hasText: "marked sensitive" })).toBeVisible();
  await add("My password is hunter22!");
  await expect(page.getByRole("status").filter({ hasText: "never stores passwords" })).toBeVisible();
  await add("Gardening tips from my neighbour are great");

  const memories = page.getByRole("list", { name: "Memories" }).getByRole("listitem");
  await expect(memories).toHaveCount(4);
  await expect(memories.first()).toContainText("Added by you");
  await page.getByLabel("Search memories").fill("bruno");
  await expect(memories).toHaveCount(1);
  await expect(memories.first()).toContainText("My dog Bruno is a beagle");
  await page.getByLabel("Search memories").fill("");

  await page.getByRole("navigation", { name: "App navigation" }).getByRole("link", { name: "Chat" }).click();
  const message = page.getByRole("textbox", { name: "Message HANNAH" });
  await message.fill("What breed is Bruno again?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Bruno is a beagle.")).toBeVisible();
  // Related memories and preferences go with the message; unrelated and sensitive ones don't.
  expect(sentMemories.at(-1)).toEqual(["My dog Bruno is a beagle", "I prefer short answers"]);

  // With memory off, nothing is sent.
  await page.getByRole("navigation", { name: "App navigation" }).getByRole("link", { name: /Memory/ }).click();
  await page.getByRole("switch", { name: "Memory on" }).click();
  await expect(page.getByText("Memory is off: HANNAH doesn't use or save memories.")).toBeVisible();
  await page.getByRole("navigation", { name: "App navigation" }).getByRole("link", { name: "Chat" }).click();
  await message.fill("And how old is Bruno?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => sentMemories.length).toBe(2);
  expect(sentMemories.at(-1)).toEqual([]);
});
