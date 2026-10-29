import { expect, test, type Page } from "@playwright/test";
import { expectNoCspViolations, recordCspViolations } from "../csp";
import { openDashboard, openSidebar } from "./dashboard";
import { SIGNED_IN_ORIGIN } from "./env";

// Its own project, after the workspace project, because it adds a contract the empty-account
// checks there must not see.

test.beforeEach(async ({ context }) => {
  await context.route(
    (url) => url.origin !== SIGNED_IN_ORIGIN,
    (route) => route.abort("blockedbyclient"),
  );
});

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
}

test("the dashboard and the open upload dialog raise no CSP violations", async ({ page }) => {
  const violations = await recordCspViolations(page);
  await openDashboard(page);
  await openSidebar(page);
  await page.getByRole("button", { name: "Contracts", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Contracts" })).toBeVisible();
  await settle(page);
  expectNoCspViolations(violations, "the dashboard");

  await page.getByRole("button", { name: "New Contract" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Upload Contract" });
  await expect(dialog.getByText("PDF, DOC, DOCX, TXT, or images up to 4 MB")).toBeVisible();
  await settle(page);
  expectNoCspViolations(violations, "the upload dialog");
});

test("a contract page raises no CSP violations", async ({ page }) => {
  const title = `E2E CSP contract ${Date.now()}`;
  const created = await page.request.post("/api/contracts", { data: { title } });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  const violations = await recordCspViolations(page);
  await page.goto(`/contracts/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await settle(page);
  expectNoCspViolations(violations, "a contract page");
});

test("settings raise no CSP violations", async ({ page }) => {
  const violations = await recordCspViolations(page);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(page.getByText("Loading settings...")).toHaveCount(0);
  await expect(page.getByText("Unable to load settings")).toHaveCount(0);
  await settle(page);
  expectNoCspViolations(violations, "settings");
});
