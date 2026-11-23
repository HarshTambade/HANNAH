/**
 * Robot OS admin screen, browser-level test with mocked API responses.
 * This checks the UI wiring and confirmation flow; it is not a hardware or
 * server integration test.
 */
import { expect, test, type Page } from "@playwright/test";

const EMAIL = "robot-os-admin@example.com";

const envelopes = [
  {
    envelopeId: "env_1",
    robotId: "robot-dev",
    kind: "event",
    tsMs: 1_700_000_000_000,
    receivedAt: 1_700_000_000_100,
    hasSignature: true,
    payload: { type: "motor_fault", detail: "overcurrent" },
  },
  {
    envelopeId: "env_2",
    robotId: "robot-dev",
    kind: "telemetry",
    tsMs: 1_700_000_010_000,
    receivedAt: 1_700_000_010_100,
    hasSignature: true,
    payload: { cpu: 0.2 },
  },
];

async function mockApi(page: Page) {
  await page.addInitScript((email) => {
    localStorage.setItem("hannah.account.v1", JSON.stringify({ email, displayName: "Robot OS admin" }));
    localStorage.setItem("hannah.onboarding.v1", "complete");
    sessionStorage.setItem("hannah.session.groqKey", "gsk_robotOSKey0123456789abcdefghijklmnopqrstuvwxyz");
  }, EMAIL);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/api/robots/os/envelopes")) {
      return route.fulfill({ json: { envelopes } });
    }
    if (path.endsWith("/api/robots/os/commands")) {
      return route.fulfill({
        json: {
          commands: [
            {
              id: "rosc_1",
              robotId: "robot-dev",
              capability: "update.stage",
              status: "acked",
              ackReason: "applied",
              issuedAt: 1_700_000_020_000,
              expiresAt: 1_700_000_122_000,
            },
          ],
        },
      });
    }
    if (path.endsWith("/api/actions") && route.request().method() === "POST") {
      return route.fulfill({ json: { record: { id: "act_1", status: "waiting-approval" } } });
    }
    if (path.endsWith("/api/robots")) return route.fulfill({ json: { robots: [] } });
    if (path.endsWith("/api/inventory")) return route.fulfill({ json: { robots: [], hubs: [], devices: [] } });
    if (path.endsWith("/api/account/status")) return route.fulfill({ json: { configured: true } });
    return route.fulfill({ json: { ok: true } });
  });
}

test("Robot OS screen shows signed reports and guards admin actions", async ({ page }) => {
  await mockApi(page);
  await page.goto("/robot-os");
  await expect(page.getByRole("heading", { name: "HANNAH Robot OS" })).toBeVisible();
  await expect(page.getByText("motor_fault")).toBeVisible();
  await expect(page.getByText("Fault events")).toBeVisible();
  await expect(page.getByText("Command audit")).toBeVisible();
  await expect(page.getByText("update.stage")).toBeVisible();

  // The action is created only after an explicit confirmation dialog.
  await page.getByLabel("robot", { exact: true }).first().fill("robot-dev");
  await page.getByLabel("version", { exact: true }).fill("0.2.0");
  await page.getByRole("button", { name: "Review update" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("pre")).toContainText("0.2.0");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // Confirming creates an action; the UI never claims the robot applied it.
  await page.getByRole("button", { name: "Review update" }).click();
  await page.getByRole("button", { name: "Create action" }).click();
  await expect(page.getByText(/signed-in person must approve/)).toBeVisible();
});
