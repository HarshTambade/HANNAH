/**
 * The Robots screen, end to end in a browser against a REAL HANNAH server and
 * the REAL HANNAH Robotics Runtime (robotics/runtime) driving HANNAH's
 * built-in kinematic simulator.
 *
 * This is a SIMULATION test. It is not Gazebo and not a physical robot.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const here = __dirname;
const serverDir = resolve(here, "../server");
const runtimeDir = resolve(here, "../robotics/runtime");
const port = 3900 + Math.floor(Math.random() * 90);
const api = `http://127.0.0.1:${port}`;
const python = spawnSync("python3", ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"]).status === 0;
let server: ChildProcess;
let runtime: ChildProcess | null = null;
let second: ChildProcess | null = null;
let serverLog = "";
let runtimeLog = "";
let stateDir = "";
const EMAIL = "roboticist@example.com";

test.describe.configure({ mode: "serial" });
test.skip(!python, "python3 (3.9 or newer) isn't installed, so the robot runtime can't run here");

test.beforeAll(async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "hannah-robotics-e2e-")));
  stateDir = join(dataDir, "robot");
  server = spawn(process.execPath, ["index.js"], {
    cwd: serverDir,
    env: { ...process.env, NODE_ENV: "development", PORT: String(port), HOST: "127.0.0.1", DATABASE_URL: `sqlite:${join(dataDir, "hannah.db")}`, HANNAH_VAULT_KEY: "a".repeat(64), HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S: "100000", VERCEL: "" },
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
test.afterAll(() => { runtime?.kill(); second?.kill(); server?.kill(); });

async function signedIn(page: Page) {
  await page.route(/\/(api|v1)\//, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${api}${url.pathname}${url.search}`, timeout: 60_000 });
    await route.fulfill({ response });
  });
  const registered = await page.request.post(`${api}/api/account/register`, { data: { email: EMAIL, password: "correct horse battery" } });
  if (registered.status() !== 200) {
    const login = await page.request.post(`${api}/api/account/login`, { data: { email: EMAIL, password: "correct horse battery" } });
    expect(login.status(), await login.text()).toBe(200);
  }
  await page.addInitScript((address) => {
    localStorage.setItem("hannah.account.v1", JSON.stringify({ email: address, displayName: "" }));
    localStorage.setItem("hannah.onboarding.v1", "complete");
    sessionStorage.setItem("hannah.session.groqKey", "gsk_e2eRoboticsKey0123456789abcdefghij");
  }, EMAIL);
}
function run(args: string[]) {
  return new Promise<{ code: number | null; output: string }>((done) => {
    const child = spawn("python3", ["-m", "hannah_robot", ...args], { cwd: runtimeDir, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => done({ code, output }));
  });
}
const simulatorInput = (value: Record<string, unknown>) => writeFileSync(join(stateDir, "sim-inputs.json"), JSON.stringify(value));
const detail = (page: Page) => page.getByTestId("robot-detail");
/** Ask for a trip to a named place and approve it on the card. */
async function driveTo(page: Page, place: string) {
  await page.getByLabel("Place to drive to").selectOption(place);
  await page.getByTestId("go-place").click();
  const approval = page.getByTestId("robot-approval");
  await expect(approval).toContainText(`Start a mission: Rover drives to ${place}`);
  return approval;
}

