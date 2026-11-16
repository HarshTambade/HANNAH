import { expect, test, type Page } from "@playwright/test";

const now = Date.now();
const laptop = { id: "dev-laptop00000000000000001", name: "MacBook" };

/** Signed in to a HANNAH account, with the account API answered by `handle`. */
async function signedIn(page: Page, handle: (path: string, method: string, body: Record<string, unknown>) => unknown) {
  await page.route(/\/(api|v1)\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/health") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "ok", provider: "Groq", ready: true }) });
    if (url.pathname === "/api/account/status") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ accounts: { enabled: true, signup: true, serverKeys: false }, database: { configured: true, ready: true, kind: "postgres", provider: "neon" }, vault: true, user: { id: "u1", email: "me@example.com", displayName: "", via: "session", providers: [] } }) });
    }
    const answer = handle(url.pathname + url.search, request.method(), JSON.parse(request.postData() || "{}"));
    if (answer === undefined) return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(answer) });
  });
  await page.addInitScript(() => localStorage.setItem("hannah.account.v1", JSON.stringify({ email: "me@example.com" })));
}

test("an approval asked on the laptop can be answered from this device", async ({ page }) => {
  const decisions: Array<Record<string, unknown>> = [];
  let status = "waiting";
  await signedIn(page, (path, method, body) => {
    if (path.startsWith("/api/account/tasks/approval-") && path.endsWith("/decision") && method === "POST") {
      decisions.push(body);
      status = body.approve ? "approved" : "denied";
      return { task: { id: "approval-1", status } };
    }
    if (path.startsWith("/api/account/tasks")) {
      return { tasks: [
        { id: "approval-0001", kind: "approval", title: "Send an email", detail: "To: sam@example.com\nSubject: Running late", status, device: laptop, createdAt: now, updatedAt: now, expiresAt: now + 600_000, decidedAt: null, decidedBy: status === "waiting" ? null : "This phone" },
        { id: "team-run-0001", kind: "task", title: "Research flights to Lisbon", detail: "2 of 3 steps done", status: "running", device: laptop, createdAt: now, updatedAt: now, expiresAt: null, decidedAt: null, decidedBy: null },
      ] };
    }
    return undefined;
  });
  // The Dashboard lists what your devices are doing, with the approval inline.
  await page.goto("/dashboard");
  const list = page.getByRole("list", { name: "Tasks across your devices" });
  await expect(list).toContainText("Research flights to Lisbon");
  await expect(list).toContainText("MacBook");
  await expect(page.getByRole("alertdialog", { name: "Approval from MacBook" })).toHaveCount(0);

  // On any other screen it floats, with the whole request readable.
  await page.getByRole("link", { name: "Agents" }).first().click();
  const card = page.getByRole("alertdialog", { name: "Approval from MacBook" });
  await expect(card).toContainText("MacBook needs your approval");
  await expect(card).toContainText("Subject: Running late");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved. MacBook will continue.").first()).toBeVisible();
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ approve: true, deviceId: expect.stringMatching(/^dev-/) });
  await expect(card).toBeHidden();
});

test("connecting Google goes to Google's own sign-in and comes back connected", async ({ page }) => {
  let connected = false;
  const starts: Array<Record<string, unknown>> = [];
  await signedIn(page, (path, method, body) => {
    if (path === "/api/account/connections") {
      return { vault: true, providers: [
        { id: "google", label: "Google", services: "Google Calendar and Gmail", configured: true, connected, email: connected ? "me@gmail.com" : null, connectedAt: connected ? now : null, redirectUri: "https://hannah.example/api/account/connections/google/callback" },
        { id: "microsoft", label: "Microsoft", services: "Outlook Calendar and Mail", configured: false, connected: false, email: null, connectedAt: null, redirectUri: "" },
      ] };
    }
    if (path === "/api/account/connections/google/start" && method === "POST") {
      starts.push(body);
      return { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=abc" };
    }
    return undefined;
  });
  await page.route("https://accounts.google.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Sign in - Google Accounts</title><h1>Google sign-in</h1>" }));
  await page.goto("/settings");

  const accounts = page.getByRole("list", { name: "Calendar and email accounts" });
  await expect(accounts).toContainText("Not set up on this server yet");
  await expect(accounts.getByRole("button", { name: "Connect Microsoft" })).toBeDisabled();
  await accounts.getByRole("button", { name: "Connect Google" }).click();
  await expect(page).toHaveURL(/accounts\.google\.com/);
  expect(starts[0].returnTo).toMatch(/\/settings$/);

  // Google sends the browser back through HANNAH's server to Settings.
  connected = true;
  await page.goto("/settings?connected=google");
  await expect(page.getByRole("status").filter({ hasText: "Google connected" })).toBeVisible();
  await expect(accounts).toContainText("Connected as me@gmail.com");
  await expect(page).toHaveURL(/\/settings$/);
});
