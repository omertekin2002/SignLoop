import { expect, test, type Page } from "@playwright/test";
import { THEMES, expectNoA11yViolations, startInTheme } from "../axe";
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

test("a dropped contract uploads through the multipart path, within its 4 MB limit", async ({ page }) => {
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
  await expect(page.getByText("File too large. Maximum size is 4 MB.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Upload Contract" })).toBeDisabled();
  await expect(dialog.getByLabel("Contract Name")).toHaveValue("");

  const droppedFile = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(
      ["This lease renews automatically each year unless either party gives sixty days written notice."],
      "e2e-lease.txt",
      { type: "text/plain" },
    ));
    return transfer;
  });
  await dialog.dispatchEvent("dragenter", { dataTransfer: droppedFile });
  await expect(dialog.getByText("Drop file here")).toBeVisible();
  await dialog.dispatchEvent("drop", { dataTransfer: droppedFile });
  await droppedFile.dispose();
  await expect(dialog.getByLabel("Contract Name")).toHaveValue("e2e-lease");
  await expect(dialog.getByRole("button", { name: /Change selected file: e2e-lease\.txt/ })).toBeVisible();
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
  // The dialog moves focus to its first field when it opens, without an autoFocus prop.
  await expect(dialog.getByLabel("Project Title *")).toBeFocused();
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

// Each theme creates its own linked and standalone contracts, so it can run in isolation.
for (const theme of THEMES) {
  test(`a title search finds a contract inside a project and clears back to the list (${theme} theme)`, async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    await startInTheme(page, theme);
    const stamp = `${theme} ${Date.now()}`;
    const projectTitle = `E2E search project ${stamp}`;
    const project = await page.request.post("/api/projects", { data: { title: projectTitle } });
    expect(project.status()).toBe(201);
    const { id: projectId } = (await project.json()) as { id: string };
    const title = `E2E searchable lease ${stamp}`;
    const created = await page.request.post("/api/contracts", { data: { title, projectId } });
    expect(created.status()).toBe(201);
    const standaloneTitle = `E2E standalone lease ${stamp}`;
    const standalone = await page.request.post("/api/contracts", { data: { title: standaloneTitle } });
    expect(standalone.status()).toBe(201);

    // The API searches every contract, ignores standalone=true, and names the project.
    const found = await page.request.get(
      `/api/contracts?standalone=true&q=${encodeURIComponent(`  SEARCHABLE lease ${stamp} `)}`,
    );
    expect(found.status()).toBe(200);
    expect(await found.json()).toMatchObject({
      total: 1,
      data: [{ title, projectId, projectTitle }],
    });
    expect((await page.request.get(`/api/contracts?q=${"a".repeat(201)}`)).status()).toBe(400);

    await openDashboard(page);
    await openSidebarSection(page, "Contracts");
    const search = page.getByRole("searchbox", { name: "Search contracts" });
    const standaloneCardTitle = page.getByRole("main").getByRole("heading", { name: standaloneTitle, exact: true });
    await expect(page.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);
    await expect(standaloneCardTitle).toBeVisible();

    await search.fill(`searchable lease ${stamp}`);
    await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();
    await expect(standaloneCardTitle).toHaveCount(0);
    await expect(page.getByText(projectTitle)).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "1 contract matches" })).toBeVisible();
    await expectNoA11yViolations(page, { theme });

    await search.fill(`no such contract ${stamp}`);
    const noMatch = page.getByRole("heading", { name: `No contracts match “no such contract ${stamp}”` });
    await expect(noMatch).toBeVisible();
    await expect(page.getByRole("heading", { name: "No contracts found" })).toHaveCount(0);
    await expectNoA11yViolations(page, { theme });

    await page.getByRole("button", { name: "Clear search" }).last().click();
    await expect(search).toHaveValue("");
    await expect(noMatch).toHaveCount(0);
    await expect(page.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);
    await expect(standaloneCardTitle).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
}

