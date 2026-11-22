/**
 * The Devices screen, end to end in a browser against a REAL HANNAH server,
 * the REAL HANNAH Edge hub (hannah-os/runtime) and HANNAH's simulated devices,
 * which speak MQTT and Modbus TCP over real sockets.
 *
 * This is a SIMULATION test. No physical device is involved, and nothing here
 * says anything about any product.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

const here = __dirname;
const serverDir = resolve(here, "../server");
const runtimeDir = resolve(here, "../hannah-os/runtime");
const port = 4000 + Math.floor(Math.random() * 90);
const api = `http://127.0.0.1:${port}`;
const python = spawnSync("python3", ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"]).status === 0;
let server: ChildProcess;
let simulator: ChildProcess | null = null;
let hub: ChildProcess | null = null;
let updateServer: HttpServer | null = null;
let serverLog = "";
let simLog = "";
let hubLog = "";
let stateDir = "";
let sim: { mqtt: { host: string; port: number }; modbus: { host: string; port: number } };
const EMAIL = "homeowner@example.com";

test.describe.configure({ mode: "serial" });
test.skip(!python, "python3 (3.9 or newer) isn't installed, so the hub can't run here");

test.beforeAll(async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "hannah-devices-e2e-")));
  stateDir = join(dataDir, "hub");
  server = spawn(process.execPath, ["index.js"], {
    cwd: serverDir,
    env: { ...process.env, NODE_ENV: "development", PORT: String(port), HOST: "127.0.0.1", DATABASE_URL: `sqlite:${join(dataDir, "hannah.db")}`, HANNAH_VAULT_KEY: "b".repeat(64), HANNAH_RATE_LIMIT_HUB_SYNC_PER_5S: "100000", HANNAH_API_TOKEN: "devices-e2e-token-0123456789-abcdefghijklmnopqrstuvwxyz" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk) => { serverLog += chunk; });
  server.stderr?.on("data", (chunk) => { serverLog += chunk; });
  simulator = spawn("python3", ["-m", "hannah_edge", "simulate", "--mqtt-port", "0", "--modbus-port", "0", "--period", "0.2", "--speed", "8"], { cwd: runtimeDir, stdio: ["pipe", "pipe", "pipe"] });
  simulator.stdout?.on("data", (chunk) => { simLog += chunk; });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const line = simLog.split("\n").find((item) => item.includes('"simulating"'));
    let healthy = false;
    try { healthy = (await fetch(`${api}/api/health`)).ok; } catch { /* not listening yet */ }
    if (line && healthy) { sim = JSON.parse(line); return; }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`The server or the simulator didn't start:\n${serverLog}\n${simLog}`);
});
test.afterAll(() => { hub?.kill(); simulator?.kill("SIGKILL"); updateServer?.close(); server?.kill(); });

