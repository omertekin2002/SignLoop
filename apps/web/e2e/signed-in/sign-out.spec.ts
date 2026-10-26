import { expect, test } from "@playwright/test";
import { openDashboard, openSidebar } from "./dashboard";
import { SIGNED_IN_ORIGIN } from "./env";

// Runs last: signing out ends the WorkOS session the other projects shared.
test("signing out ends the session", async ({ page }) => {
  await openDashboard(page);
  await openSidebar(page);
  await page.getByRole("button", { name: "Sign out" }).click();

  // AuthKit ends the session at WorkOS, which returns to the registered sign-out URI.
  await page.waitForURL(`${SIGNED_IN_ORIGIN}/`);

  const usage = await page.request.get("/api/usage", { maxRedirects: 0 });
  expect(usage.status()).toBe(401);
  const dashboard = await page.request.get("/dashboard", { maxRedirects: 0 });
  expect([302, 303, 307]).toContain(dashboard.status());
  expect(new URL(dashboard.headers()["location"] ?? "", SIGNED_IN_ORIGIN).origin).toBe(
    "https://api.workos.com",
  );
});