// Each theme creates its own contracts, so it can run in isolation.
for (const theme of THEMES) {
  test(`status and added filters narrow the contracts, with a search, and clear back to the list (${theme} theme)`, async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    await startInTheme(page, theme);
    const stamp = `${theme} ${Date.now()}`;
    const projectTitle = `E2E filter project ${stamp}`;
    const project = await page.request.post("/api/projects", { data: { title: projectTitle } });
    expect(project.status()).toBe(201);
    const { id: projectId } = (await project.json()) as { id: string };
    const filedTitle = `E2E filtered draft ${stamp}`;
    expect((await page.request.post("/api/contracts", { data: { title: filedTitle, projectId } })).status()).toBe(201);
    const standaloneTitle = `E2E filtered standalone ${stamp}`;
    expect((await page.request.post("/api/contracts", { data: { title: standaloneTitle } })).status()).toBe(201);

    // New contracts are drafts added just now; a filter spans projects and counts only matches.
    const q = encodeURIComponent(stamp);
    const drafts = await page.request.get(`/api/contracts?standalone=true&q=${q}&status=draft&added=7d`);
    expect(drafts.status()).toBe(200);
    expect(await drafts.json()).toMatchObject({ total: 2 });
    const analyzed = await page.request.get(`/api/contracts?standalone=true&q=${q}&status=analyzed`);
    expect(await analyzed.json()).toMatchObject({ total: 0, data: [] });
    expect((await page.request.get("/api/contracts?status=pending")).status()).toBe(400);
    expect((await page.request.get("/api/contracts?added=1d")).status()).toBe(400);

    await openDashboard(page);
    await openSidebarSection(page, "Contracts");
    const main = page.getByRole("main");
    const status = page.getByRole("combobox", { name: "Status" });
    const added = page.getByRole("combobox", { name: "Added" });
    const standaloneCardTitle = main.getByRole("heading", { name: standaloneTitle, exact: true });
    const filedCardTitle = main.getByRole("heading", { name: filedTitle, exact: true });
    await expect(standaloneCardTitle).toBeVisible();
    await expect(filedCardTitle).toHaveCount(0);

    await page.getByRole("searchbox", { name: "Search contracts" }).fill(stamp);
    await status.selectOption("draft");
    await added.selectOption("7d");
    await expect(filedCardTitle).toBeVisible();
    await expect(standaloneCardTitle).toBeVisible();
    await expect(main.getByText(projectTitle)).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "2 contracts match" }),
    ).toContainText("not analyzed yet, added in the last 7 days");
    await expectNoA11yViolations(page, { theme });

    await status.selectOption("analyzed");
    const noMatch = main.getByRole("heading", { name: /^No contracts match “.+” and the filters: analyzed/ });
    await expect(noMatch).toBeVisible();
    await expect(page.getByRole("heading", { name: "No contracts found" })).toHaveCount(0);
    await expectNoA11yViolations(page, { theme });

    await page.getByRole("button", { name: "Clear search and filters" }).click();
    await expect(status).toHaveValue("");
    await expect(added).toHaveValue("");
    await expect(page.getByRole("searchbox", { name: "Search contracts" })).toHaveValue("");
    await expect(noMatch).toHaveCount(0);
    await expect(filedCardTitle).toHaveCount(0);
    await expect(standaloneCardTitle).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
}

