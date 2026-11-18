// Phone Bridge on a real Android app, end to end (manual: needs an emulator or device).
//
// The Android app is the phone; this script is the computer, signed in to the
// same account over HTTP. It pairs through the app's own Settings → Phone
// screen, then checks with adb that the dialer and Messages really open with
// the number and text, that no call is placed, and that revoking works.
//
// Setup (see docs/DEVICE_INTELLIGENCE.md, section 5):
//   1. A HANNAH server on port 3311 with a database: DATABASE_URL=sqlite:/tmp/h.db PORT=3311 node server/index.js
//   2. A debug build pointed at it: VITE_API_BASE_URL=http://localhost:3311 npm run build (client), npx cap sync android,
//      ./gradlew assembleDebug (JDK 17+), adb install -r -g app/build/outputs/apk/debug/app-debug.apk
//      (debug builds allow HTTP to localhost only: android/app/src/debug)
//   3. node scripts/phone-bridge-android-e2e.mjs "$PWD" /tmp/phone-e2e-out
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const [repo, out] = process.argv.slice(2);
const require = createRequire(`${repo}/client/package.json`);
const adb = (...args) => execFileSync(`${process.env.HOME}/Library/Android/sdk/platform-tools/adb`, args, { encoding: "utf8" });
const api = "http://127.0.0.1:3311/api";
const pkg = "com.hannah.companion";
const step = (text) => console.log(`\n▶ ${text}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

// The computer: one account, cookie session.
const email = `phone-e2e-${Date.now()}@example.com`;
const register = await fetch(`${api}/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery" }) });
const cookie = register.headers.get("set-cookie").split(";")[0];
const computer = async (method, path, body) => {
  const response = await fetch(`${api}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
// The phone signs in to the SAME account with a bearer session, as the app does.
const login = await (await fetch(`${api}/account/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-HANNAH-Session": "bearer" }, body: JSON.stringify({ email, password: "correct horse battery" }) })).json();

step("Install and open the app");
adb("reverse", "tcp:3311", "tcp:3311");
adb("shell", "pm", "grant", pkg, "android.permission.READ_CONTACTS");
adb("shell", "am", "force-stop", pkg);
adb("shell", "am", "start", "-n", `${pkg}/.MainActivity`);
await wait(6000);
const { _android: android } = require("playwright");
const [device] = await android.devices();
const webview = await device.webView({ pkg }, { timeout: 30_000 });
const page = await webview.page();
const browser = { close: async () => device.close() };
console.log("WebView at", page.url());

step("Sign the phone in and open Settings → Phone");
await page.evaluate(({ email, token }) => {
  localStorage.setItem("hannah.account.v1", JSON.stringify({ email, displayName: "", sessionToken: token }));
  localStorage.setItem("hannah.onboarding.v1", "complete");
}, { email, token: login.sessionToken });
await page.goto(new URL("/settings", page.url()).toString());
await page.getByText("Phone", { exact: true }).first().waitFor({ timeout: 20_000 });
await page.getByLabel("Pairing code").scrollIntoViewIfNeeded();

step("Pair: the computer makes a code; the phone types it");
const code = (await computer("POST", "/phone/pairing", { deviceName: "Test MacBook" })).body.code;
await page.getByLabel("Pairing code").fill(code);
await page.getByLabel("This phone's name").fill("Emulator Pixel");
await page.getByLabel("Find contacts by name").check();
await page.getByRole("button", { name: "Pair this phone" }).click();
try {
  await page.getByText("Paired with your account").waitFor({ timeout: 20_000 });
} catch (error) {
  await page.screenshot({ path: `${out}/pair-failed.png` });
  console.log("ALERTS:", await page.getByRole("alert").allInnerTexts().catch(() => []));
  throw error;
}
const phoneFingerprint = (await page.getByLabel("Pairing fingerprint").innerText()).trim();
const status = await computer("POST", "/phone/pairing/status", { code });
check("pairing completes and both sides show the same key fingerprint", status.body.paired && status.body.phone.fingerprint === phoneFingerprint, phoneFingerprint);
await page.screenshot({ path: `${out}/phone-paired.png` });
await wait(4000);
const phones = (await computer("GET", "/phone/devices")).body.phones;
check("the computer sees the phone online with what it allowed", phones[0]?.online === true && phones[0].capabilities.join(",") === "call,sms,contacts", JSON.stringify(phones[0]?.capabilities));

step("Contact lookup on the phone");
adb("shell", "content", "insert", "--uri", "content://com.android.contacts/raw_contacts", "--bind", "account_type:n:", "--bind", "account_name:n:");
const rawId = adb("shell", "content", "query", "--uri", "content://com.android.contacts/raw_contacts", "--projection", "_id").trim().split("\n").map((line) => Number(/_id=(\d+)/.exec(line)?.[1])).filter(Boolean).sort((a, b) => b - a)[0];
adb("shell", "content", "insert", "--uri", "content://com.android.contacts/data", "--bind", `raw_contact_id:i:${rawId}`, "--bind", "mimetype:s:vnd.android.cursor.item/name", "--bind", "data1:s:Aman\\ Bridgetest");
adb("shell", "content", "insert", "--uri", "content://com.android.contacts/data", "--bind", `raw_contact_id:i:${rawId}`, "--bind", "mimetype:s:vnd.android.cursor.item/phone_v2", "--bind", "data1:s:+919876543210", "--bind", "data2:i:2");
const lookup = (await computer("POST", "/phone/commands", { action: "lookup", query: "Bridgetest", deviceName: "Test MacBook" })).body.command;
let found;
for (let i = 0; i < 20 && !["resolved", "failed", "declined"].includes(found?.status); i += 1) { await wait(1000); found = (await computer("GET", `/phone/commands/${lookup.id}`)).body.command; }
check("the phone found the contact and sent back only the match", found?.status === "resolved" && found.result.matches.length === 1 && found.result.matches[0].name === "Aman Bridgetest", JSON.stringify(found?.result));

step("Call: the phone's dialer opens with the number");
const call = (await computer("POST", "/phone/commands", { action: "call", number: found.result.matches[0].numbers[0].number, name: "Aman Bridgetest", deviceName: "Test MacBook" })).body.command;
let called;
for (let i = 0; i < 20 && !["dialer-opened", "failed", "declined"].includes(called?.status); i += 1) { await wait(1000); called = (await computer("GET", `/phone/commands/${call.id}`)).body.command; }
await wait(1500);
const resumed = adb("shell", "dumpsys", "activity", "activities").split("\n").find((line) => /topResumedActivity|mResumedActivity/.test(line)) || "";
adb("shell", "screencap", "-p", "/sdcard/dialer.png");
execFileSync(`${process.env.HOME}/Library/Android/sdk/platform-tools/adb`, ["pull", "/sdcard/dialer.png", `${out}/dialer.png`]);
const dialerUi = adb("exec-out", "uiautomator", "dump", "/dev/tty");
check("the phone reported dialer-opened", called?.status === "dialer-opened", called?.status);
check("the dialer is on screen", /dialer/i.test(resumed), resumed.trim());
check("the dialer shows the number", dialerUi.replace(/[\s()\u2011\u00a0-]/g, "").includes("9876543210"));
writeFileSync(`${out}/dialer-ui.xml`, dialerUi);
const inCall = adb("shell", "dumpsys", "telecom").includes("state=ACTIVE");
check("no call was placed by HANNAH", !inCall);

step("SMS: back to HANNAH, then Messages opens with recipient and text");
adb("shell", "input", "keyevent", "KEYCODE_HOME");
adb("shell", "am", "start", "-n", `${pkg}/.MainActivity`);
await wait(4000);
const sms = (await computer("POST", "/phone/commands", { action: "sms", number: "+919876543210", name: "Aman Bridgetest", body: "Reaching in 20 minutes", deviceName: "Test MacBook" })).body.command;
let texted;
for (let i = 0; i < 20 && !["composer-opened", "failed", "declined"].includes(texted?.status); i += 1) { await wait(1000); texted = (await computer("GET", `/phone/commands/${sms.id}`)).body.command; }
await wait(2500);
const smsResumed = adb("shell", "dumpsys", "activity", "activities").split("\n").find((line) => /topResumedActivity|mResumedActivity/.test(line)) || "";
const smsUi = adb("exec-out", "uiautomator", "dump", "/dev/tty");
writeFileSync(`${out}/sms-ui.xml`, smsUi);
adb("shell", "screencap", "-p", "/sdcard/sms.png");
execFileSync(`${process.env.HOME}/Library/Android/sdk/platform-tools/adb`, ["pull", "/sdcard/sms.png", `${out}/sms.png`]);
check("the phone reported composer-opened", texted?.status === "composer-opened", texted?.status);
check("the messaging app is on screen", /messaging|mms|sms/i.test(smsResumed), smsResumed.trim());
check("the message text is filled in, waiting for Send", smsUi.includes("Reaching in 20 minutes"));

step("Revoke from the computer: the phone stops");
adb("shell", "input", "keyevent", "KEYCODE_HOME");
adb("shell", "am", "start", "-n", `${pkg}/.MainActivity`);
await wait(3000);
await computer("DELETE", `/phone/devices/${phones[0].id}`);
await wait(5000);
const unpaired = await page.getByRole("button", { name: "Pair this phone" }).isVisible().catch(() => false);
check("after revocation the phone clears its pairing and shows the pair form", unpaired);
const afterRevoke = await computer("POST", "/phone/commands", { action: "call", number: "+919876543210" });
check("the computer can't reach a revoked phone", afterRevoke.status === 409, String(afterRevoke.status));

await browser.close();
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