async function signedIn(page: Page) {
  await page.route(/\/(api|v1)\//, async (route) => {
    const url = new URL(route.request().url());
    try {
      const response = await route.fetch({ url: `${api}${url.pathname}${url.search}`, timeout: 60_000 });
      await route.fulfill({ response });
    } catch (error) {
      throw new Error(`${String(error)}\nServer log:\n${serverLog}\nHub log:\n${hubLog}`);
    }
  });
  const registered = await page.request.post(`${api}/api/account/register`, { data: { email: EMAIL, password: "correct horse battery" } });
  if (registered.status() !== 200) {
    const login = await page.request.post(`${api}/api/account/login`, { data: { email: EMAIL, password: "correct horse battery" } });
    expect(login.status(), await login.text()).toBe(200);
  }
  await page.addInitScript((address) => {
    localStorage.setItem("hannah.account.v1", JSON.stringify({ email: address, displayName: "" }));
    localStorage.setItem("hannah.onboarding.v1", "complete");
    sessionStorage.setItem("hannah.session.groqKey", "gsk_e2eDevicesKey0123456789abcdefghijk");
  }, EMAIL);
}
function run(args: string[]) {
  return new Promise<{ code: number | null; output: string }>((done) => {
    const child = spawn("python3", ["-m", "hannah_edge", ...args], { cwd: runtimeDir, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => done({ code, output }));
  });
}
function makeUpdateBundle(version: string, omitHub = false): Buffer {
  const script = String.raw`import io, os, re, sys, tarfile
source, version, omit_hub = sys.argv[1:]
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
    for root, dirs, files in os.walk(source):
        dirs[:] = sorted(name for name in dirs if name != "__pycache__")
        for name in sorted(files):
            if not name.endswith(".py") or (omit_hub == "yes" and name == "hub.py"):
                continue
            path = os.path.join(root, name)
            relative = os.path.relpath(path, source).replace(os.sep, "/")
            with open(path, "rb") as handle:
                contents = handle.read()
            if relative == "__init__.py":
                contents = re.sub(rb'__version__\s*=\s*"[^"]+"', b'__version__ = "' + version.encode() + b'"', contents, count=1)
            member = tarfile.TarInfo("hannah_edge/" + relative)
            member.mode = 0o644
            member.size = len(contents)
            archive.addfile(member, io.BytesIO(contents))
sys.stdout.buffer.write(buffer.getvalue())`;
  const result = spawnSync("python3", ["-c", script, join(runtimeDir, "hannah_edge"), version, omitHub ? "yes" : "no"], { encoding: null, maxBuffer: 24 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout?.length) throw new Error(`Couldn't create update fixture: ${result.stderr?.toString() || "no output"}`);
  return result.stdout;
}
const startHub = () => {
  hub = spawn("python3", ["-m", "hannah_edge", "run", "--state-dir", stateDir, "--sync-interval", "0.3", "--tick", "0.15"], { cwd: runtimeDir, stdio: ["ignore", "pipe", "pipe"] });
  hub.stdout?.on("data", (chunk) => { hubLog += chunk; });
  hub.stderr?.on("data", (chunk) => { hubLog += chunk; });
};
const tell = (line: string) => simulator?.stdin?.write(`${line}\n`);
const card = (page: Page, name: string) => page.locator(`[data-testid="device-card"][data-device="${name}"]`);
/** Add a device from the list, let the hub check it, and switch it on. */
async function addFromList(page: Page, profile: string, name: string, settings: Record<string, string>): Promise<Locator> {
  await page.getByRole("button", { name: "Add a device" }).click();
  await page.getByTestId("profile-option").filter({ hasText: profile }).click();
  await page.getByTestId("device-name").fill(name);
  for (const [field, value] of Object.entries(settings)) await page.getByTestId(`setting-${field}`).fill(value);
  await page.getByRole("button", { name: "Add it and check the connection" }).click();
  const device = card(page, name);
  await expect(device.getByTestId("verification")).toHaveAttribute("data-level", "verified", { timeout: 30_000 });
  return device;
}

test("without an account the screen says what an account is for, and what HANNAH is not", async ({ page }) => {
  await page.addInitScript(() => { sessionStorage.setItem("hannah.session.groqKey", "gsk_e2eDevicesKey0123456789abcdefghijk"); localStorage.setItem("hannah.onboarding.v1", "complete"); });
  await page.route(/\/(api|v1)\//, (route) => route.fulfill({ status: 401, json: { error: "Sign in." } }));
  await page.goto("/devices");
  await expect(page.getByRole("heading", { name: "Devices", level: 1 })).toBeVisible();
  await expect(page.getByText(/Sign in to use devices/)).toBeVisible();
  await expect(page.getByRole("note")).toContainText("HANNAH is not a safety system.");
  await expect(page.getByRole("note")).toContainText("Nothing on this screen is safety-certified.");
  await expect(page.getByRole("button", { name: "Add a hub" })).toHaveCount(0);
  // Ten sections fit the header at every desktop width: nothing overlaps the logo or runs off the bar.
  for (const width of [800, 1024, 1280, 1600]) {
    await page.setViewportSize({ width, height: 800 });
    const fits = await page.evaluate(() => {
      const nav = document.querySelector<HTMLElement>('header nav[aria-label="App navigation"]');
      const logo = document.querySelector<HTMLElement>('header a[aria-label="HANNAH home page"]');
      const links = [...(nav?.querySelectorAll("a") || [])].map((link) => link.getBoundingClientRect());
      const bar = nav?.parentElement?.getBoundingClientRect();
      return Boolean(nav && logo && bar) && links.length === 10 && links.every((box) => box.left >= logo!.getBoundingClientRect().right - 1 && box.right <= bar!.right + 1) && links.every((box, index) => index === 0 || box.left >= links[index - 1].right - 1);
    });
    expect(fits, `header at ${width}px`).toBe(true);
    if (process.env.HANNAH_E2E_SHOTS) await page.screenshot({ path: join(process.env.HANNAH_E2E_SHOTS, `header-${width}.png`), clip: { x: 0, y: 0, width, height: 90 } });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const tabs = page.locator('nav[aria-label="App navigation"]:visible');
  await expect(tabs.getByRole("link", { name: /Devices/ })).toBeVisible();
  // One row of ten tabs, not nine and one below.
  expect(new Set(await tabs.getByRole("link").evaluateAll((links) => links.map((link) => Math.round(link.getBoundingClientRect().top)))).size).toBe(1);
  await expect(tabs.getByRole("link")).toHaveCount(10);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.HANNAH_E2E_SHOTS) await page.screenshot({ path: join(process.env.HANNAH_E2E_SHOTS, "devices-phone.png") });
});

test("a hub is added with a one-time code, enrolls, and shows the same key fingerprint it printed", async ({ page }) => {
  await signedIn(page);
  await page.goto("/devices");
  await expect(page.getByText("No devices yet. Add a hub first.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a device" })).toBeDisabled();
  await page.getByLabel("Name for a new hub").fill("Home hub");
  await page.getByRole("button", { name: "Add a hub" }).click();
  const command = (await page.getByTestId("hub-command").innerText()).trim();
  expect(command).toMatch(/^python3 -m hannah_edge enroll --server http:\/\/127\.0\.0\.1:\d+ --code [A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await expect(page.getByTestId("hub-connection")).toHaveText("Waiting to enroll");
  // The hub's side. Nothing here goes through the browser.
  const enrolled = await run(["enroll", "--server", api, "--code", command.split(" ").pop() as string, "--state-dir", stateDir]);
  expect(enrolled.code, enrolled.output).toBe(0);
  const fingerprint = JSON.parse(enrolled.output.trim().split("\n").pop() as string).fingerprint as string;
  startHub();
  await expect(page.getByTestId("hub-connection")).toHaveText("Connected", { timeout: 20_000 });
  await expect(page.getByTestId("hub-fingerprint")).toHaveText(fingerprint);
  await expect(page.getByTestId("hub-card")).toContainText("speaks http, modbus-tcp, mqtt");
  await expect(page.getByTestId("hub-enrollment")).toHaveCount(0);
  await expect(page.getByTestId("devices-overview")).toContainText("1 of 1 connected");
  await expect(page.getByTestId("hardware-inventory")).toContainText("Home hub");
  await page.getByTestId("scan-qr").click();
  await page.getByTestId("qr-manual-entry").fill("https://example.invalid/profile/unknown");
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page.getByTestId("qr-lookup")).toContainText("was not opened as a web address");
  await page.getByTestId("scan-qr").click();
  await page.getByTestId("qr-manual-entry").fill("org.hannah.sim.thermometer");
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page.getByTestId("qr-profile-match")).toContainText("SIM-THERMO");
  await page.getByRole("button", { name: "Use this profile" }).click();
  await expect(page.getByTestId("device-name")).toHaveValue("SIM-THERMO");
  await page.getByRole("button", { name: "Cancel" }).click();
  const addedRobot = await page.evaluate(async () => {
    const response = await fetch("/api/robots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Simulated rover", simulated: true }) });
    return { status: response.status, body: await response.json() };
  });
  expect(addedRobot.status, JSON.stringify(addedRobot.body)).toBe(201);
  await page.reload();
  await expect(page.getByTestId("hardware-inventory")).toContainText("Simulated rover");
  await expect(page.getByTestId("hardware-inventory")).toContainText("SIMULATED");

  await page.getByTestId("look-usb").click();
  await page.getByTestId("usb-submit").click();
  await expect(page.getByTestId("usb-devices")).toContainText(/\d+ devices? listed/);

  // The service result is fixed here so this screen test doesn't depend on
  // whatever mDNS services happen to be present on the developer's network.
  await page.route(/\/api\/hubs\/[^/]+\/discover$/, async (route) => {
    const request = route.request().postDataJSON();
    if (request.kind !== "mdns") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ pending: false, commandId: "test-mdns", discovered: { kind: "mdns", service: "_http._tcp.local", services: [{ name: "Printer._http._tcp.local", address: "192.0.2.40", port: 631 }] } }),
    });
  });
  await page.getByTestId("look-mdns").click();
  await page.getByTestId("mdns-seconds").fill("1");
  await page.getByTestId("mdns-submit").click();
  await expect(page.getByTestId("mdns-services")).toContainText("1 service found.");
  await expect(page.getByTestId("mdns-service-item")).toContainText("192.0.2.40:631");

  let bundle = makeUpdateBundle("0.1.1");
  updateServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": String(bundle.length) });
    response.end(bundle);
  });
  await new Promise<void>((resolve, reject) => {
    updateServer?.once("error", reject);
    updateServer?.listen(0, "127.0.0.1", resolve);
  });
  const address = updateServer.address() as AddressInfo;
  const bundleUrl = `http://127.0.0.1:${address.port}/hannah-edge.tar.gz`;
  const updates = async () => page.evaluate(async () => {
    const response = await fetch("/api/hubs/updates");
    return response.json();
  }) as Promise<{ hubs: Array<{ software: string; updateStatus: { current: string; previous: string | null; pending: unknown; last: { result: string } | null } }> }>;

  await page.getByTestId("hub-updates-toggle").click();
  await page.getByTestId("hub-update-hub").selectOption({ index: 1 });
  await page.getByTestId("hub-update-version").fill("0.1.1");
  await page.getByTestId("hub-update-size").fill(String(bundle.length));
  await page.getByTestId("hub-update-sha").fill(createHash("sha256").update(bundle).digest("hex"));
  await page.getByTestId("hub-update-url").fill(bundleUrl);
  await page.getByTestId("announce-hub-update").click();
  try {
    await expect.poll(async () => (await updates()).hubs[0]?.updateStatus?.last?.result, { timeout: 30_000 }).toBe("confirmed");
  } catch (error) {
    throw new Error(`${String(error)}\nHub log:\n${hubLog}\nServer log:\n${serverLog}`);
  }
  let updateState = (await updates()).hubs[0].updateStatus;
  expect(updateState).toMatchObject({ current: "0.1.1", previous: "0.1.0", pending: null, last: { result: "confirmed" } });
  await expect.poll(async () => (await updates()).hubs[0]?.software, { timeout: 5_000 }).toBe("0.1.1");
  await page.reload();
  await expect(page.getByTestId("hub-card")).toContainText("HANNAH Edge 0.1.1", { timeout: 20_000 });
  await page.getByTestId("hub-updates-toggle").click();
  await page.getByTestId("hub-update-hub").selectOption({ index: 1 });

  // This archive has a matching version and hash but can't import the hub.
  // The update must be refused before the running version is switched.
  bundle = makeUpdateBundle("0.1.2", true);
  await page.getByTestId("hub-update-version").fill("0.1.2");
  await page.getByTestId("hub-update-size").fill(String(bundle.length));
  await page.getByTestId("hub-update-sha").fill(createHash("sha256").update(bundle).digest("hex"));
  await page.getByTestId("hub-update-url").fill(bundleUrl);
  await page.getByTestId("announce-hub-update").click();
  await expect(page.getByText(/failed its check and was not switched on/i)).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await updates()).hubs[0]?.updateStatus?.last?.result, { timeout: 15_000 }).toBe("refused");
  updateState = (await updates()).hubs[0].updateStatus;
  expect(updateState.current).toBe("0.1.1");
  expect(updateState.previous).toBe("0.1.0");
});