// Each theme uploads its own contract, so it can run in isolation.
for (const theme of THEMES) {
  test(`a search finds a contract by words in its text and shows where they matched (${theme} theme)`, async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    await startInTheme(page, theme);
    const stamp = `${theme} ${Date.now()}`;
    // A word no title holds, so only the uploaded text can match it.
    const phrase = `zephyr${theme}${Date.now()} notice`;
    const projectTitle = `E2E text search project ${stamp}`;
    const project = await page.request.post("/api/projects", { data: { title: projectTitle } });
    expect(project.status()).toBe(201);
    const { id: projectId } = (await project.json()) as { id: string };
    const title = `E2E text match ${stamp}`;
    const created = await page.request.post("/api/contracts", { data: { title, projectId } });
    expect(created.status()).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const upload = await page.request.post(`/api/contracts/${id}/upload`, {
      multipart: {
        file: {
          name: "e2e-text-search.txt",
          mimeType: "text/plain",
          buffer: Buffer.from(
            `Either party may end this agreement with a ${phrase} period.\n\nPayment is due in thirty days.`,
          ),
        },
      },
    });
    expect(upload.status()).toBe(200);

    // The API reports a text match with a short excerpt, never the full text.
    const found = await page.request.get(`/api/contracts?standalone=true&q=${encodeURIComponent(phrase)}`);
    expect(found.status()).toBe(200);
    expect(await found.json()).toMatchObject({
      total: 1,
      data: [{ id, projectTitle, match: { in: "text", snippet: expect.stringContaining(`${phrase} period.`) } }],
    });
    const byTitle = await page.request.get(`/api/contracts?q=${encodeURIComponent(title)}`);
    expect(await byTitle.json()).toMatchObject({ total: 1, data: [{ id, match: { in: "title" } }] });

    await openDashboard(page);
    await openSidebarSection(page, "Contracts");
    const main = page.getByRole("main");
    const search = page.getByRole("searchbox", { name: "Search contracts" });
    await expect(search).toHaveAttribute("placeholder", "Search titles and contract text, including in projects");
    await search.fill(phrase);
    const card = main.getByRole("link").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
    await expect(card.getByText("Matched in contract text")).toBeVisible();
    await expect(card.locator("mark")).toHaveText(phrase);
    await expect(card.getByText(projectTitle)).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "1 contract matches" })).toBeVisible();
    await expectNoA11yViolations(page, { theme });

    // A title match shows no excerpt; clearing the search restores the standalone list.
    await search.fill(title);
    await expect(card.getByText("Matched in contract text")).toHaveCount(0);
    await expect(card).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).first().click();
    await expect(search).toHaveValue("");
    await expect(main.getByRole("heading", { name: title, exact: true })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
}

// Each theme creates its own projects, so it can run in isolation.
for (const theme of THEMES) {
  test(`a name search finds a new project and clears back to the list (${theme} theme)`, async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    await startInTheme(page, theme);
    const stamp = `${theme} ${Date.now()}`;
    const title = `E2E findable project ${stamp}`;
    const created = await page.request.post("/api/projects", { data: { title } });
    expect(created.status()).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const otherTitle = `E2E other project ${stamp}`;
    expect((await page.request.post("/api/projects", { data: { title: otherTitle } })).status()).toBe(201);

    // The API matches names case-insensitively after trimming, and counts only the matches.
    const found = await page.request.get(
      `/api/projects?q=${encodeURIComponent(`  FINDABLE project ${stamp} `)}`,
    );
    expect(found.status()).toBe(200);
    expect(await found.json()).toMatchObject({ total: 1, data: [{ id, title }] });
    expect((await page.request.get(`/api/projects?q=${"a".repeat(201)}`)).status()).toBe(400);

    await openDashboard(page);
    await openSidebarSection(page, "Projects");
    const search = page.getByRole("searchbox", { name: "Search projects" });
    const main = page.getByRole("main");
    const cardTitle = main.getByRole("heading", { name: title, exact: true });
    const otherCardTitle = main.getByRole("heading", { name: otherTitle, exact: true });
    await expect(otherCardTitle).toBeVisible();

    await search.fill(`findable project ${stamp}`);
    await expect(cardTitle).toBeVisible();
    await expect(otherCardTitle).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "1 project matches" })).toBeVisible();
    await expectNoA11yViolations(page, { theme });

    await search.fill(`no such project ${stamp}`);
    const noMatch = page.getByRole("heading", { name: `No projects match “no such project ${stamp}”` });
    await expect(noMatch).toBeVisible();
    await expect(page.getByRole("heading", { name: "No projects yet" })).toHaveCount(0);
    await expectNoA11yViolations(page, { theme });

    await page.getByRole("button", { name: "Clear search" }).last().click();
    await expect(search).toHaveValue("");
    await expect(noMatch).toHaveCount(0);
    await expect(otherCardTitle).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
}

