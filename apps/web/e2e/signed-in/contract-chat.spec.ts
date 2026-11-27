import { readFileSync } from "node:fs";
import { expect, test, type Page, type Request } from "@playwright/test";
import { THEMES, expectNoA11yViolations, startInTheme } from "../axe";
import { expectNoCspViolations, recordCspViolations } from "../csp";
import {
  STUB_ANALYSIS_FLAGS,
  STUB_CONTRACT_FIXTURE,
  STUB_FOCUSED_FOUND_QUOTE,
  STUB_FOCUSED_INVENTED_QUOTE,
  STUB_QUESTION,
  stubTitle,
  type StubModelRequest,
} from "../stub-model-server";
import { openSidebar, uploadThroughDashboard } from "./dashboard";
import { E2E_MODEL_STUB_URL, SIGNED_IN_ORIGIN } from "./env";

// Its own project, after the workspace project, because it adds a contract and a saved chat. The
// contract page's "Ask about this contract" opens a new saved chat about that contract; the first
// message sends its id with the turn, the server adds a note naming it to the model's
// instructions (the local stub records them), and the thread keeps that focus after a reload.

test.beforeEach(async ({ context }) => {
  // The stub is reached by the server, never by the page.
  await context.route(
    (url) => url.origin !== SIGNED_IN_ORIGIN,
    (route) => route.abort("blockedbyclient"),
  );
});

const FIXTURE_TEXT = readFileSync(STUB_CONTRACT_FIXTURE, "utf8").trim();

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Every request the page makes to the chat API: a draft must send none. */
function recordChatRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname === "/api/chat" || (pathname === "/api/chat/threads" && request.method() === "POST"))
      requests.push(request);
  });
  return requests;
}

async function stubRequests(page: Page): Promise<StubModelRequest[]> {
  const response = await page.context().request.get(`${E2E_MODEL_STUB_URL}/__e2e/requests`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: StubModelRequest[] }).data;
}

/**
 * The stub's reply about the fixture holds one quotation from it and one invented, so the list
 * under the reply marks one found and one not found.
 */
