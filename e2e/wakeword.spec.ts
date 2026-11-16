import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Chromium's fake microphone plays this clip (macOS "Samantha" saying "Hey Hannah") in a loop.
const clip = resolve(__dirname, "fixtures", "hey-hannah.wav");
const groqKey = "gsk_e2eWakeWordKey0123456789abcdefghijklmnop";

async function connect(page: Page) {
  await page.route(/\/(api|v1)\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/health") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "ok", provider: "Groq", ready: true }) });
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.addInitScript((key) => sessionStorage.setItem("hannah.session.groqKey", key), groqKey);
}

// A browser whose microphone is the clip (this file's own worker).
test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${clip}`, "--autoplay-policy=no-user-gesture-required"],
  },
});

test.describe("Hey HANNAH", () => {

  test("the wake word is detected on the device and opens a voice turn in chat", async ({ page }) => {
    // The first run builds the 41 MB speech model from the official archive.
    test.setTimeout(300_000);
    expect(existsSync(clip)).toBe(true);
    await connect(page);
    const outside: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      // Nothing but the app's own files (and the model) is fetched to detect the word.
      if (!["127.0.0.1", "localhost"].includes(url.hostname) && !url.protocol.startsWith("blob") && !url.protocol.startsWith("data")) outside.push(url.host);
    });
    await page.goto("/settings");
    await page.getByRole("checkbox", { name: "Listen for “Hey HANNAH”" }).check();
    // Hearing it releases the microphone and opens chat with the mic on.
    await expect(page).toHaveURL(/\/chat$/, { timeout: 240_000 });
    await expect(page.getByRole("button", { name: /stop voice input|stop listening/i }).or(page.getByText(/Listening in|voice input|microphone/i)).first()).toBeVisible({ timeout: 20_000 });
    expect(outside.filter((host) => !/fonts\.(googleapis|gstatic)\.com/.test(host))).toEqual([]);
  });
});