// Each theme creates its own chats, so it can run in isolation.
for (const theme of THEMES) {
  test(`a title search finds a saved chat in the sidebar and clears back to the list (${theme} theme)`, async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    await startInTheme(page, theme);
    const stamp = `${theme} ${Date.now()}`;
    const title = `E2E findable chat ${stamp}`;
    const created = await page.request.post("/api/chat/threads", { data: { title } });
    expect(created.status()).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    const otherTitle = `E2E other chat ${stamp}`;
    expect((await page.request.post("/api/chat/threads", { data: { title: otherTitle } })).status()).toBe(201);

    // The API matches titles case-insensitively after trimming, and counts only the matches.
    const found = await page.request.get(
      `/api/chat/threads?q=${encodeURIComponent(`  FINDABLE chat ${stamp} `)}`,
    );
    expect(found.status()).toBe(200);
    expect(await found.json()).toMatchObject({ total: 1, data: [{ id: data.id, title }] });
    expect((await page.request.get(`/api/chat/threads?q=${"a".repeat(201)}`)).status()).toBe(400);

    await openDashboard(page);
    await openSidebar(page);
    const sidebar = page.locator("aside");
    const search = sidebar.getByRole("searchbox", { name: "Search chats" });
    const result = sidebar.getByRole("button", { name: new RegExp(`^${title}`) });
    const other = sidebar.getByRole("button", { name: new RegExp(`^${otherTitle}`) });
    await expect(other).toBeVisible();

    await search.fill(`findable chat ${stamp}`);
    await expect(result).toBeVisible();
    await expect(other).toHaveCount(0);
    // Temporary chat stays at the top of the section whatever the search.
    await expect(sidebar.getByRole("button", { name: /^Temporary chat\s*Not saved$/ })).toBeVisible();
    await expect(sidebar.getByRole("status").filter({ hasText: "1 chat matches" })).toBeVisible();
    await expectNoA11yViolations(page, { theme });

    await search.fill(`no such chat ${stamp}`);
    const noMatch = sidebar.getByText(`No chats match “no such chat ${stamp}”`);
    await expect(noMatch).toBeVisible();
    await expect(sidebar.getByText("No chats yet")).toHaveCount(0);
    await expectNoA11yViolations(page, { theme });

    await sidebar.getByRole("button", { name: "Clear search" }).last().click();
    await expect(search).toHaveValue("");
    await expect(noMatch).toHaveCount(0);
    await expect(other).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
}

// The thread is real; its history is fulfilled here, since producing an interrupted turn needs a
// model reply cut off mid-stream.
for (const theme of THEMES) {
  test(`an interrupted reply shows its marker and Retry with no serious accessibility violations (${theme} theme)`, async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    await startInTheme(page, theme);
    const title = `E2E interrupted chat ${theme} ${Date.now()}`;
    const created = await page.request.post("/api/chat/threads", { data: { title } });
    expect(created.status()).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    const createdAt = new Date().toISOString();
    await page.route(
      (url) => url.pathname === `/api/chat/threads/${data.id}` && !url.search,
      (route) =>
        route.request().method() === "GET"
          ? route.fulfill({
              json: {
                data: {
                  id: data.id,
                  title,
                  hasMore: false,
                  messages: [
                    {
                      id: crypto.randomUUID(), threadId: data.id, role: "user",
                      content: "Explain my lease renewal.", position: 1, createdAt,
                      model: null, provider: null, turnId: crypto.randomUUID(),
                    },
                    {
                      id: crypto.randomUUID(), threadId: data.id, role: "assistant",
                      content: "Renewal extends the", position: 2, createdAt,
                      model: null, provider: null, interrupted: "stopped",
                    },
                  ],
                },
              },
            })
          : route.fallback(),
    );

    await openDashboard(page);
    await openSidebar(page);
    await page.locator("aside").getByRole("button", { name: new RegExp(`^${title}`) }).click();
    const notice = page.getByRole("status").filter({ hasText: "Reply interrupted." });
    await expect(notice).toBeVisible();
    await expect(page.getByText("Renewal extends the")).toBeVisible();
    await expect(notice.getByRole("button", { name: "Retry" })).toBeEnabled();
    await expectNoA11yViolations(page, { theme });
    expect(pageErrors).toEqual([]);
  });
}

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