async function expectQuotationChecks(page: Page) {
  const list = page.getByRole("main").getByRole("list", { name: "Quotations" });
  await expect(list).toBeVisible();
  const rows = list.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(STUB_FOCUSED_FOUND_QUOTE);
  await expect(rows.nth(0)).toContainText("Found in the contract");
  await expect(rows.nth(1)).toContainText(STUB_FOCUSED_INVENTED_QUOTE);
  await expect(rows.nth(1)).toContainText(
    "Not found in the contract: check the wording against the original",
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const theme of THEMES) {
  test(`"Ask about this contract" opens a saved chat about it, sends its focus with the first message, and keeps it after a reload (${theme} theme)`, async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    const violations = await recordCspViolations(page);
    await startInTheme(page, theme);
    const title = `E2E chat agreement ${theme} ${Date.now()}`;
    const id = await uploadThroughDashboard(page, title, FIXTURE_TEXT);

    // The contract has text but no analysis, and the button is already offered.
    await page.goto(`/contracts/${id}`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    const ask = page.getByRole("link", { name: "Ask about this contract" });
    await expect(ask).toHaveAttribute("href", `/dashboard?contract=${id}`);
    // No chat is about the contract yet.
    const chatsCard = page.getByRole("region", { name: "Chats about this contract" });
    await expect(
      chatsCard.getByText("No chats about this contract yet. Start one with Ask about this contract."),
    ).toBeVisible();
    await expectNoA11yViolations(page, { theme });

    const chatRequests = recordChatRequests(page);
    await ask.click();

    // A new saved chat names the contract and offers an editable draft, but sends nothing.
    await expect(page).toHaveURL(`${SIGNED_IN_ORIGIN}/dashboard`);
    const main = page.getByRole("main");
    const composer = page.getByRole("textbox", { name: "Chat message" });
    const draft = `About “${title}”: `;
    await expect(composer).toHaveValue(draft);
    const scope = main.getByRole("link", { name: title, exact: true });
    await expect(scope).toHaveAttribute("href", `/contracts/${id}`);
    await expect(main.getByText("About:", { exact: true })).toBeVisible();
    expect(chatRequests).toEqual([]);
    await expectNoA11yViolations(page, { theme });
    expect(chatRequests).toEqual([]);

    const question = `${draft}can the client end it early? ${theme}-${Date.now()}`;
    const createdThread = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/chat/threads",
    );
    const sentTurn = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/api/chat",
    );
    await composer.fill(question);
    await page.getByRole("button", { name: "Send message" }).click();
    const created = await createdThread;
    expect(created.status()).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    const turn = await sentTurn;
    expect(turn.status()).toBe(200);
    // Only the contract id travels with the turn.
    expect(turn.request().postDataJSON()).toMatchObject({ threadId: data.id, focusContractId: id });
    await expect(main.getByText(`Stub reply to: ${question}`, { exact: true })).toBeVisible();
    // The server checked the reply's quotations against the contract's text.
    await expectQuotationChecks(page);
    await expectNoA11yViolations(page, { theme });

    // The model was told which contract the chat is about and was offered read_contract; the
    // contract's text was not put in its instructions.
    const reply = (await stubRequests(page)).find(
      (request) => request.kind === "reply" && request.question.includes(question),
    );
    expect(reply).toBeDefined();
    expect(reply!.system).toContain(`This conversation is about one of the user's contracts, id ${id}.`);
    expect(reply!.system).toContain(title);
    expect(reply!.system).toContain(`call read_contract with contractId ${id} first`);
    expect(reply!.tools).toEqual(expect.arrayContaining(["read_contract", "list_contracts"]));
    expect(reply!.system).not.toContain("Late payments accrue interest at 4% per month");
    expect(FIXTURE_TEXT).toContain("Late payments accrue interest at 4% per month");

    // The thread stores the focus with its first turn.
    const stored = await page.request.get(`/api/chat/threads/${data.id}`);
    expect(stored.status()).toBe(200);
    const storedThread = (await stored.json()) as { data: { title: string } };
    expect(storedThread).toMatchObject({
      data: {
        focus: { contractId: id, title },
        messages: [
          { role: "user" },
          {
            role: "assistant",
            // Stored with the reply: each result and the contract text revision it was checked against.
            quoteChecks: {
              contractId: id,
              revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
              checks: [
                { quote: STUB_FOCUSED_FOUND_QUOTE, status: "found" },
                { quote: STUB_FOCUSED_INVENTED_QUOTE, status: "not_found" },
              ],
            },
          },
        ],
      },
    });
    // The stub names the chat after the question, which the app cuts to 80 characters.
    const chatTitle = storedThread.data.title;
    expect(stubTitle(question).startsWith(chatTitle.replace(/…$/, ""))).toBe(true);

    // After a reload the thread, opened from the sidebar, still shows what it is about.
    await page.reload();
    await expect(composer).toBeEnabled();
    await openSidebar(page);
    const thread = page
      .locator("aside")
      .getByRole("button", { name: new RegExp(`^${escapeRegExp(chatTitle)}`) });
    await thread.click();
    await expect(main.getByText(`Stub reply to: ${question}`, { exact: true })).toBeVisible();
    await expectQuotationChecks(page);
    await expect(main.getByRole("link", { name: title, exact: true })).toHaveAttribute(
      "href",
      `/contracts/${id}`,
    );
    await expect(composer).toHaveValue("");
    await expectNoA11yViolations(page, { theme });

    // An unscoped chat of the same user is never one of the contract's chats.
    const unscopedTitle = `E2E unscoped chat ${theme} ${Date.now()}`;
    const unscoped = await page.request.post("/api/chat/threads", { data: { title: unscopedTitle } });
    expect(unscoped.status()).toBe(201);
    const listed = await page.request.get(`/api/chat/threads?contract=${id}`);
    expect(listed.status()).toBe(200);
    expect(await listed.json()).toMatchObject({ data: [{ id: data.id, title: chatTitle }], total: 1 });
    expect((await page.request.get("/api/chat/threads?contract=not-a-uuid")).status()).toBe(400);

    // The contract page lists the chat by title and reopens it in the dashboard.
    await page.goto(`/contracts/${id}`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    const listedChat = chatsCard.getByRole("link");
    await expect(listedChat).toHaveCount(1);
    await expect(listedChat).toContainText(chatTitle.replace(/…$/, ""));
    await expect(listedChat).toContainText("2 messages");
    await expect(listedChat).toHaveAttribute("href", `/dashboard?thread=${data.id}`);
    await expect(chatsCard).not.toContainText(unscopedTitle);
    await expectNoA11yViolations(page, { theme });
    await listedChat.click();
    await expect(page).toHaveURL(`${SIGNED_IN_ORIGIN}/dashboard`);
    await expect(main.getByText(`Stub reply to: ${question}`, { exact: true })).toBeVisible();
    await expectQuotationChecks(page);
    await expect(main.getByText("About:", { exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: title, exact: true })).toHaveAttribute(
      "href",
      `/contracts/${id}`,
    );
    await expect(composer).toHaveValue("");
    await expectNoA11yViolations(page, { theme });

    // A thread id that is not the user's shows the not-found state and nothing from any thread;
    // a malformed one is a plain dashboard.
    await page.goto(`/dashboard?thread=${crypto.randomUUID()}`);
    await expect(page).toHaveURL(`${SIGNED_IN_ORIGIN}/dashboard`);
    await expect(main.getByRole("alert")).toContainText("Couldn't load this conversation");
    await expect(main.getByText(`Stub reply to: ${question}`, { exact: true })).toHaveCount(0);
    await page.goto("/dashboard?thread=not-a-uuid");
    await expect(composer).toBeEnabled();
    await expect(main.getByRole("alert")).toHaveCount(0);

    expectNoCspViolations(violations, `a saved chat about a contract (${theme} theme)`);
    expect(pageErrors).toEqual([]);
  });
}

