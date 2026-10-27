import { expect, test } from "@playwright/test";
import { THEMES, expectNoA11yViolations, startInTheme } from "./axe";
import { E2E_ORIGIN } from "./placeholder-env";

test.beforeEach(async ({ context }) => {
  await context.route(
    (url) => url.origin !== E2E_ORIGIN,
    (route) => route.abort("blockedbyclient"),
  );
});

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await startInTheme(page, theme);
    });

    test("the landing page has no serious accessibility violations", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator('textarea[aria-label="Chat message"]')).toBeVisible();
      // Wait for hydration and the typed-out hero heading (see smoke.spec.ts), so the scan sees the
      // settled page rather than text that is still appearing.
      await expect(page.locator('h1 span[aria-hidden="true"]').first()).toContainText(
        "Not guesswork.",
      );
      // A first visit opens the privacy notice over the page; scan it, then the page itself.
      const notice = page.getByRole("alertdialog", {
        name: "SignLoop Privacy Notice",
      });
      await expect(notice).toBeVisible();
      await expectNoA11yViolations(page, { theme });

      await notice.getByRole("button", { name: "I Understand and Accept" }).click();
      await expect(notice).toBeHidden();
      await expectNoA11yViolations(page, { theme });

      // Signed out, the landing page is the workspace with a temporary chat, sidebar included.
      await page.getByRole("button", { name: "Open sidebar" }).click();
      await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
      await expectNoA11yViolations(page, { theme });
    });

    test("the privacy policy has no serious accessibility violations", async ({ page }) => {
      await page.goto("/privacy");
      await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
      await expectNoA11yViolations(page, { theme });
    });
  });
}
