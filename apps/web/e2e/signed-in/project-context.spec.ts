import { expect, test, type Page } from "@playwright/test";
import { THEMES, expectNoA11yViolations, startInTheme } from "../axe";
import { expectNoCspViolations, recordCspViolations } from "../csp";
import { SIGNED_IN_ORIGIN } from "./env";

// Its own project, after the workspace project, because it adds projects with context documents
// the empty-account checks there must not see. Each test adds a context document through the
// project page's own form, so the form, the multipart upload into local storage, text extraction,
// the stored row and the page's list are checked together.

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

type ContextDocument = {
  id: string;
  title: string;
  documentType: string;
  originalFilename: string;
  fileSize: number;
  wordCount: number | null;
};

async function createProject(page: Page, title: string): Promise<string> {
  const created = await page.request.post("/api/projects", { data: { title } });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

async function listContextDocuments(page: Page, projectId: string): Promise<ContextDocument[]> {
  const response = await page.request.get(`/api/projects/${projectId}/context`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: ContextDocument[] }).data;
}

// Opens a project page and waits until the project and the upload limit have loaded. The page
// renders a skeleton until its query resolves on the client, so the heading also means the form's
// handlers are attached, and the limit in the hint means the client-side size check is armed.
async function openProject(page: Page, id: string, title: string) {
  await page.goto(`/projects/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
  await expect(page.getByText("PDF, DOC, DOCX, or TXT up to 4 MB")).toBeVisible();
}

// Chooses a file through the context form's own picker button, as a user would.
async function chooseContextFile(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /(Click to select|Change selected) context file/ }).click();
  await (await chooser).setFiles(file);
  await expect(
    page.getByRole("button", { name: `Change selected context file: ${file.name}` }),
  ).toBeVisible();
}

// Scans only once the dialog's entrance animation has finished, so axe measures final colours
// rather than a half-faded frame. Spinners and other infinite animations are skipped.
async function waitForAnimations(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished),
    ),
  );
}

for (const theme of THEMES) {
  test(`a context document uploads through the project page, lists after a reload, and deletes (${theme} theme)`, async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    const violations = await recordCspViolations(page);
    await startInTheme(page, theme);
    const stamp = `${theme} ${Date.now()}`;
    const projectTitle = `E2E context project ${stamp}`;
    const projectId = await createProject(page, projectTitle);

    await openProject(page, projectId, projectTitle);
    await expect(page.getByRole("button", { name: /^Delete E2E prior agreement/ })).toHaveCount(0);

    const docTitle = `E2E prior agreement ${stamp}`;
    const fileName = "e2e-prior-agreement.txt";
    const text = `The prior agreement for ${stamp} set the monthly fee at forty pounds.\n\nEither party could end it with thirty days written notice.`;
    const words = text.split(/\s+/).filter(Boolean).length;
    await chooseContextFile(page, {
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(text),
    });
    // Choosing a file names the document after it; the user then gives it a title and a type.
    const titleField = page.getByLabel("Title", { exact: true });
    await expect(titleField).toHaveValue("e2e-prior-agreement");
    await titleField.fill(docTitle);
    const typeField = page.getByRole("combobox", { name: "Type", exact: true });
    await typeField.click();
    await page.getByRole("option", { name: "Prior Contract", exact: true }).click();
    await expect(typeField).toHaveText("Prior Contract");

    const uploaded = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/projects/${projectId}/context`,
    );
    await page.getByRole("button", { name: "Add Context Document" }).click();
    expect((await uploaded).status()).toBe(201);
    await expect(page.getByText("Context document uploaded", { exact: true })).toBeVisible();
    // The form clears for the next document.
    await expect(titleField).toHaveValue("");
    await expect(page.getByRole("button", { name: /Click to select context file/ })).toBeVisible();

    // A fresh load proves the document came from the database, with its type and extracted text.
    await openProject(page, projectId, projectTitle);
    await expect(page.getByText(docTitle, { exact: true })).toBeVisible();
    await expect(page.getByText(`prior contract • ${words} words`, { exact: true })).toBeVisible();
    const deleteButton = page.getByRole("button", { name: `Delete ${docTitle}`, exact: true });
    await expect(deleteButton).toBeVisible();
    expect(await listContextDocuments(page, projectId)).toEqual([
      expect.objectContaining({
        title: docTitle,
        documentType: "prior_contract",
        originalFilename: fileName,
        fileSize: Buffer.byteLength(text),
        wordCount: words,
      }),
    ]);
    await expectNoA11yViolations(page, { theme });

    // Deleting asks first.
    await deleteButton.click();
    const confirm = page.getByRole("alertdialog", { name: "Delete document?" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("This will permanently delete this context document.");
    await waitForAnimations(page);
    await expectNoA11yViolations(page, { theme });

    const deleted = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname.startsWith(`/api/projects/${projectId}/context/`),
    );
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    expect((await deleted).ok()).toBe(true);
    await expect(page.getByText("Context document deleted", { exact: true })).toBeVisible();
    await expect(confirm).toBeHidden();
    await expect(deleteButton).toHaveCount(0);

    await openProject(page, projectId, projectTitle);
    await expect(page.getByText(docTitle, { exact: true })).toHaveCount(0);
    await expect(deleteButton).toHaveCount(0);
    expect(await listContextDocuments(page, projectId)).toEqual([]);

    expectNoCspViolations(violations, "a project page with a context document");
    expect(pageErrors).toEqual([]);
  });
}

test("the project page refuses a context document over the 4 MB limit without sending it", async ({
  page,
}) => {
  const pageErrors = collectPageErrors(page);
  const projectTitle = `E2E context limit ${Date.now()}`;
  const projectId = await createProject(page, projectTitle);
  await openProject(page, projectId, projectTitle);

  const uploads: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (
      request.method() === "POST" &&
      (pathname === `/api/projects/${projectId}/context` || pathname === "/api/uploads")
    ) {
      uploads.push(`${request.method()} ${pathname}`);
    }
  });

  await chooseContextFile(page, {
    name: "e2e-oversize-context.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(4 * 1024 * 1024 + 1, "a"),
  });
  const addButton = page.getByRole("button", { name: "Add Context Document" });
  await expect(addButton).toBeEnabled();
  await addButton.click();
  await expect(page.getByText("File too large. Maximum size is 4 MB.", { exact: true })).toBeVisible();
  // The check runs before any request, and the selection stays so the user can see what failed.
  await expect(addButton).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Change selected context file: e2e-oversize-context.txt" }),
  ).toBeVisible();
  expect(uploads).toEqual([]);
  expect(await listContextDocuments(page, projectId)).toEqual([]);
  expect(pageErrors).toEqual([]);
});
