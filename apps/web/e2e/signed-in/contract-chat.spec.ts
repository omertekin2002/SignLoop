import { readFileSync } from "node:fs";
import { expect, test, type Page, type Request } from "@playwright/test";
import { THEMES, expectNoA11yViolations, startInTheme } from "../axe";
import { expectNoCspViolations, recordCspViolations } from "../csp";
import {
  STUB_CONTRACT_FIXTURE,
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
      data: { focus: { contractId: id, title }, messages: [{ role: "user" }, { role: "assistant" }] },
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
    await expect(main.getByRole("link", { name: title, exact: true })).toHaveAttribute(
      "href",
      `/contracts/${id}`,
    );
    await expect(composer).toHaveValue("");
    await expectNoA11yViolations(page, { theme });

    expectNoCspViolations(violations, `a saved chat about a contract (${theme} theme)`);
    expect(pageErrors).toEqual([]);
  });
}
