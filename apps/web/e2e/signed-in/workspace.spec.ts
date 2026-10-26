import { expect, test, type Page } from "@playwright/test";
import { openDashboard, openSidebar } from "./dashboard";
import { SIGNED_IN_ORIGIN } from "./env";

// Signed in, the workspace talks only to its own server: block everything else, as the smoke suite
// does, so a new third-party request fails here.
test.beforeEach(async ({ context }) => {
  await context.route(
    (url) => url.origin !== SIGNED_IN_ORIGIN,
    (route) => route.abort("blockedbyclient"),
  );
});

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function openSidebarSection(page: Page, section: "Contracts" | "Projects") {
  await openSidebar(page);
  await page.getByRole("button", { name: section, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: section })).toBeVisible();
}

test("the dashboard opens the signed-in workspace", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  const response = await openDashboard(page);
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(`${SIGNED_IN_ORIGIN}/dashboard`);

  await openSidebar(page);
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Log in" })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("a new account's workspace starts without contracts", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await openDashboard(page);
  await openSidebarSection(page, "Contracts");
  await expect(page.getByRole("heading", { name: "No contracts found" })).toBeVisible();

  const contracts = await page.request.get("/api/contracts");
  expect(contracts.status()).toBe(200);
  expect(pageErrors).toEqual([]);
});

test("a contract uploads through the multipart path, within its 4 MB limit", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  const config = await page.request.get("/api/uploads");
  expect(config.status()).toBe(200);
  expect(await config.json()).toEqual({
    directUpload: null,
    maxFileSizeBytes: 4 * 1024 * 1024,
  });

  await openDashboard(page);
  await openSidebarSection(page, "Contracts");
  await page.getByRole("button", { name: "New Contract" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Upload Contract" });
  await expect(dialog.getByText("PDF, DOC, DOCX, TXT, or images up to 4 MB")).toBeVisible();
  const fileInput = dialog.locator('input[type="file"]');

  await fileInput.setInputFiles({
    name: "e2e-oversize.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(4 * 1024 * 1024 + 1, "a"),
  });
  await dialog.getByRole("button", { name: "Upload Contract" }).click();
  await expect(page.getByText("File too large. Maximum size is 4 MB.")).toBeVisible();

  await fileInput.setInputFiles({
    name: "e2e-lease.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "This lease renews automatically each year unless either party gives sixty days written notice.",
    ),
  });
  await dialog.getByRole("button", { name: "Upload Contract" }).click();
  await expect(page.getByText("Contract uploaded successfully")).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("e2e-lease").first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("a created project is saved to the account", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  const title = `E2E project ${Date.now()}`;

  await openDashboard(page);
  await openSidebarSection(page, "Projects");
  await page.getByRole("button", { name: "New Project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create New Project" });
  await dialog.getByLabel("Project Title *").fill(title);
  await dialog.getByRole("button", { name: "Create Project" }).click();

  // Creating a project opens it; a fresh load proves it came from the database.
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.reload();
  await expect(page.getByText(title).first()).toBeVisible();

  await openDashboard(page);
  await openSidebarSection(page, "Projects");
  await expect(page.getByText(title).first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("the usage API reports the account's unused hourly quota", async ({ page }) => {
  const response = await page.request.get("/api/usage");
  expect(response.status()).toBe(200);

  const { account } = await response.json();
  expect(account.limit).toBeGreaterThan(0);
  expect(account.used).toBe(0);
  expect(account.remaining).toBe(account.limit);
});

test("settings load for the account", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(page.getByText("Usage", { exact: true })).toBeVisible();
  await expect(page.getByText("Unable to load settings")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
