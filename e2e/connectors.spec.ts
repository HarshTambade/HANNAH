import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

const groqKey = "gsk_e2eConnectorsKey0123456789abcdefghijkl";
const catalog = [
  { id: "context7", name: "Context7", category: "Docs and research", url: "https://mcp.context7.com/mcp", auth: "none", description: "Up-to-date documentation and code examples for libraries.", docs: "https://context7.com" },
  { id: "linear", name: "Linear", category: "Project management", url: "https://mcp.linear.app/mcp", auth: "oauth", description: "Find, create and update issues, projects and comments.", docs: "https://linear.app/docs/mcp" },
  { id: "github", name: "GitHub", category: "Developer tools", url: "https://api.githubcopilot.com/mcp/", auth: "token", description: "Repositories, issues, pull requests, code search and Actions.", docs: "https://github.com/github/github-mcp-server", tokenHelp: "Create a fine-grained personal access token." },
];

test("the Connectors directory connects a service without sign-in and one with OAuth (PKCE), and keeps them in this browser", async ({ page }) => {
  let challenge = "";
  let verifierOk = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON?.() ?? {};
    if (url.pathname === "/api/connectors/catalog") return route.fulfill({ json: { connectors: catalog } });
    if (url.pathname === "/api/connectors/register") return route.fulfill({ json: { clientId: "client_e2e", authorizationEndpoint: "https://auth.vendor.test/authorize", resource: "https://mcp.linear.app/mcp", scope: "read write" } });
    if (url.pathname === "/api/connectors/token") {
      verifierOk = createHash("sha256").update(String(body.codeVerifier)).digest("base64url") === challenge && body.code === "code_e2e";
      return verifierOk ? route.fulfill({ json: { accessToken: "at_e2e", refreshToken: "rt_e2e", expiresAt: Date.now() + 3_600_000 } }) : route.fulfill({ status: 401, json: { error: "PKCE mismatch", reason: "reauth" } });
    }
    if (url.pathname === "/api/connectors/rpc") {
      const name = body.url.includes("linear") ? ["create_issue", "list_issues", "update_issue"] : ["resolve-library-id", "query-docs"];
      return route.fulfill({ json: { tools: name.map((tool: string) => ({ name: tool, description: tool, inputSchema: { type: "object", properties: {} }, readOnly: tool.startsWith("list") })) } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  // The vendor's sign-in page: the person approves and it redirects back with a code.
  await page.route("https://auth.vendor.test/**", (route) => {
    const authorize = new URL(route.request().url());
    challenge = authorize.searchParams.get("code_challenge") || "";
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const back = new URL(authorize.searchParams.get("redirect_uri") || "");
    back.searchParams.set("code", "code_e2e");
    back.searchParams.set("state", authorize.searchParams.get("state") || "");
    return route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
  await page.addInitScript((key) => sessionStorage.setItem("hannah.session.groqKey", key), groqKey);

  await page.goto("/marketplace");
  const directory = page.getByRole("list", { name: "Connector directory" });
  await expect(directory.getByRole("listitem")).toHaveCount(3);
  await page.getByLabel("Search connectors").fill("issues");
  await expect(directory.getByRole("listitem")).toHaveCount(2);
  await page.getByLabel("Search connectors").fill("");

  await page.getByRole("button", { name: "Connect Context7" }).click();
  await expect(page.getByRole("status")).toContainText("Context7 is connected: 2 tools");

  await page.getByRole("button", { name: "Connect Linear" }).click();
  await page.waitForURL(/\/marketplace$/);
  await expect(page.getByRole("status")).toContainText("Linear is connected: 3 tools");
  expect(verifierOk, "the token request carried the verifier that matches the challenge").toBe(true);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("hannah.connectors.v1") || "[]"));
  expect(stored.map((item: { id: string }) => item.id).sort()).toEqual(["context7", "linear"]);
  expect(stored.find((item: { id: string }) => item.id === "linear").accessToken).toBe("at_e2e");

  await page.getByRole("button", { name: "Connected", exact: true }).click();
  await expect(directory.getByRole("listitem")).toHaveCount(2);
  if (process.env.HANNAH_SHOT_DIR) {
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.screenshot({ path: `${process.env.HANNAH_SHOT_DIR}/connectors-desktop.png`, fullPage: false });
  }

  // A token connector asks for the token first; Disconnect removes the tokens.
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: "Connect GitHub" }).click();
  await expect(page.getByLabel("GitHub token")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Disconnect Linear" }).click();
  const after = await page.evaluate(() => localStorage.getItem("hannah.connectors.v1") || "");
  expect(after).not.toContain("at_e2e");
});

test("on a phone the directory fits the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/connectors/catalog", (route) => route.fulfill({ json: { connectors: catalog } }));
  await page.goto("/marketplace");
  await expect(page.getByRole("button", { name: "Connect Linear" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.HANNAH_SHOT_DIR) await page.screenshot({ path: `${process.env.HANNAH_SHOT_DIR}/connectors-phone.png`, fullPage: false });
});

test("Chat apps: connect a Telegram bot and get a one-time pairing link", async ({ page }) => {
  const channels: Array<Record<string, unknown>> = [];
  let sentToken = "";
  await page.route("**/api/connectors/catalog", (route) => route.fulfill({ json: { connectors: catalog } }));
  await page.route("**/api/channels**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      sentToken = request.postDataJSON().botToken;
      channels.push({ id: "ch_abc12345", kind: "telegram", name: "@hannah_test_bot", paired: false, pairedName: null, pairingOpen: true });
      return route.fulfill({ status: 201, json: { channel: channels[0], pairing: { code: "hnCODE12345", link: "https://t.me/hannah_test_bot?start=hnCODE12345", expiresAt: Date.now() + 900_000 } } });
    }
    return route.fulfill({ json: { channels } });
  });
  await page.addInitScript((key) => {
    sessionStorage.setItem("hannah.session.groqKey", key);
    localStorage.setItem("hannah.account.v1", JSON.stringify({ email: "owner@example.com" }));
  }, groqKey);
  await page.goto("/marketplace");
  const chat = page.getByRole("region", { name: "Chat apps" });
  await chat.scrollIntoViewIfNeeded();
  await chat.getByLabel("Bot token").fill("123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-ra");
  await chat.getByRole("button", { name: "Connect Telegram" }).click();
  await expect(chat.getByRole("link", { name: /Open the chat/ })).toHaveAttribute("href", "https://t.me/hannah_test_bot?start=hnCODE12345");
  await expect(chat.getByRole("list", { name: "Connected chat apps" })).toContainText("@hannah_test_bot");
  await expect(chat.getByRole("list", { name: "Connected chat apps" })).toContainText("Waiting for you to pair");
  expect(sentToken).toBe("123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-ra");
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("AAEhBOweik6ad9r");
  if (process.env.HANNAH_SHOT_DIR) await chat.screenshot({ path: `${process.env.HANNAH_SHOT_DIR}/chat-apps.png` });
});