// A "Before you sign" item's Ask link opens the same kind of chat about the contract, with a
// question drafted in the browser from the stored item. The dark run asks about a finding and the
// light run about the analysis's question.
for (const theme of THEMES) {
  const asksFinding = theme === "dark";
  test(`a "Before you sign" item's Ask drafts a question about it in a chat about the contract, and sends it only on Send (${theme} theme)`, async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    const violations = await recordCspViolations(page);
    await startInTheme(page, theme);
    const stamp = `${theme}-${Date.now()}`;
    const title = `E2E ask item agreement ${stamp}`;
    // A line only this upload carries, so the stub's requests can be matched to this test.
    const id = await uploadThroughDashboard(
      page,
      title,
      `${FIXTURE_TEXT}\n\nAgreement reference: E2E-ASK-${stamp}.\n`,
    );

    await page.goto(`/contracts/${id}`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    const analysed = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/contracts/${id}/analyze`,
    );
    await page.getByRole("button", { name: "Start Analysis" }).click();
    expect((await analysed).status()).toBe(200);
    const checklist = page.getByRole("region", { name: "Before you sign: what to clarify" });
    await expect(checklist).toBeVisible({ timeout: 30_000 });

    const stored = await page.request.get(`/api/contracts/${id}`);
    expect(stored.status()).toBe(200);
    const before = (await stored.json()) as { analyses: { id: string; resultJson: unknown }[] };
    expect(before.analyses).toHaveLength(1);
    const analysisId = before.analyses[0]!.id;

    // Every finding and question has its own Ask link, holding only ids and the item's key.
    const [flag] = STUB_ANALYSIS_FLAGS;
    for (const [index, each] of STUB_ANALYSIS_FLAGS.entries())
      await expect(
        checklist.getByRole("link", { name: `Ask about finding: ${each.type}`, exact: true }),
      ).toHaveAttribute("href", `/dashboard?contract=${id}&analysis=${analysisId}&ask=finding-${index + 1}`);
    const ask = asksFinding
      ? checklist.getByRole("link", { name: `Ask about finding: ${flag.type}`, exact: true })
      : checklist.getByRole("link", { name: "Ask question 1", exact: true });
    const href = await ask.getAttribute("href");
    expect(href).toBe(
      `/dashboard?contract=${id}&analysis=${analysisId}&ask=${asksFinding ? "finding-1" : "question-1"}`,
    );
    for (const text of [title, flag.type, STUB_QUESTION]) expect(decodeURIComponent(href!)).not.toContain(text);
    await expectNoA11yViolations(page, { theme });

    const chatRequests = recordChatRequests(page);
    await ask.click();

    // The new chat names the contract and holds the drafted question, but sends nothing.
    await expect(page).toHaveURL(`${SIGNED_IN_ORIGIN}/dashboard`);
    const main = page.getByRole("main");
    const composer = page.getByRole("textbox", { name: "Chat message" });
    const draft = asksFinding
      ? `About “${title}”: Explain the finding “${flag.type}”: which clause it relies on, and what I should clarify before signing. Quote the clause, or say none was found.`
      : `About “${title}”: ${STUB_QUESTION} Answer from the contract and quote the clause you rely on.`;
    await expect(composer).toHaveValue(draft);
    await expect(main.getByRole("link", { name: title, exact: true })).toHaveAttribute(
      "href",
      `/contracts/${id}`,
    );
    await expectNoA11yViolations(page, { theme });
    expect(chatRequests).toEqual([]);

    const sentTurn = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/api/chat",
    );
    await page.getByRole("button", { name: "Send message" }).click();
    const turn = await sentTurn;
    expect(turn.status()).toBe(200);
    expect(turn.request().postDataJSON()).toMatchObject({ focusContractId: id });
    await expect(main.getByText(`Stub reply to: ${draft}`, { exact: true })).toBeVisible();

    // The model was told which contract the chat is about, and got no contract text.
    const reply = (await stubRequests(page)).find(
      (request) => request.kind === "reply" && request.question.includes(draft),
    );
    expect(reply).toBeDefined();
    expect(reply!.system).toContain(`This conversation is about one of the user's contracts, id ${id}.`);
    expect(reply!.system).not.toContain("Late payments accrue interest at 4% per month");

    // A reload opens a plain dashboard, not another draft.
    await page.reload();
    await expect(composer).toBeEnabled();
    await expect(page).toHaveURL(`${SIGNED_IN_ORIGIN}/dashboard`);
    expect(await composer.inputValue()).not.toContain(title);

    // Asking changed nothing about the analysis.
    const after = await page.request.get(`/api/contracts/${id}`);
    expect(((await after.json()) as typeof before).analyses).toEqual(before.analyses);

    expectNoCspViolations(violations, `asking about a Before you sign item (${theme} theme)`);
    expect(pageErrors).toEqual([]);
  });
}