test("without an account the screen says what an account is for, and what Stop is not", async ({ page }) => {
  await page.addInitScript(() => { sessionStorage.setItem("hannah.session.groqKey", "gsk_e2eRoboticsKey0123456789abcdefghij"); localStorage.setItem("hannah.onboarding.v1", "complete"); });
  await page.route(/\/(api|v1)\//, (route) => route.fulfill({ status: 401, json: { error: "Sign in." } }));
  await page.goto("/robotics");
  await expect(page.getByRole("heading", { name: "Robots", level: 1 })).toBeVisible();
  await expect(page.getByText(/Sign in to use robots/)).toBeVisible();
  await expect(page.getByRole("note")).toContainText("Stop is not an emergency stop.");
  await expect(page.getByRole("note")).toContainText("HANNAH is not safety-certified");
  await expect(page.getByRole("button", { name: "Add a robot" })).toHaveCount(0);
  // On a phone the tab bar has nine sections: Robots is reachable and the page doesn't scroll sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('nav[aria-label="App navigation"]:visible').getByRole("link", { name: /Robots/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.HANNAH_E2E_SHOTS) await page.screenshot({ path: join(process.env.HANNAH_E2E_SHOTS, "robotics-phone.png") });
});

test("a robot is added with a one-time code, its runtime enrolls, and it shows as a connected SIMULATION", async ({ page }) => {
  await signedIn(page);
  await page.goto("/robotics");
  await expect(page.getByText("No robots yet.")).toBeVisible();
  await page.getByRole("button", { name: "Add a robot" }).click();
  await page.getByLabel("Name").fill("Rover");
  await expect(page.getByLabel("A simulated robot")).toBeChecked();
  await page.getByRole("button", { name: "Create and get a code" }).click();
  const code = (await page.getByTestId("enrollment-code").innerText()).trim();
  expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  await expect(page.getByTestId("enrollment")).toContainText("python3 -m hannah_robot enroll --server");
  await expect(page.getByTestId("enrollment")).toContainText("It is not Gazebo.");
  await expect(detail(page).getByTestId("robot-connection")).toHaveText("Waiting for its runtime to enroll");
  await expect(detail(page).getByTestId("stop-robot")).toHaveCount(0);

  // The robot's side: enroll with the code, then run. Nothing here goes through the browser.
  const enrolled = await run(["enroll", "--server", api, "--code", code, "--state-dir", stateDir]);
  expect(enrolled.code, enrolled.output).toBe(0);
  runtime = spawn("python3", ["-m", "hannah_robot", "run", "--state-dir", stateDir, "--sim-speed", "8", "--sync-interval", "0.2"], { cwd: runtimeDir, stdio: ["ignore", "pipe", "pipe"] });
  runtime.stdout?.on("data", (chunk) => { runtimeLog += chunk; });
  runtime.stderr?.on("data", (chunk) => { runtimeLog += chunk; });

  await expect(detail(page).getByTestId("robot-connection")).toHaveText("Connected", { timeout: 20_000 });
  await expect(detail(page).getByTestId("robot-kind")).toHaveText("SIMULATION · HANNAH's built-in simulator (not Gazebo)");
  await expect(page.getByTestId("enrollment")).toHaveCount(0);
  await expect(page.getByTestId("robot-map")).toBeVisible();
  await expect(page.getByTestId("robot-pose")).toContainText("Reported position (-4.30, -3.30) m, from odometry");
  await expect(page.getByTestId("robot-pose")).toContainText("The simulator's ground truth differs by 0.00 m.");
  await expect(detail(page).getByText("HANNAH's built-in 2-D kinematic simulator", { exact: false })).toHaveCount(0);
  // What it registered, and the rules that can't be changed.
  await expect(page.getByTestId("capability")).toHaveCount(8);
  await expect(page.locator('[data-capability="stop_motion"]')).toContainText("Never needs approval and can't be switched off.");
  await expect(page.locator('[data-capability="navigate_to"]')).toContainText("Confirmed when the robot's reported position is within the tolerance of the goal");
  await expect(detail(page).getByText("Simulated emergency-stop input. Not a safety device.")).toBeVisible();
  await expect(detail(page).getByText("kinematic adapter", { exact: false })).toBeVisible();
});

test("a trip is asked for, approved on the card, driven by the simulator and shown as verified only when it is", async ({ page }, testInfo) => {
  await signedIn(page);
  await page.goto("/robotics");
  await expect(detail(page).getByTestId("robot-connection")).toHaveText("Connected", { timeout: 20_000 });
  const approval = await driveTo(page, "workbench");
  await expect(approval).toContainText("Rover — SIMULATION (hannah-kinematic)");
  await expect(approval).toContainText("If the link drops");
  await expect(page.getByTestId("mission-row")).toHaveCount(0);
  await approval.getByRole("button", { name: "Approve and start" }).click();
  // What the approval led to replaces "waiting for your approval": the robot accepted it, which is a start, not an arrival.
  await expect(page.getByTestId("robot-outcome")).toContainText(/Done and confirmed: Start a mission: Rover drives to workbench.*This confirms the start, not the result/, { timeout: 15_000 });
  // Running: said as running, never as arrived.
  const row = page.getByTestId("mission-row").first();
  await expect(row).toHaveAttribute("data-status", "accepted", { timeout: 15_000 });
  await expect(page.getByTestId("active-mission")).toContainText("It is not finished.");
  await expect(detail(page).getByTestId("robot-mode")).toHaveText("Driving");
  await testInfo.attach("driving", { body: await page.screenshot({ fullPage: true, ...(process.env.HANNAH_E2E_SHOTS ? { path: join(process.env.HANNAH_E2E_SHOTS, "robotics-driving.png") } : {}) }), contentType: "image/png" });
  // Finished and checked against the robot's reported position.
  await expect(row).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
  await expect(row).toContainText("Finished, verified");
  await expect(row).toContainText(/from the goal \(3\.1, 1\.9\), standing still\. Simulator ground truth: 0\.\d+ m from the goal\./);
  await expect(page.getByTestId("active-mission")).toHaveCount(0);
  await expect(page.getByTestId("robot-pose")).toContainText(/Reported position \(3\.\d\d, 1\.\d\d\) m/);
  // An impossible goal is refused with the reason and never shown for approval.
  await page.getByTestId("robot-map").click({ position: { x: 4, y: 4 } });
  await page.getByRole("button", { name: /Ask to drive to \(/ }).click();
  await expect(page.getByTestId("robot-outcome")).toContainText(/Not allowed: .*(outside the robot's allowed workspace|keep-out zone)/);
  await expect(page.getByTestId("robot-approval")).toHaveCount(0);
});

test("Stop needs no approval and is confirmed by measured speed; an emergency stop blocks movement until released at the robot", async ({ page }) => {
  await signedIn(page);
  await page.goto("/robotics");
  await expect(detail(page).getByTestId("robot-connection")).toHaveText("Connected", { timeout: 20_000 });
  const approval = await driveTo(page, "dock");
  await approval.getByRole("button", { name: "Approve and start" }).click();
  await expect(detail(page).getByTestId("robot-mode")).toHaveText("Driving", { timeout: 15_000 });
  await page.getByTestId("stop-robot").click();
  await expect(page.getByTestId("robot-outcome")).toContainText(/Done and confirmed: Stop Rover\. The robot's measured speed is 0 m\/s/, { timeout: 20_000 });
  await expect(page.locator('[data-testid="mission-row"][data-status="cancelled"]').first()).toBeVisible();
  await expect(page.getByTestId("robot-approval")).toHaveCount(0);

  simulatorInput({ estop: true });
  await expect(detail(page).getByRole("alert").filter({ hasText: "The emergency stop is engaged. It has to be released at the robot; HANNAH can't release it." })).toBeVisible({ timeout: 15_000 });
  await expect(detail(page).getByTestId("robot-mode")).toHaveText("Emergency stop engaged");
  await page.getByLabel("Place to drive to").selectOption("door");
  await page.getByTestId("go-place").click();
  await expect(page.getByTestId("robot-outcome")).toContainText("Rover's emergency stop is engaged. It has to be released at the robot.");
  await expect(page.getByTestId("robot-approval")).toHaveCount(0);
  simulatorInput({ estop: false });
  await expect(detail(page).getByTestId("robot-mode")).not.toHaveText("Emergency stop engaged", { timeout: 15_000 });
});

test("a mission is paused and resumed from the screen; resuming asks, because it moves the robot again", async ({ page }) => {
  await signedIn(page);
  await page.goto("/robotics");
  await expect(detail(page).getByTestId("robot-connection")).toHaveText("Connected", { timeout: 20_000 });
  const approval = await driveTo(page, "loading bay");
  await approval.getByRole("button", { name: "Approve and start" }).click();
  await expect(detail(page).getByTestId("robot-mode")).toHaveText("Driving", { timeout: 15_000 });
  await page.getByTestId("pause-mission").click();
  await expect(page.getByTestId("robot-outcome")).toContainText(/Done and confirmed: Pause Rover's mission “Drive to a place”.*holding where it is and keeps the mission/, { timeout: 15_000 });
  await expect(detail(page).getByTestId("robot-mode")).toHaveText("Paused");
  await expect(page.locator('[data-testid="mission-row"][data-status="paused"]')).toHaveCount(1);
  await expect(page.getByTestId("robot-approval")).toHaveCount(0);
  await page.getByTestId("resume-mission").click();
  const resume = page.getByTestId("robot-approval");
  await expect(resume).toContainText("Resume: Rover carries on with “Drive to a place”");
  await expect(resume).toContainText("The resume is valid for 20 seconds and works once.");
  await resume.getByRole("button", { name: "Approve and start" }).click();
  await expect(page.locator('[data-testid="mission-row"]').first()).toHaveAttribute("data-status", "succeeded", { timeout: 40_000 });
});

test("destinations are added from the map and checked; what the robot senses and its condition come from its reports", async ({ page }) => {
  await signedIn(page);
  await page.goto("/robotics");
  await expect(detail(page).getByTestId("robot-connection")).toHaveText("Connected", { timeout: 20_000 });
  const destinations = page.getByTestId("destinations");
  await expect(destinations).toContainText("map: workcell");
  await expect(destinations.getByTestId("destination")).toHaveCount(5);
  await expect(destinations).toContainText("reported by the simulator");
  // A point in the keep-out corner is refused with the reason; a point on open floor is accepted.
  const map = page.getByTestId("robot-map");
  const box = (await map.boundingBox())!;
  await map.click({ position: { x: box.width * 0.04, y: box.height * 0.06 } });
  await destinations.getByPlaceholder("Name, for example Kitchen").fill("Cabinet");
  await destinations.getByRole("button", { name: /^Add at/ }).click();
  await expect(destinations.getByRole("alert")).toContainText("keep-out zone “charging cabinet”");
  await map.click({ position: { x: box.width * 0.5, y: box.height * 0.72 } });
  await destinations.getByPlaceholder("Name, for example Kitchen").fill("Bay 2");
  await destinations.getByRole("button", { name: /^Add at/ }).click();
  await expect(destinations.getByTestId("destination").filter({ hasText: "Bay 2" })).toContainText("defined by you");
  await expect(page.getByLabel("Place to drive to").locator("option", { hasText: "Bay 2" })).toHaveCount(1);

  // Something the map doesn't have, straight ahead of the robot: reported as a measurement, with its sensor and confidence.
  const surroundings = page.getByTestId("surroundings");
  await expect(surroundings).toContainText("Nothing detected that isn't on its map.");
  // Put down a metre away in the most open direction the robot's own scan shows.
  const now = await page.evaluate(async () => (await (await fetch("/api/robots")).json()).robots[0].state);
  const ranges: number[] = now.sensors.lidar.ranges;
  const direction = now.pose.yaw + (2 * Math.PI * ranges.indexOf(Math.max(...ranges))) / ranges.length;
  simulatorInput({ obstacles: [{ name: "crate", x: now.pose.x + Math.cos(direction) * 1.2 - 0.2, y: now.pose.y + Math.sin(direction) * 1.2 - 0.2, w: 0.4, h: 0.4 }] });
  await expect(surroundings.getByTestId("detected-object").first()).toContainText(/An object that isn't on the map, \d\.\d\d m away .* returns from the lidar; confidence 0\.\d\d\./, { timeout: 15_000 });
  simulatorInput({ obstacles: [], sensorFaults: ["lidar"] });
  await expect(surroundings.getByRole("alert")).toContainText("The range sensor isn't reporting. What is around the robot is unknown, and it won't be moved.", { timeout: 15_000 });
  const condition = page.getByTestId("diagnostics");
  await expect(condition.locator('[data-testid="finding"][data-severity="error"]')).toContainText("Sensor not reporting: lidar", { timeout: 15_000 });
  await expect(condition).toContainText("needs attention now");
  simulatorInput({ obstacles: [], sensorFaults: [] });
  await expect(condition).toContainText("no problem found in what it reports", { timeout: 15_000 });
  await expect(condition).toContainText("No model was asked to judge its condition.");
  await condition.getByLabel("Maintenance note").fill("Lidar connector reseated.");
  await condition.getByRole("button", { name: "Add entry" }).click();
  await expect(condition).toContainText("inspection · Lidar connector reseated.");
  await expect(page.getByTestId("robot-fingerprint")).toHaveText(/^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
});

test("with two robots the fleet view says which can take a task, chooses one and shows why before asking", async ({ page }) => {
  await signedIn(page);
  await page.goto("/robotics");
  await expect(detail(page).getByTestId("robot-connection")).toHaveText("Connected", { timeout: 20_000 });
  await expect(page.getByTestId("fleet")).toHaveCount(0);
  // A second simulated robot, enrolled through the API and its own runtime process.
  const created = await page.request.post(`${api}/api/robots`, { data: { name: "Tug", simulated: true } });
  expect(created.status(), await created.text()).toBe(201);
  const tugDir = join(stateDir, "..", "tug");
  const enrolled = await run(["enroll", "--server", api, "--code", (await created.json()).enrollment.code, "--state-dir", tugDir]);
  expect(enrolled.code, enrolled.output).toBe(0);
  second = spawn("python3", ["-m", "hannah_robot", "run", "--state-dir", tugDir, "--sim-speed", "8", "--sync-interval", "0.2"], { cwd: runtimeDir, stdio: ["ignore", "ignore", "ignore"] });
  const fleet = page.getByTestId("fleet");
  await expect(fleet.getByTestId("fleet-row")).toHaveCount(2, { timeout: 20_000 });
  await expect(fleet.locator('[data-testid="fleet-row"][data-available="true"]')).toHaveCount(2, { timeout: 20_000 });
  // Tug is in the dock; Rover is far from it. The dock-side shelves go to Tug.
  await fleet.getByLabel("Destination for the fleet").selectOption("shelves");
  await fleet.getByTestId("fleet-assign").click();
  await expect(page.getByTestId("fleet-outcome")).toContainText(/Waiting for your approval: Start a mission: (Tug|Rover) drives to shelves/, { timeout: 15_000 });
  const approval = page.getByTestId("robot-approval");
  await expect(approval).toContainText(/Chosen(Tug|Rover): the nearest of 2 that can take it \(\d+(\.\d+)? m away\)/);
  await expect(approval).toContainText(/Not chosen(Tug|Rover) \(\d+(\.\d+)? m away\)/);
  await approval.getByRole("button", { name: "Approve and start" }).click();
  await expect(fleet.locator('[data-testid="fleet-row"][data-available="false"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(fleet).toContainText("Drive to a place (accepted)");
  await expect(page.locator('[data-testid="mission-row"]').first()).toHaveAttribute("data-status", "succeeded", { timeout: 40_000 });
  second?.kill("SIGKILL");
  second = null;
});

test("when the robot's runtime is gone the screen says offline and marks what it shows as old", async ({ page }) => {
  await signedIn(page);
  await page.goto("/robotics");
  await expect(detail(page).getByTestId("robot-connection")).toHaveText("Connected", { timeout: 20_000 });
  await page.getByTestId("robot-card").filter({ hasText: "Rover" }).click();
  await expect(detail(page).getByRole("heading", { name: "Rover" })).toBeVisible();
  runtime?.kill("SIGKILL");
  runtime = null;
  await expect(detail(page).getByTestId("robot-connection")).toHaveText("Offline", { timeout: 30_000 });
  await expect(detail(page).getByRole("status").filter({ hasText: /What you see below is that last report, not where it is now\. A robot that loses its link stops by itself within 5 seconds\./ })).toBeVisible();
  await expect(detail(page).getByText("last report, not current").first()).toBeVisible();
  await page.getByLabel("Place to drive to").selectOption("door");
  await page.getByTestId("go-place").click();
  await expect(page.getByTestId("robot-outcome")).toContainText(/it is offline/);
  // The Actions screen has the same history, under the Robots service.
  await page.goto("/actions");
  await expect(page.getByTestId("action-card").filter({ hasText: "Stop Rover" }).first()).toBeVisible();
});