test("Chat apps: Slack shows the webhook URL and steps to finish; someone asking to chat can be approved", async ({ page }) => {
  const webhookUrl = "https://hannah.example/api/hooks/channel/ch_slack1234";
  const steps = ["Paste the Request URL", "Subscribe to message.im"];
  let sent: Record<string, string> = {};
  let approved = "";
  const slack = { id: "ch_slack1234", kind: "slack", label: "Slack", name: "Acme · @hannah", paired: true, pairedName: "Harsh", pairingOpen: false, webhookVerified: false, allowed: [], pending: [{ id: "U2", name: "Asha", preview: "hi!" }], setup: { webhookUrl, steps } };
  await page.route("**/api/connectors/catalog", (route) => route.fulfill({ json: { connectors: catalog } }));
  await page.route("**/api/channels**", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.url().endsWith("/api/channels/slack")) {
      sent = request.postDataJSON();
      return route.fulfill({ status: 201, json: { channel: slack, pairing: { code: "hnSLACK12345", link: null, expiresAt: Date.now() + 900_000 }, setup: { webhookUrl, steps } } });
    }
    if (request.method() === "POST" && request.url().endsWith("/approve")) {
      approved = request.postDataJSON().senderId;
      return route.fulfill({ json: { channel: { ...slack, pending: [], allowed: [{ id: "U2", name: "Asha" }] } } });
    }
    return route.fulfill({ json: { channels: sent.botToken ? [approved ? { ...slack, pending: [], allowed: [{ id: "U2", name: "Asha" }] } : slack] : [] } });
  });
  await page.addInitScript((key) => {
    sessionStorage.setItem("hannah.session.groqKey", key);
    localStorage.setItem("hannah.account.v1", JSON.stringify({ email: "owner@example.com" }));
  }, groqKey);
  await page.goto("/marketplace");
  const chat = page.getByRole("region", { name: "Chat apps" });
  await chat.scrollIntoViewIfNeeded();
  await chat.getByRole("radio", { name: /Slack/ }).click();
  const connectButton = chat.getByRole("button", { name: "Connect Slack" });
  await expect(connectButton).toBeDisabled();
  await chat.getByLabel("Bot User OAuth Token").fill("xoxb-1111-2222-abcdefghijklmnopqrstuvwx");
  await chat.getByLabel("Signing secret").fill("8f742231b10e8888abcd99aaaaaa85a5");
  await connectButton.click();
  await expect(chat.getByRole("status")).toContainText("hnSLACK12345");
  await expect(chat.getByRole("status")).toContainText(webhookUrl);
  await expect(chat.getByRole("status")).toContainText("Subscribe to message.im");
  expect(sent).toEqual({ botToken: "xoxb-1111-2222-abcdefghijklmnopqrstuvwx", signingSecret: "8f742231b10e8888abcd99aaaaaa85a5" });
  const asking = chat.getByRole("group", { name: /People asking to chat/ });
  await expect(asking).toContainText("Asha");
  await asking.getByRole("button", { name: "Approve Asha" }).click();
  await expect.poll(() => approved).toBe("U2");
  await expect(chat.getByRole("list", { name: "Connected chat apps" })).toContainText("Also approved: Asha");
});