test("a device is picked from the list, checked by the hub, switched on, and its readings are live", async ({ page }) => {
  await signedIn(page);
  await page.goto("/devices");
  await page.getByRole("button", { name: "Add a device" }).click();
  // The list says what each profile is: these are simulations, and none is called plug and play.
  await expect(page.getByTestId("profile-option")).toHaveCount(4);
  await expect(page.getByTestId("profile-option").getByTestId("level").filter({ hasText: "Simulation" })).toHaveCount(4);
  await expect(page.getByTestId("device-setup")).not.toContainText("Plug and play");
  await page.getByRole("button", { name: "Cancel" }).click();
  const sensor = await addFromList(page, "Simulated room sensor", "Room sensor", { host: sim.mqtt.host, port: String(sim.mqtt.port) });
  await expect(sensor.getByTestId("check-connection")).toHaveAttribute("data-result", "pass");
  await expect(sensor.getByTestId("check-data:temperature")).toContainText(/Heard: \d+(\.\d+)? °C/);
  await expect(sensor.getByTestId("check-identity")).toHaveAttribute("data-result", "not-checked");
  await expect(sensor.getByTestId("check-identity")).toContainText("gives no way to confirm what the device is");
  await expect(sensor.getByTestId("check-encryption")).toContainText("Not encrypted");
  await expect(sensor.getByTestId("device-connection")).toHaveText("Not switched on");
  await expect(sensor.getByTestId("switch-on")).toContainText("This device has nothing that can be changed.");
  await sensor.getByTestId("activate").click();
  await expect(sensor.getByTestId("device-connection")).toHaveText("Reporting", { timeout: 20_000 });
  await expect(sensor.getByText("SIMULATED DEVICE", { exact: true })).toBeVisible();
  await expect(sensor.getByTestId("value-temperature")).toHaveText(/^\d+(\.\d+)? °C$/);
  await expect(sensor.getByTestId("age-temperature")).toHaveText("live");
  await expect(page.getByTestId("devices-overview")).toContainText("1 reporting of 1 switched on");
});

