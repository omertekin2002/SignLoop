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
