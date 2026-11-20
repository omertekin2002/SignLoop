import { expect, test, type Page } from "@playwright/test";
import { THEMES, expectNoA11yViolations, startInTheme } from "../axe";
import { expectNoCspViolations, recordCspViolations } from "../csp";
import { STUB_MODEL, stubTitle, type StubModelRequest } from "../stub-model-server";
import { openDashboard, openSidebar } from "./dashboard";
import { E2E_MODEL_STUB_URL, SIGNED_IN_ORIGIN } from "./env";

// Its own project, after the workspace project, because it adds saved chats. The app's model is
// the local stub (e2e/stub-model-server.ts, started by global-setup.ts), so each test sends a real
// turn: the composer, the chat route's stream, the stub's Responses events through the chat
// engine, the saved turn and title, and the history a fresh load reads back from the database.

test.beforeEach(async ({ context }) => {
  // The stub is reached by the server, never by the page, so the page still talks only to its
  // own origin.
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type StoredMessage = { role: string; content: string; model: string | null; provider: string | null };

async function readThread(page: Page, id: string) {
  const response = await page.request.get(`/api/chat/threads/${id}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as {
    data: { id: string; title: string; messages: StoredMessage[] };
  }).data;
}

// The reply the stub streams, rendered: its first line quotes the question, and the rest is a
// Markdown list with bold labels, which only the Markdown renderer turns into <li> and <strong>.
async function expectStubReply(page: Page, question: string) {
  const main = page.getByRole("main");
  await expect(main.getByText(`Stub reply to: ${question}`, { exact: true })).toBeVisible();
  const notice = main.locator("li").filter({ hasText: "Notice period: sixty days" });
  await expect(notice).toBeVisible();
  await expect(notice.locator("strong")).toHaveText("Notice period:");
  await expect(main.locator("li").filter({ hasText: "Renewal: automatic" })).toBeVisible();
  await expect(main.getByText("This reply comes from the end-to-end stub model.")).toBeVisible();
  // The reply's model label (which carries the model as its title) comes from the turn's metadata.
  await expect(main.locator(`span[title="${STUB_MODEL}"]`)).toHaveText(STUB_MODEL);
}

async function stubRequests(page: Page): Promise<StubModelRequest[]> {
  // From the test process, not the page: the stub listens on 127.0.0.1 for the server only.
  const response = await page.context().request.get(`${E2E_MODEL_STUB_URL}/__e2e/requests`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: StubModelRequest[] }).data;
}

for (const theme of THEMES) {
  test(`a saved chat sends a question to the model, streams its reply, and loads both after a reload (${theme} theme)`, async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    const violations = await recordCspViolations(page);
    await startInTheme(page, theme);
    const question = `Does lease ${theme}-${Date.now()} renew automatically?`;
    const title = stubTitle(question);

    await openDashboard(page);
    // The stub is the account's only model, so the model picker selects it.
    await expect(page.getByRole("main").locator("header").getByText(STUB_MODEL, { exact: true })).toBeVisible();
    await openSidebar(page);
    const sidebar = page.locator("aside");
    await sidebar.getByRole("button", { name: "New chat", exact: true }).click();

    // The first message of a new saved chat creates its thread, then sends the turn to it.
    const createdThread = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/chat/threads",
    );
    const sentTurn = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/chat",
    );
    const composer = page.getByRole("textbox", { name: "Chat message" });
    await composer.fill(question);
    await page.getByRole("button", { name: "Send message" }).click();
    const created = await createdThread;
    expect(created.status()).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    expect((await sentTurn).status()).toBe(200);

    // The streamed reply renders as Markdown, and the composer is ready again once it finishes.
    const main = page.getByRole("main");
    await expect(main.getByText(question, { exact: true })).toBeVisible();
    await expectStubReply(page, question);
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    await expect(composer).toHaveValue("");

    // The question reached the model, and the server asked it once for the answer and once for
    // the chat's title.
    const received = (await stubRequests(page)).filter(
      (request) => request.question.includes(question),
    );
    expect(received).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: STUB_MODEL, kind: "reply", question }),
        expect.objectContaining({ model: STUB_MODEL, kind: "title" }),
      ]),
    );
    expect(received).toHaveLength(2);

    // The thread holds exactly one turn: the question and the stub's reply, with its model.
    const stored = await readThread(page, data.id);
    expect(stored.title).toBe(title);
    expect(stored.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: question },
      { role: "assistant", content: expect.stringMatching(new RegExp(`^Stub reply to: ${escapeRegExp(question)}\\n`)) },
    ]);
    expect(stored.messages[1]).toMatchObject({ model: STUB_MODEL, provider: "primary-openai-compatible" });

    // The sidebar and the thread list name the chat with the stub's title.
    const listed = await page.request.get(`/api/chat/threads?q=${encodeURIComponent(title)}`);
    expect(listed.status()).toBe(200);
    expect(await listed.json()).toMatchObject({ total: 1, data: [{ id: data.id, title }] });
    await expectThreadInSidebar(page, title);

    // A saved chat has no URL of its own: a fresh load of the dashboard, then the thread from the
    // sidebar, proves the question and reply come back from the database.
    await page.reload();
    await expect(composer).toBeEnabled();
    await openSidebar(page);
    await expectThreadInSidebar(page, title).then((thread) => thread.click());
    await expect(main.getByText(question, { exact: true })).toBeVisible();
    await expectStubReply(page, question);
    await expectNoA11yViolations(page, { theme });
    // Reopening the thread stored nothing new.
    expect((await readThread(page, data.id)).messages.map(({ role }) => role)).toEqual(["user", "assistant"]);

    expectNoCspViolations(violations, `a saved chat with a stored reply (${theme} theme)`);
    expect(pageErrors).toEqual([]);
  });
}

async function expectThreadInSidebar(page: Page, title: string) {
  const thread = page.locator("aside").getByRole("button", { name: new RegExp(`^${escapeRegExp(title)}`) });
  await expect(thread).toBeVisible();
  return thread;
}
