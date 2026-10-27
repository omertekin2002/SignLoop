import { expect, test, type Page } from "@playwright/test";
import { THEMES, expectNoA11yViolations, startInTheme } from "../axe";
import { openDashboard, openSidebar } from "./dashboard";
import { SIGNED_IN_ORIGIN } from "./env";

// Runs in the workspace project, before workspace.spec.ts (files run in name order on one worker),
// so the account still has no contracts or projects and the sections show their empty states.

test.beforeEach(async ({ context }) => {
  await context.route(
    (url) => url.origin !== SIGNED_IN_ORIGIN,
    (route) => route.abort("blockedbyclient"),
  );
});

async function openSidebarSection(page: Page, section: "Contracts" | "Projects") {
  await openSidebar(page);
  await page.getByRole("button", { name: section, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: section })).toBeVisible();
}

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await startInTheme(page, theme);
    });

    test("the dashboard has no serious accessibility violations", async ({ page }) => {
      await openDashboard(page);
      await expectNoA11yViolations(page, { theme });

      await openSidebar(page);
      await expectNoA11yViolations(page, { theme });
    });

    test("the empty Contracts section has no serious accessibility violations", async ({
      page,
    }) => {
      await openDashboard(page);
      await openSidebarSection(page, "Contracts");
      await expect(page.getByRole("heading", { name: "No contracts found" })).toBeVisible();
      await expectNoA11yViolations(page, { theme });
    });

    test("the empty Projects section has no serious accessibility violations", async ({ page }) => {
      await openDashboard(page);
      await openSidebarSection(page, "Projects");
      await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();
      await expectNoA11yViolations(page, { theme });
    });

    test("settings have no serious accessibility violations", async ({ page }) => {
      await page.goto("/settings");
      await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
      await expect(page.getByText("Usage", { exact: true })).toBeVisible();
      // Scan the loaded settings, not their placeholders.
      await expect(page.getByText("Loading settings...")).toHaveCount(0);
      await expect(page.getByText("Unable to load settings")).toHaveCount(0);
      await expectNoA11yViolations(page, { theme });
    });
  });
}

// After the empty-section scans above, which a project would fill.
for (const theme of THEMES) {
  test(`a project page has no serious accessibility violations (${theme} theme)`, async ({
    page,
  }) => {
    await startInTheme(page, theme);
    const title = `E2E a11y project ${theme} ${Date.now()}`;
    const created = await page.request.post("/api/projects", {
      data: { title },
    });
    expect(created.status()).toBe(201);
    const { id } = (await created.json()) as { id: string };

    await page.goto(`/projects/${id}`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expectNoA11yViolations(page, { theme });
  });
}
