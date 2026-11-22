import { expect, type Page } from "@playwright/test";

// Opens the dashboard and waits for React to hydrate it. The server renders the sidebar button,
// but a click that lands before hydration does nothing. The chat composer is enabled only by
// client effects (the stored privacy acknowledgement), so an enabled composer means it is ready.
export async function openDashboard(page: Page) {
  const response = await page.goto("/dashboard");
  await expect(page.getByRole("textbox", { name: "Chat message" })).toBeEnabled();
  return response;
}

export async function openSidebar(page: Page) {
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
}

// Uploads a text contract through the dashboard's upload dialog and returns the new contract's id.
export async function uploadThroughDashboard(page: Page, title: string, contents: string): Promise<string> {
  await openDashboard(page);
  await openSidebar(page);
  await page.getByRole("button", { name: "Contracts", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Contracts" })).toBeVisible();
  await page.getByRole("button", { name: "New Contract" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Upload Contract" });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "e2e-services-agreement.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(contents),
  });
  await expect(dialog.getByLabel("Contract Name")).toHaveValue("e2e-services-agreement");
  await dialog.getByLabel("Contract Name").fill(title);

  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/contracts",
  );
  await dialog.getByRole("button", { name: "Upload Contract" }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const { id } = (await response.json()) as { id: string };
  await expect(page.getByText("Contract uploaded successfully")).toBeVisible();
  await expect(dialog).toBeHidden();
  return id;
}