test("switching a device asks first, and shows done only after the device reported it", async ({ page }) => {
  await signedIn(page);
  await page.goto("/devices");
  const fan = await addFromList(page, "Simulated fan", "Fan", { host: sim.mqtt.host, port: String(sim.mqtt.port) });
  await expect(fan.getByTestId("allow-power")).toBeChecked();
  await fan.getByTestId("activate").click();
  await expect(fan.getByTestId("value-power")).toHaveText("Off", { timeout: 20_000 });
  await expect(fan.getByTestId("age-power")).toHaveText("live");
  await fan.getByTestId("switch-power").click();
  const approval = page.getByTestId("device-approval");
  await expect(approval).toContainText("Set Power on Fan to on");
  await expect(approval).toContainText("SIMULATED DEVICE");
  await expect(approval).toContainText("Reading the value back from the device");
  await expect(fan.getByTestId("value-power")).toHaveText("Off");
  await approval.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("device-outcome")).toContainText("Done and confirmed: Set Power on Fan to on.", { timeout: 20_000 });
  await expect(fan.getByTestId("value-power")).toHaveText("On");
  // A device that ignores the write: the screen says it wasn't confirmed.
  tell("stuck on");
  await page.waitForTimeout(1200);
  await fan.getByTestId("switch-power").click();
  await page.getByTestId("device-approval").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("device-outcome")).toContainText(/not confirmed|couldn't be confirmed|could not be confirmed/i, { timeout: 25_000 });
  await expect(page.getByTestId("device-outcome")).not.toContainText("Done and confirmed");
  await expect(fan.getByTestId("value-power")).toHaveText("On");
  tell("stuck off");
});

