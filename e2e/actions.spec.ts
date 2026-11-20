/**
 * The Actions screen, end to end in a browser against a REAL HANNAH server:
 * a real account database (SQLite), the real Action Engine and permission
 * manager, the real coding service working on a real git repository with
 * seeded defects, and that project's real test run. Only the AI provider is
 * a local stand-in (support/fake-coding-ai-preload.cjs), so no key is needed.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const here = __dirname;
const serverDir = resolve(here, "../server");
const seeded = createRequire(join(here, "actions.spec.ts"))(join(serverDir, "test-fixtures", "seeded-repo.js")) as { BUG_LINE: string; FIXED_AVERAGE: string; createSeededRepo: (parent: string, options?: { name?: string }) => { root: string; sha: string } };
const port = 3800 + Math.floor(Math.random() * 90);
const api = `http://127.0.0.1:${port}`;
let server: ChildProcess;
let serverLog = "";
let repo: { root: string; sha: string };
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo.root, encoding: "utf8" }).trim();

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "hannah-actions-e2e-")));
  repo = seeded.createSeededRepo(dataDir, { name: "shop" });
  server = spawn(process.execPath, ["--require", join(here, "support", "fake-coding-ai-preload.cjs"), "index.js"], {
    cwd: serverDir,
    env: { ...process.env, NODE_ENV: "development", PORT: String(port), HOST: "127.0.0.1", DATABASE_URL: `sqlite:${join(dataDir, "hannah.db")}`, HANNAH_VAULT_KEY: "f".repeat(64), HANNAH_CODE_ROOTS: dataDir, VERCEL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk) => { serverLog += chunk; });
  server.stderr?.on("data", (chunk) => { serverLog += chunk; });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`${api}/api/health`)).ok) return; } catch { /* not listening yet */ }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`The HANNAH server didn't start:\n${serverLog}`);
});
test.afterAll(() => { server?.kill(); });

async function signedIn(page: Page, email: string) {
  await page.route(/\/(api|v1)\//, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${api}${url.pathname}${url.search}`, timeout: 120_000 });
    await route.fulfill({ response });
  });
  const registered = await page.request.post(`${api}/api/account/register`, { data: { email, password: "correct horse battery" } });
  if (registered.status() !== 200) {
    const login = await page.request.post(`${api}/api/account/login`, { data: { email, password: "correct horse battery" } });
    expect(login.status(), await login.text()).toBe(200);
  } else {
    const key = await page.request.put(`${api}/api/account/credentials/groq`, { data: { apiKey: "gsk_e2eActionsKey00123456789abcdefghij" } });
    expect(key.status(), await key.text()).toBe(200);
  }
  await page.addInitScript((address) => {
    localStorage.setItem("hannah.account.v1", JSON.stringify({ email: address, displayName: "" }));
    localStorage.setItem("hannah.onboarding.v1", "complete");
  }, email);
}
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });

test("without an account the screen says what an account is for; with one it starts empty and honest", async ({ page }) => {
  await page.addInitScript(() => { sessionStorage.setItem("hannah.session.groqKey", "gsk_e2eActionsKey00123456789abcdefghij"); localStorage.setItem("hannah.onboarding.v1", "complete"); });
  await page.route(/\/(api|v1)\//, (route) => route.fulfill({ status: 401, json: { error: "Sign in." } }));
  await page.goto("/actions");
  await expect(page.getByRole("heading", { name: "Actions", level: 1 })).toBeVisible();
  await expect(page.getByText(/Sign in to an account/)).toBeVisible();
  await expect(tab(page, "Permissions")).toHaveCount(0);
});

test("permission levels are kept on the server, and the connections list says what each one can't do", async ({ page }) => {
  await signedIn(page, "owner@example.com");
  await page.goto("/actions");
  await expect(page.getByText("Nothing is waiting.")).toBeVisible();
  await expect(page.getByText(/HANNAH hasn't done anything for this account yet/)).toBeVisible();

  await tab(page, "Permissions").click();
  const email = page.getByLabel("Email", { exact: true });
  await expect(email).toHaveValue("3");
  await email.selectOption("1");
  await page.reload();
  await tab(page, "Permissions").click();
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("1");
  // A standing permission needs level 4: the server refuses it at level 1 and says why.
  await page.getByLabel("Service").selectOption("mail");
  await page.getByLabel("Send an email").check();
  await page.getByRole("button", { name: "Add permission" }).click();
  await expect(page.getByRole("alert")).toContainText("level 4");
  await page.getByLabel("Email", { exact: true }).selectOption("4");
  await page.getByLabel("Only for (optional)").fill("*@team.example");
  await page.getByRole("button", { name: "Add permission" }).click();
  const grant = page.getByTestId("grant");
  await expect(grant).toContainText("Send an email — only for *@team.example");
  await expect(grant).toContainText("used 0 times, last never");
  await grant.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("grant")).toContainText("Revoked");
  await page.getByLabel("Email", { exact: true }).selectOption("3");

  await tab(page, "Connections").click();
  const bookings = page.getByTestId("integration").filter({ hasText: "Restaurants, travel, appointments" });
  await expect(bookings).toContainText("Not connected");
  await expect(bookings).toContainText("HANNAH never reports a booking as made");
  await expect(page.getByTestId("integration").filter({ hasText: "WhatsApp" }).first()).toContainText("not your own account");
  await expect(page.getByTestId("integration").filter({ hasText: "GitHub" })).toContainText("Force pushes");
});

test("scan a real repository, prepare a fix, run its tests after approval, publish to a branch, and stop everything", async ({ page }) => {
  test.setTimeout(180_000);
  await signedIn(page, "owner@example.com");
  // The person is in the middle of something in their checkout.
  writeFileSync(join(repo.root, "notes.txt"), "work in progress\n");
  await page.goto("/actions#code");

  await page.getByLabel(/Add a local repository/).fill(repo.root);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("repo")).toContainText(repo.root);
  await expect(page.getByTestId("repo").getByRole("combobox")).toHaveValue("pull-request");

  // Scan: static checks on every file, a model review whose invented finding is dropped.
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  const scan = page.getByTestId("coding-task");
  await expect(scan).toHaveAttribute("data-status", "completed", { timeout: 60_000 });
  await expect(scan.getByTestId("finding").filter({ hasText: "AWS access key in the repository" })).toContainText("‹redacted›");
  await expect(scan.getByTestId("finding").filter({ hasText: "Unresolved merge conflict" })).toContainText("src/merge.js:3");
  await expect(scan.getByTestId("finding").filter({ hasText: "Average divides by one too few" })).toContainText("Suspected by a model reading the code; not reproduced");
  await expect(scan).toContainText("1 model finding was dropped because the quoted line wasn't in the file");
  await expect(scan.getByText("Invented finding")).toHaveCount(0);
  // The seeded key's value (built here from two parts, so this file holds no key-shaped text) is nowhere on the page.
  expect(await page.content()).not.toContain(`AKIA${"Q4R7T2ZLM9XWPKD3"}`);

  // A change: planned and edited, then it waits for approval to run the project's own tests.
  await page.getByLabel("What", { exact: true }).selectOption("change");
  await page.getByLabel("What to change or fix").fill("The order average is too high. Fix the average calculation in src/math.js.");
  await page.getByRole("button", { name: "Prepare the change" }).click();
  const change = page.getByTestId("coding-task");
  await expect(change).toHaveAttribute("data-status", "waiting-approval", { timeout: 60_000 });
  await expect(change).toContainText("Your checkout has 1 uncommitted change");
  await expect(change.getByTestId("diff")).toContainText(`-${seeded.BUG_LINE}`);
  await expect(change.getByTestId("diff")).toContainText(`+${seeded.FIXED_AVERAGE}`);

  await tab(page, "Activity").click();
  const run = page.getByTestId("action-card").filter({ hasText: "Run “test”" });
  await expect(run).toContainText("npm run test --silent");
  await expect(run).toContainText("Your checkout isn't touched");
  await run.getByRole("button", { name: "Approve" }).click();
  await expect(run).toHaveAttribute("data-status", "done", { timeout: 60_000 });
  await expect(run).toContainText("exited with code 0");

  await tab(page, "Code").click();
  await page.getByRole("button", { name: "Open" }).first().click();
  const task = page.getByTestId("coding-task");
  await task.getByRole("button", { name: "Continue" }).click();
  await expect(task).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
  await expect(task).toContainText("test: passed");

  // Publishing asks first, with the branch and the files; nothing is committed until the approval.
  expect(git("branch", "--list", "hannah/the-order-average*")).not.toBe("");
  expect(git("log", "--all", "--oneline").split("\n")).toHaveLength(1);
  await task.getByRole("button", { name: "Publish…" }).click();
  await expect(task).toContainText("Approve the publish in the Activity tab");
  await tab(page, "Activity").click();
  const publish = page.getByTestId("action-card").filter({ hasText: "Commit to a new branch (not pushed) in" });
  await expect(publish).toContainText("src/math.js (+1 −1)");
  await expect(publish).toContainText("test: passed");
  await publish.getByRole("button", { name: "Approve" }).click();
  await expect(publish).toHaveAttribute("data-status", "done", { timeout: 60_000 });
  await expect(publish).toContainText("It was not pushed");

  // On disk: the fix is on HANNAH's branch; the checkout, its branch and the unfinished work are as they were.
  const branch = git("branch", "--list", "hannah/the-order-average*").replace(/^[*+\s]+/, "");
  expect(git("show", `${branch}:src/math.js`)).toContain(seeded.FIXED_AVERAGE);
  expect(git("log", "-1", "--format=%an|%B", branch)).toMatch(/^Asha\|Fix average\(\)/);
  expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git("rev-parse", "HEAD")).toBe(repo.sha);
  expect(git("status", "--porcelain")).toBe("?? notes.txt");
  expect(readFileSync(join(repo.root, "src/math.js"), "utf8")).toContain(seeded.BUG_LINE);

  // The emergency stop: a new change is refused before anything runs, until it is turned off.
  await page.getByRole("button", { name: "Stop everything" }).click();
  await expect(page.getByRole("heading", { name: "Everything is stopped" })).toBeVisible();
  const refused = await page.request.post(`${api}/api/actions`, { data: { action: "files.write", params: { summary: "Write a file", target: "a.txt" } } });
  expect((await refused.json()).record.permission.code).toBe("stopped");
  await page.getByRole("button", { name: "Let HANNAH act again" }).click();
  await expect(page.getByRole("heading", { name: "Emergency stop" })).toBeVisible();
});
