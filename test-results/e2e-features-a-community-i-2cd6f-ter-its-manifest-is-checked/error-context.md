# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e/features.spec.ts >> a community instruction skill installs only after its manifest is checked
- Location: e2e/features.spec.ts:69:1

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/marketplace", waiting until "load"

```

# Test source

```ts
  1   | import { expect, test, type Page } from "@playwright/test";
  2   | 
  3   | const groqKey = "gsk_e2eFeatureKey0123456789abcdefghijklmnop";
  4   | 
  5   | async function connectAsGuest(page: Page) {
  6   |   await page.route(/\/(api|v1)\//, async (route) => {
  7   |     const url = new URL(route.request().url());
  8   |     if (url.pathname === "/api/catalog") {
  9   |       return route.fulfill({ contentType: "application/json", body: JSON.stringify({ byok: true, providers: [{ id: "groq", label: "Groq", kind: "openai", local: false, free: true, configured: true, models: [
  10  |         { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", tools: true, vision: false, context: 131072, free: true, price: null },
  11  |         { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant", tools: true, vision: false, context: 131072, free: true, price: null },
  12  |       ] }] }) });
  13  |     }
  14  |     if (url.pathname === "/v1/usage") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ spentUsd: 0, capUsd: null, remainingUsd: null }) });
  15  |     if (url.pathname === "/api/health") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "ok", provider: "Groq", ready: true }) });
  16  |     return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  17  |   });
  18  |   await page.addInitScript((key) => {
  19  |     sessionStorage.setItem("hannah.session.groqKey", key);
  20  |     localStorage.setItem("hannah.hardware.v1", JSON.stringify({ os: "linux", cpuThreads: 8, ramGB: 16, gpuKind: "none", gpuName: "", vramGB: null, reservedGB: 4, online: true }));
  21  |   }, groqKey);
  22  | }
  23  | 
  24  | test("the model advisor recommends models for the user's device", async ({ page }) => {
  25  |   await connectAsGuest(page);
  26  |   await page.goto("/models");
  27  |   await expect(page.getByRole("heading", { name: "Find the right model for you." })).toBeVisible();
  28  |   await page.getByRole("radiogroup", { name: "Optimize for" }).getByRole("radio", { name: "Privacy-first" }).click();
  29  |   await expect(page.getByText("Showing local models only")).toBeVisible();
  30  |   const top = page.getByRole("article").first();
  31  |   await expect(top).toContainText("Top pick");
  32  |   await expect(top).toContainText("Local: prompts stay on your computer");
  33  |   await expect(top).toContainText("KV cache");
  34  | });
  35  | 
  36  | test("Use in chat opens the chat with the recommended model selected", async ({ page }) => {
  37  |   await connectAsGuest(page);
  38  |   await page.route(/\/api\/(providers|models)/, async (route) => {
  39  |     const url = new URL(route.request().url());
  40  |     if (url.pathname === "/api/providers") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ defaultProvider: "groq", providers: [{ id: "groq", label: "Groq", local: false, configured: true }] }) });
  41  |     // The live list deliberately omits the advisor's pick: an explicit choice must still stick.
  42  |     return route.fulfill({ contentType: "application/json", body: JSON.stringify({ provider: "Groq", defaultModel: "llama-3.1-8b-instant", models: ["llama-3.1-8b-instant"] }) });
  43  |   });
  44  |   await page.addInitScript(() => localStorage.setItem("hannah.onboarding.v1", "complete"));
  45  |   await page.goto("/models");
  46  |   // Target the hosted card by name: the list re-sorts once the catalog arrives.
  47  |   const pick = page.getByRole("article", { name: "GPT-OSS 120B on Groq" });
  48  |   await expect(pick).toBeVisible();
  49  |   const modelId = "openai/gpt-oss-120b";
  50  |   await pick.getByRole("button", { name: "Use in chat" }).click();
  51  | 
  52  |   await expect(page).toHaveURL(/\/chat$/);
  53  |   await expect(page.getByRole("textbox", { name: "Message HANNAH" })).toBeVisible();
  54  |   await page.getByRole("button", { name: "Inference and privacy settings" }).click();
  55  |   await expect(page.getByLabel(/Groq model/)).toHaveValue(modelId);
  56  | });
  57  | 
  58  | test("reminders can be added and cancelled from the dashboard", async ({ page }) => {
  59  |   await connectAsGuest(page);
  60  |   await page.goto("/dashboard");
  61  |   const card = page.getByRole("region", { name: "Reminders" });
  62  |   await card.getByLabel("Reminder").fill("Review the pull request");
  63  |   await card.getByRole("button", { name: "Add" }).click();
  64  |   await expect(card.getByText("Review the pull request")).toBeVisible();
  65  |   await card.getByRole("button", { name: "Cancel reminder: Review the pull request" }).click();
  66  |   await expect(card.getByText("No upcoming reminders")).toBeVisible();
  67  | });
  68  | 
  69  | test("a community instruction skill installs only after its manifest is checked", async ({ page }) => {
  70  |   await connectAsGuest(page);
> 71  |   await page.goto("/marketplace");
      |              ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  72  |   await page.getByRole("tab", { name: "Agents and skills" }).click();
  73  |   const panel = page.getByRole("region", { name: "Community skills" });
  74  |   await panel.getByLabel("Manifest JSON").fill(JSON.stringify({ manifestVersion: 1, type: "executable-plugin" }));
  75  |   await panel.getByRole("button", { name: "Check manifest" }).click();
  76  |   await expect(panel.getByRole("alert")).toContainText("Can't install this skill");
  77  | 
  78  |   await panel.getByRole("button", { name: "Load an example" }).click();
  79  |   await panel.getByRole("button", { name: "Check manifest" }).click();
  80  |   await expect(panel.getByText("None: guidance text only")).toBeVisible();
  81  |   await panel.getByRole("button", { name: "Install skill" }).click();
  82  |   const toggle = panel.getByRole("switch", { name: "Turn on Meeting notes" });
  83  |   await toggle.click();
  84  |   await expect(panel.getByRole("switch", { name: "Turn off Meeting notes" })).toHaveAttribute("aria-checked", "true");
  85  | });
  86  | 
  87  | test("the Agents screen shows each specialist's tools and can turn one off", async ({ page }) => {
  88  |   await connectAsGuest(page);
  89  |   await page.goto("/agents");
  90  |   await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  91  |   const research = page.getByRole("region", { name: "Research agent" });
  92  |   await expect(research).toContainText("read_app_file");
  93  |   await expect(research.getByLabel("Model")).toHaveValue("auto");
  94  |   const toggle = research.getByRole("switch", { name: "Turn off the Research agent" });
  95  |   await toggle.click();
  96  |   await expect(research.getByRole("switch", { name: "Turn on the Research agent" })).toHaveAttribute("aria-checked", "false");
  97  |   await expect(page.getByRole("region", { name: "Team activity" })).toContainText("No team runs yet");
  98  | });
  99  | 
  100 | test("voice settings offer device and hosted engines with honest availability", async ({ page }) => {
  101 |   await connectAsGuest(page);
  102 |   await page.route("**/api/voice/providers", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
  103 |     tts: [{ id: "openai", label: "OpenAI voices", hosted: true, available: false, voices: ["coral"], model: "gpt-4o-mini-tts" }],
  104 |     stt: [{ id: "groq-whisper", label: "Groq Whisper", hosted: true, available: true, model: "whisper-large-v3-turbo" }],
  105 |     mithi: false,
  106 |   }) }));
  107 |   await page.goto("/settings");
  108 |   const voice = page.getByRole("region", { name: "Voice" });
  109 |   await expect(voice.getByRole("radio", { name: /Device voice/ })).toBeVisible();
  110 |   await expect(voice.getByRole("radio", { name: /OpenAI voices/ })).toBeDisabled();
  111 |   await expect(voice).toContainText("Needs an OpenAI key");
  112 |   await voice.getByRole("radio", { name: /Groq Whisper/ }).check();
  113 |   await expect(voice.getByLabel("Interrupt by talking")).toBeChecked();
  114 |   const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("hannah.voice.settings.v1") || "{}"));
  115 |   expect(stored.stt).toBe("groq-whisper");
  116 | });
  117 | 
  118 | test("signing in with an account opens the app", async ({ page }) => {
  119 |   let signedIn = false;
  120 |   await page.route(/\/(api|v1)\//, async (route) => {
  121 |     const url = new URL(route.request().url());
  122 |     if (url.pathname === "/api/account/status") {
  123 |       return route.fulfill({ contentType: "application/json", body: JSON.stringify({
  124 |         accounts: { enabled: true, signup: true, serverKeys: false },
  125 |         database: { configured: true, ready: true, kind: "postgres", provider: "supabase", schemaVersion: 2 },
  126 |         vault: true,
  127 |         user: signedIn ? { id: "u1", email: "ada@example.com", displayName: "Ada", via: "session", providers: ["groq"] } : null,
  128 |       }) });
  129 |     }
  130 |     if (url.pathname === "/api/account/login") {
  131 |       const body = route.request().postDataJSON();
  132 |       if (body.password !== "correct horse battery") return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "That email and password don't match an account." }) });
  133 |       signedIn = true;
  134 |       return route.fulfill({ contentType: "application/json", body: JSON.stringify({ user: { id: "u1", email: "ada@example.com", displayName: "Ada" } }) });
  135 |     }
  136 |     if (url.pathname.startsWith("/api/account/data/")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ value: null, version: 0 }) });
  137 |     if (url.pathname === "/api/account/credentials") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ vault: true, credentials: [{ providerId: "groq", label: "Groq", hint: "gsk_…abcd", updatedAt: 1 }] }) });
  138 |     return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  139 |   });
  140 |   await page.goto("/");
  141 |   await page.getByRole("button", { name: /Talk to HANNAH/i }).first().click();
  142 |   await page.getByRole("button", { name: "Have an account? Sign in or create one" }).click();
  143 |   const dialog = page.getByRole("dialog");
  144 |   await expect(dialog).toContainText("Supabase");
  145 |   await dialog.getByLabel("Email").fill("ada@example.com");
  146 |   await dialog.getByLabel("Password").fill("wrong password");
  147 |   await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  148 |   await expect(dialog.getByRole("alert")).toContainText("don't match");
  149 |   await dialog.getByLabel("Password").fill("correct horse battery");
  150 |   await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  151 |   await expect(page).toHaveURL(/\/chat$/);
  152 |   await page.goto("/settings");
  153 |   const account = page.getByRole("region", { name: "Account" });
  154 |   await expect(account).toContainText("ada@example.com");
  155 |   await expect(account.getByRole("list", { name: "Saved provider keys" })).toContainText("gsk_…abcd");
  156 | });
  157 | 
  158 | test("the Integrations page explains bringing your own database", async ({ page }) => {
  159 |   await page.route(/\/(api|v1)\//, (route) => {
  160 |     const url = new URL(route.request().url());
  161 |     if (url.pathname === "/api/db/status") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ database: { configured: false, ready: false, kind: null, provider: null }, vault: false }) });
  162 |     return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  163 |   });
  164 |   await page.goto("/integrations");
  165 |   const card = page.getByRole("region", { name: "Database" });
  166 |   await expect(card).toContainText("Not connected");
  167 |   await card.getByRole("tab", { name: "Neon" }).click();
  168 |   await expect(card).toContainText("neon.tech");
  169 |   await card.getByRole("tab", { name: "SQLite" }).click();
  170 |   await expect(card).toContainText("sqlite:./data/hannah.db");
  171 |   await expect(card.getByRole("button", { name: "Test connection" })).toBeDisabled();
```