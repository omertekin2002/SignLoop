import { expect, test, type Page } from "@playwright/test";
import { THEMES, expectNoA11yViolations, startInTheme } from "../axe";
import { SIGNED_IN_ORIGIN } from "./env";

// Its own project, after the workspace project, because it adds contracts the empty-account checks
// there must not see.

test.beforeEach(async ({ context }) => {
  await context.route(
    (url) => url.origin !== SIGNED_IN_ORIGIN,
    (route) => route.abort("blockedbyclient"),
  );
});

async function createContract(page: Page, title: string): Promise<string> {
  const created = await page.request.post("/api/contracts", { data: { title } });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

// Opens a contract page and waits until its notes have loaded, which enables the fields.
async function openNotes(page: Page, id: string, title: string) {
  await page.goto(`/contracts/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  const notes = page.getByRole("region", { name: "Your notes" });
  await expect(notes.getByLabel("Why I'd accept")).toBeEnabled();
  return notes;
}

for (const theme of THEMES) {
  test(`a contract page with notes has no serious accessibility violations (${theme} theme)`, async ({
    page,
  }) => {
    await startInTheme(page, theme);
    const title = `E2E notes a11y ${theme} ${Date.now()}`;
    const id = await createContract(page, title);

    const notes = await openNotes(page, id, title);
    await notes.getByLabel("Why I'd accept").fill("The monthly price is fair.");
    await notes.getByRole("button", { name: "Save notes" }).click();
    await expect(notes.getByRole("status")).toContainText("Saved");
    await expectNoA11yViolations(page, { theme });

    // Another tab saves first, so this page's next save conflicts.
    const current = await page.request.get(`/api/contracts/${id}/notes`);
    const { updatedAt } = (await current.json()) as { updatedAt: string };
    const elsewhere = await page.request.put(`/api/contracts/${id}/notes`, {
      data: {
        acceptanceReasons: "Saved in another tab.",
        openQuestions: "",
        expectedUpdatedAt: updatedAt,
      },
    });
    expect(elsewhere.status()).toBe(200);
    await notes.getByLabel("Open questions").fill("Who pays for repairs?");
    await notes.getByRole("button", { name: "Save notes" }).click();
    await expect(notes.getByText("These notes were changed elsewhere", { exact: true })).toBeVisible();
    await expectNoA11yViolations(page, { theme });
  });
}

test("notes save, survive a reload, and a conflict keeps the user's text", async ({ page }) => {
  const title = `E2E notes ${Date.now()}`;
  const id = await createContract(page, title);

  let notes = await openNotes(page, id, title);
  await expect(notes.getByLabel("Why I'd accept")).toHaveValue("");
  await notes.getByLabel("Why I'd accept").fill("Cancel any month.");
  await notes.getByLabel("Open questions").fill("Is the deposit refundable?");
  await notes.getByRole("button", { name: "Save notes" }).click();
  await expect(notes.getByRole("status")).toContainText("Saved");

  await page.reload();
  notes = await openNotes(page, id, title);
  await expect(notes.getByLabel("Why I'd accept")).toHaveValue("Cancel any month.");
  await expect(notes.getByLabel("Open questions")).toHaveValue("Is the deposit refundable?");

  // A second tab saves over the revision this page read.
  const other = await page.context().newPage();
  const otherNotes = await openNotes(other, id, title);
  await otherNotes.getByLabel("Open questions").fill("Answered: yes.");
  await otherNotes.getByRole("button", { name: "Save notes" }).click();
  await expect(otherNotes.getByRole("status")).toContainText("Saved");
  await other.close();

  await notes.getByLabel("Why I'd accept").fill("My unsaved reasoning.");
  await notes.getByRole("button", { name: "Save notes" }).click();
  await expect(notes.getByText("These notes were changed elsewhere", { exact: true })).toBeVisible();
  await expect(notes.getByText("Answered: yes.")).toBeVisible();
  await expect(notes.getByLabel("Why I'd accept")).toHaveValue("My unsaved reasoning.");

  await notes.getByRole("button", { name: "Replace it with mine" }).click();
  await expect(notes.getByRole("status")).toContainText("Saved");
  const stored = await page.request.get(`/api/contracts/${id}/notes`);
  expect(await stored.json()).toMatchObject({
    acceptanceReasons: "My unsaved reasoning.",
    openQuestions: "Is the deposit refundable?",
  });
});