test("an automation is built without code, approved once, and then the hub runs it", async ({ page }) => {
  await signedIn(page);
  await page.goto("/devices");
  const fan = card(page, "Fan");
  // Start from a fan that is off.
  await page.waitForTimeout(1200);
  await fan.getByTestId("switch-power").click();
  await page.getByTestId("device-approval").getByRole("button", { name: "Approve" }).click();
  await expect(fan.getByTestId("value-power")).toHaveText("Off", { timeout: 20_000 });
  const builder = page.getByTestId("automation-builder");
  await builder.getByLabel("Name").fill("Cool the room");
  await builder.getByLabel("Device to watch").selectOption({ label: "Room sensor" });
  await builder.getByLabel("Reading to watch").selectOption({ label: "Temperature" });
  await builder.getByLabel("Comparison").selectOption("above");
  await builder.getByLabel("Value to compare with").fill("27");
  await builder.getByLabel("Device to change").selectOption({ label: "Fan" });
  await builder.getByLabel("What to change").selectOption({ label: "Power" });
  await builder.getByLabel("New state").selectOption("on");
  await page.getByTestId("create-automation").click();
  const approval = page.getByTestId("device-approval");
  await expect(approval).toContainText("Create the automation “Cool the room”");
  await expect(approval).toContainText("No AI is involved");
  await expect(page.getByTestId("automation-card")).toHaveCount(0);
  await approval.getByRole("button", { name: "Approve" }).click();
  const rule = page.getByTestId("automation-card");
  await expect(rule).toContainText("When Room sensor temperature > 27: set Fan power to on. When that stops being true: set Fan power to off.", { timeout: 20_000 });
  await expect(rule.getByTestId("automation-status")).toHaveText("Watching", { timeout: 20_000 });
  tell("heat 9");
  await expect(fan.getByTestId("value-power")).toHaveText("On", { timeout: 40_000 });
  await expect(page.getByTestId("device-events")).toContainText("“Cool the room” ran: Fan Power set to on.", { timeout: 15_000 });
  await expect(rule).toContainText("Acted 1 time");
  if (process.env.HANNAH_E2E_SHOTS) { await page.setViewportSize({ width: 1600, height: 1000 }); await page.screenshot({ path: join(process.env.HANNAH_E2E_SHOTS, "devices-screen.png") }); await page.setViewportSize({ width: 1280, height: 720 }); }
  // Pausing leaves the fan as it is.
  await page.getByRole("button", { name: "Pause every automation" }).click();
  await expect(rule.getByTestId("automation-status")).toHaveText("Paused", { timeout: 20_000 });
  tell("heat 0");
  await page.waitForTimeout(3000);
  await expect(fan.getByTestId("value-power")).toHaveText("On");
  await page.getByRole("button", { name: "Resume automations" }).click();
  await expect(fan.getByTestId("value-power")).toHaveText("Off", { timeout: 40_000 });
});

