/**
 * Teleoperation handoff, end to end in a browser against a REAL HANNAH server
 * and the REAL HANNAH Robotics Runtime driving HANNAH's built-in kinematic
 * simulator. This is a SIMULATION test: not Gazebo, not a physical robot.
 *
 * It checks the handoff steps, driving with the keyboard deadman, the robot
 * holding by itself when the key is let go, autonomy refused while manual
 * control is held, and autonomy restored only by a person afterwards.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const serverDir = resolve(__dirname, "../server");
const runtimeDir = resolve(__dirname, "../robotics/runtime");
const port = 3800 + Math.floor(Math.random() * 90);
const api = `http://127.0.0.1:${port}`;
const python = spawnSync("python3", ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"]).status === 0;
const EMAIL = "operator@example.com";
let server: ChildProcess;
let runtime: ChildProcess | null = null;
let serverLog = "";
let runtimeLog = "";
let stateDir = "";
let robotId = "";

test.describe.configure({ mode: "serial" });
test.skip(!python, "python3 (3.9 or newer) isn't installed, so the robot runtime can't run here");

test.beforeAll(async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "hannah-teleop-e2e-")));
  stateDir = join(dataDir, "robot");
  server = spawn(process.execPath, ["index.js"], {
    cwd: serverDir,
    env: { ...process.env, NODE_ENV: "development", PORT: String(port), HOST: "127.0.0.1", DATABASE_URL: `sqlite:${join(dataDir, "hannah.db")}`, HANNAH_VAULT_KEY: "b".repeat(64), HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S: "100000", VERCEL: "" },
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
test.afterAll(() => { runtime?.kill(); server?.kill(); });

async function signedIn(page: Page) {
  await page.route(/\/(api|v1)\//, async (route) => {
    const url = new URL(route.request().url());
    // Each request answered on its own, never from a conditional (304) answer meant for another one.
    const headers = Object.fromEntries(Object.entries(route.request().headers()).filter(([name]) => !/^if-(none-match|modified-since)$/i.test(name)));
    const response = await route.fetch({ url: `${api}${url.pathname}${url.search}`, headers, timeout: 60_000 });
    await route.fulfill({ status: response.status(), headers: { ...response.headers(), "cache-control": "no-store" }, body: await response.body() });
  });
  const registered = await page.request.post(`${api}/api/account/register`, { data: { email: EMAIL, password: "correct horse battery" } });
  if (registered.status() !== 200) expect((await page.request.post(`${api}/api/account/login`, { data: { email: EMAIL, password: "correct horse battery" } })).status()).toBe(200);
  await page.addInitScript((address) => {
    localStorage.setItem("hannah.account.v1", JSON.stringify({ email: address, displayName: "" }));
    localStorage.setItem("hannah.onboarding.v1", "complete");
    sessionStorage.setItem("hannah.session.groqKey", "gsk_e2eTeleopKey0123456789abcdefghijkl");
  }, EMAIL);
}
const pose = async (request: APIRequestContext) => (await (await request.get(`${api}/api/robots/${robotId}`)).json()).robot.state?.pose as { x: number; y: number } | undefined;

test("manual control: the handoff in order, the deadman, exclusive control, and autonomy restored by a person", async ({ page }) => {
  test.setTimeout(120_000);
  await signedIn(page);
  const created = await page.request.post(`${api}/api/robots`, { data: { name: "Rescue", simulated: true } });
  expect(created.status()).toBe(201);
  const { robot, enrollment } = await created.json();
  robotId = robot.id;
  const enrolled = spawnSync("python3", ["-m", "hannah_robot", "enroll", "--server", api, "--code", enrollment.code, "--state-dir", stateDir], { cwd: runtimeDir, encoding: "utf8" });
  expect(enrolled.status, enrolled.stdout + enrolled.stderr).toBe(0);
  // No fixed sync interval: the runtime follows the server, which asks for ten exchanges a second under manual control.
  runtime = spawn("python3", ["-m", "hannah_robot", "run", "--state-dir", stateDir], { cwd: runtimeDir, stdio: ["ignore", "pipe", "pipe"] });
  runtime.stdout?.on("data", (chunk) => { runtimeLog += chunk; });
  runtime.stderr?.on("data", (chunk) => { runtimeLog += chunk; });

  await page.goto("/robotics");
  await expect(page.getByTestId("robot-connection")).toHaveText("Connected", { timeout: 20_000 });
  const safety = page.getByTestId("safety-autonomy");
  await expect(safety.getByTestId("operating-mode")).toHaveText("Mission Autonomy");
  await expect(safety).toContainText("not a certified safety function");

  // The handoff: confirm the robot, take control, and the robot confirms it.
  const teleop = page.getByTestId("teleop");
  await expect(teleop.getByTestId("teleop-start")).toBeDisabled();
  await teleop.getByTestId("teleop-confirm").check();
  await teleop.getByTestId("teleop-start").click();
  await expect(teleop).toHaveAttribute("data-status", "active", { timeout: 20_000 });
  for (const step of ["operator-auth", "robot-identification", "permission", "mode-transition", "mission-handling", "manual-activation", "operator-visibility", "audit"]) {
    await expect(teleop.locator(`[data-step="${step}"]`)).toHaveAttribute("data-ok", "true");
  }
  await expect(safety.getByTestId("operating-mode")).toHaveText("Manual", { timeout: 10_000 });
  await expect(teleop.getByTestId("teleop-video")).toContainText("No camera stream.");

  // While it is held, an autonomous mission is refused by the chain.
  const refused = await page.request.post(`${api}/api/actions`, { data: { action: "robots.navigate_to", params: { robot: "Rescue", place: "workbench" }, request: "e2e" } });
  expect((await refused.json()).record.status).toBe("denied");

  // Drive: Space is the deadman, ArrowUp drives forward. The robot moves.
  const start = await pose(page.request);
  await page.keyboard.down(" ");
  await page.keyboard.down("ArrowUp");
  await expect(teleop.getByTestId("teleop-sending")).toContainText("keyboard");
  await expect(teleop.getByTestId("teleop-applied")).toContainText(/0\.\d\d m\/s/, { timeout: 10_000 });
  await page.waitForTimeout(1500);
  await page.keyboard.up("ArrowUp");
  await page.keyboard.up(" ");
  const moved = await pose(page.request);
  expect(Math.hypot((moved?.x ?? 0) - (start?.x ?? 0), (moved?.y ?? 0) - (start?.y ?? 0)), `${runtimeLog.slice(-2000)}`).toBeGreaterThan(0.1);
  // Let go: nothing more is sent, and the robot holds by itself.
  await expect(teleop.getByTestId("teleop-sending")).toContainText("nothing (deadman released)");
  await expect(teleop.getByTestId("teleop-applied")).toContainText("holding", { timeout: 10_000 });
  await page.waitForTimeout(1000);
  const still = await pose(page.request);
  await page.waitForTimeout(1000);
  const later = await pose(page.request);
  expect(Math.hypot((later?.x ?? 0) - (still?.x ?? 0), (later?.y ?? 0) - (still?.y ?? 0))).toBeLessThan(0.02);

  // End it: the robot stays in Manual, holding. Autonomy comes back only when a person restores it.
  await teleop.getByTestId("teleop-end").click();
  await expect(teleop).toHaveAttribute("data-status", "none", { timeout: 10_000 });
  await expect(safety.getByTestId("operating-mode")).toHaveText("Manual");
  await expect(safety.getByTestId("mode-mission")).toBeDisabled();
  await expect(safety.getByTestId("mode-supervised")).toBeEnabled({ timeout: 10_000 });
  await safety.getByTestId("mode-supervised").click();
  await expect(safety.getByTestId("operating-mode")).toHaveText("Supervised Autonomy", { timeout: 10_000 });
  await expect(safety.getByTestId("mode-confirmed")).toContainText("The robot confirmed this mode.", { timeout: 10_000 });
  await expect(safety.getByTestId("safety-audit")).toContainText("Manual control handed to operator@example.com");
});