test("a manual is read into values with their page and line, and its proposal is only experimental until the hub connects", async ({ page }) => {
  const require = createRequire(join(serverDir, "index.js"));
  const PDFDocument = require("pdfkit");
  const pages = [
    ["PM-210 Power Meter", "Model: PM-210", "Manufacturer: Northwind Instruments", "WARNING: Disconnect mains power before opening the terminal cover.", "Supply voltage: 100-240 VAC"],
    ["Communication", "The meter supports Modbus TCP on TCP port 502.", "Default slave address: 1"],
    ["Register map", "Input registers (function code 04)", "0 Voltage uint16 R 0.1 V", "1 Active power uint32 R W", "Holding registers (function code 03)", "0 Power limit uint16 RW W"],
  ];
  const pdf = await new Promise<Buffer>((done) => { const doc = new PDFDocument({ autoFirstPage: false }); const chunks: Buffer[] = []; doc.on("data", (chunk: Buffer) => chunks.push(chunk)); doc.on("end", () => done(Buffer.concat(chunks))); for (const lines of pages) { doc.addPage(); for (const line of lines) doc.text(line); } doc.end(); });
  await signedIn(page);
  await page.goto("/devices");
  await page.getByRole("button", { name: "Add a device" }).click();
  await page.getByRole("tab", { name: "Use its manual" }).click();
  const label = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/v9sAAAAASUVORK5CYII=", "base64");
  await page.getByTestId("manual-file").setInputFiles({ name: "panel-label.png", mimeType: "image/png", buffer: label });
  await expect(page.getByTestId("manual-image-source")).toContainText("Source image · image/png · SHA-256");
  await expect(page.getByTestId("manual-summary")).toContainText("0 values found");
  await expect(page.getByTestId("manual-missing")).toContainText("No vision reader is configured for this image");
  await page.getByTestId("manual-file").setInputFiles({ name: "pm210-manual.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(page.getByTestId("manual-summary")).toContainText("Read 3 of 3 pages of pm210-manual.pdf", { timeout: 30_000 });
  const model = page.getByTestId("fact-row").filter({ hasText: "Model" }).first();
  await expect(model).toContainText("PM-210");
  await expect(model).toContainText("Model: PM-210");
  const unit = page.getByTestId("fact-row").filter({ hasText: "Modbus unit number" });
  await expect(unit.locator("td").nth(2)).toHaveText("2");
  await expect(unit).toContainText("Default slave address: 1");
  await expect(page.getByTestId("fact-row").filter({ hasText: "Supply voltage" })).toContainText("For a qualified person to check");
  await expect(page.getByTestId("manual-reader")).toContainText("Everything here was read from the document and is unverified.");
  const proposal = page.getByTestId("manual-proposal");
  await expect(proposal.getByTestId("level")).toHaveText("Experimental");
  await expect(proposal).toContainText("It would change nothing.");
  await expect(proposal).toContainText("Power limit: the manual marks it writable. It is proposed read-only");
  await unit.getByRole("checkbox").check();
  await proposal.getByRole("button", { name: "Keep this description and connect the device" }).click();
  // The values the manual gave are offered as defaults; the address is the person's to enter.
  await expect(page.getByTestId("setting-unit")).toHaveValue("1");
  await page.getByTestId("device-name").fill("Meter");
  await page.getByTestId("setting-host").fill(sim.modbus.host);
  await page.getByTestId("setting-port").fill(String(sim.modbus.port));
  await page.getByRole("button", { name: "Add it and check the connection" }).click();
  const meter = card(page, "Meter");
  await expect(meter.getByTestId("verification")).toHaveAttribute("data-level", "verified", { timeout: 30_000 });
  await expect(meter.getByTestId("check-data:voltage")).toContainText("Heard: 230.4 V");
  await expect(meter.getByTestId("check-encryption")).toContainText("Modbus has none");
  await expect(meter.getByTestId("level")).toHaveText("Experimental");
  await expect(meter.getByText("SIMULATED DEVICE", { exact: true })).toHaveCount(0);
});

test("the Hardware Studio builds a description from a form, and the server says what is missing", async ({ page }) => {
  await signedIn(page);
  await page.goto("/devices");
  const hardwareWrites: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && (/\/api\/actions$/.test(path) || /\/api\/devices\/[^/]+\/set$/.test(path))) hardwareWrites.push(`${request.method()} ${path}`);
  });
  await page.getByRole("button", { name: "Add a device" }).click();
  await page.getByRole("tab", { name: "Describe it yourself" }).click();
  const studio = page.getByTestId("studio");
  await studio.getByLabel("Maker").fill("Acme");
  await studio.getByLabel("Model").fill("Dimmer 2");
  await studio.getByLabel("What kind of device").selectOption("light");
  const point = studio.getByTestId("studio-point").first();
  await point.getByLabel("Name").fill("Brightness");
  await point.getByLabel("HANNAH may change it").check();
  await point.getByLabel("Topic it reports on").fill("home/dimmer/state");
  await point.getByLabel("Topic that changes it").fill("home/+/set");
  await studio.getByRole("button", { name: "Save the description and connect the device" }).click();
  await expect(studio.getByTestId("studio-problems")).toContainText("a writable number needs a range");
  await expect(studio.getByTestId("studio-problems")).toContainText("must be one exact topic");
  await point.getByLabel("Lowest").fill("0");
  await point.getByLabel("Highest").fill("100");
  await point.getByLabel("Topic that changes it").fill("home/dimmer/set");
  const simulation = studio.getByTestId("studio-simulation");
  await simulation.getByLabel("Point to preview").selectOption("brightness");
  await simulation.getByLabel("Preview value").fill("101");
  await simulation.getByRole("button", { name: "Preview change" }).click();
  await expect(simulation.locator("[data-result]")).toHaveAttribute("data-result", "refused");
  await expect(simulation).toContainText(/outside.*0 to 100/);
  expect(hardwareWrites).toEqual([]);
  await simulation.getByLabel("Preview value").fill("42");
  await simulation.getByRole("button", { name: "Preview change" }).click();
  await expect(simulation.locator("[data-result]")).toHaveAttribute("data-result", "preview");
  await expect(simulation).toContainText("Simulation only");
  await expect(simulation).toContainText("Nothing was sent");
  await expect(simulation.getByTestId("studio-simulation-mapping")).toContainText("MQTT topic home/dimmer/set · 42");
  expect(hardwareWrites).toEqual([]);
  await studio.getByRole("button", { name: "Save the description and connect the device" }).click();
  await expect(page.getByTestId("device-setup").getByTestId("level")).toHaveText("Guided setup", { timeout: 15_000 });
  await expect(page.getByTestId("setting-host")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  // What the hub can't speak is said, not hidden.
  await page.getByText("What a hub can speak today, and what it can't").click();
  await expect(page.getByTestId("not-built")).toContainText("zigbee:");
  await expect(page.getByTestId("not-built")).toContainText("opcua:");
  await expect(page.getByTestId("not-built")).toContainText("Not built");
});

test("when the hub goes away, values are marked as last known, not live", async ({ page }) => {
  await signedIn(page);
  await page.goto("/devices");
  const fan = card(page, "Fan");
  await expect(fan.getByTestId("age-power")).toHaveText("live", { timeout: 20_000 });
  hub?.kill();
  await expect(fan.getByTestId("device-connection")).toHaveText("Its hub is offline", { timeout: 45_000 });
  await expect(fan.getByTestId("age-power")).toHaveText(/^last known, \d+ (s|min) ago$/);
  await expect(fan.getByTestId("switch-power")).toBeDisabled();
  await expect(page.getByTestId("hub-connection")).toHaveText("Offline");
});
