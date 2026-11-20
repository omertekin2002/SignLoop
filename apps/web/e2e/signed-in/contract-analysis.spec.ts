import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { THEMES, expectNoA11yViolations, startInTheme } from "../axe";
import { expectNoCspViolations, recordCspViolations } from "../csp";
import {
  STUB_ANALYSIS_FLAGS,
  STUB_ANALYSIS_SUMMARY,
  STUB_CONTRACT_FIXTURE,
  STUB_MODEL,
  STUB_NOTICE_QUOTE,
  type StubModelRequest,
} from "../stub-model-server";
import { openDashboard, openSidebar } from "./dashboard";
import { E2E_MODEL_STUB_URL, SIGNED_IN_ORIGIN } from "./env";

// Its own project, after the workspace project, because it adds analysed contracts. The app's model
// is the local stub (e2e/stub-model-server.ts, started by global-setup.ts), so each test runs the
// real analysis path: the dashboard's upload, the analyze route, the stub's JSON answer, the
// server's check of each quotation against the extracted text, the stored report, and the page that
// renders it from the database after a reload.

test.beforeEach(async ({ context }) => {
  // The stub is reached by the server, never by the page, so the page still talks only to its
  // own origin.
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

async function stubRequests(page: Page): Promise<StubModelRequest[]> {
  // From the test process, not the page: the stub listens on 127.0.0.1 for the server only.
  const response = await page.context().request.get(`${E2E_MODEL_STUB_URL}/__e2e/requests`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: StubModelRequest[] }).data;
}

type StoredContract = {
  status: string;
  analyses: {
    llmModel: string | null;
    llmProvider: string | null;
    resultJson: {
      red_flags?: { citation?: { status?: string; quote?: string } | null }[];
      summary?: { cancellation?: { notice_citation?: { status?: string; quote?: string } | null } };
    };
  }[];
};

// Uploads the fixture through the dashboard's upload dialog and returns the new contract's id.
async function uploadThroughDashboard(page: Page, title: string, contents: string): Promise<string> {
  await openDashboard(page);
  await openSidebar(page);
  await page.getByRole("button", { name: "Contracts", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Contracts" })).toBeVisible();
  await page.getByRole("button", { name: "New Contract" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Upload Contract" });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "e2e-services-agreement.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(contents),
  });
  await expect(dialog.getByLabel("Contract Name")).toHaveValue("e2e-services-agreement");
  await dialog.getByLabel("Contract Name").fill(title);

  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/contracts",
  );
  await dialog.getByRole("button", { name: "Upload Contract" }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const { id } = (await response.json()) as { id: string };
  await expect(page.getByText("Contract uploaded successfully")).toBeVisible();
  await expect(dialog).toBeHidden();
  return id;
}

// The contract page has no <main> landmark, and its printable brief repeats the report in a hidden
// element, so the checks below look only at what is on screen.
function onScreen(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

// The stub's report as the contract page renders it: its summary and key points, the notice period
// and every finding with the quotation the server verified, and the stub named as the model.
async function expectStubAnalysis(page: Page) {
  await expect(onScreen(page.getByText(STUB_ANALYSIS_SUMMARY, { exact: true }))).toBeVisible();
  await expect(
    onScreen(page.getByText("Stub key point: the agreement renews automatically each year.", { exact: true })),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: `Red Flags (${STUB_ANALYSIS_FLAGS.length})` })).toBeVisible();
  for (const { explanation, quote } of STUB_ANALYSIS_FLAGS) {
    await expect(onScreen(page.getByText(explanation, { exact: true }))).toBeVisible();
    await expect(onScreen(page.locator("blockquote").filter({ hasText: quote }))).toHaveText(`“${quote}”`);
  }
  await expect(onScreen(page.getByText("Verified source quotation unavailable."))).toHaveCount(0);
  // The first finding quotes the whole sentence, which contains the notice clause, so match from the
  // opening quotation mark.
  await expect(onScreen(page.locator("blockquote").filter({ hasText: `“${STUB_NOTICE_QUOTE}` }))).toHaveText(
    `“${STUB_NOTICE_QUOTE}”`,
  );
  await expect(onScreen(page.getByText("No verified quotation", { exact: true }))).toHaveCount(0);
  await expect(onScreen(page.getByText(`LLM: Primary provider • ${STUB_MODEL}`, { exact: true }))).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-run Analysis" })).toBeEnabled();
}

for (const theme of THEMES) {
  test(`a contract uploaded on the dashboard is analysed by the model, and its cited findings load after a reload (${theme} theme)`, async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    const violations = await recordCspViolations(page);
    await startInTheme(page, theme);
    const stamp = `${theme}-${Date.now()}`;
    const title = `E2E analysed contract ${stamp}`;
    // A line only this upload carries, so the stub's requests can be matched to this test (CI
    // retries and other themes analyse the same fixture).
    const reference = `Agreement reference: E2E-${stamp}.`;
    const contents = `${FIXTURE_TEXT}\n\n${reference}\n`;

    const id = await uploadThroughDashboard(page, title, contents);
    const card = page.getByRole("main").getByRole("link").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
    await card.click();
    await page.waitForURL(`${SIGNED_IN_ORIGIN}/contracts/${id}`);
    await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "No Analysis Yet" })).toBeVisible();

    // Start Analysis runs the real route against the stub; the page refreshes itself when it ends.
    const analysed = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/contracts/${id}/analyze`,
    );
    await page.getByRole("button", { name: "Start Analysis" }).click();
    expect((await analysed).status()).toBe(200);
    await expect(page.getByText("Analysis complete", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expectStubAnalysis(page);
    await expect(onScreen(page.getByText("ANALYZED", { exact: true }))).toBeVisible();

    // A finding's quotation opens the extracted text with that passage highlighted.
    const [first] = STUB_ANALYSIS_FLAGS;
    await page.getByRole("button", { name: "View matched quotation for finding 1" }).click();
    const source = page.getByRole("dialog", { name: "Extracted contract text" });
    await expect(source.getByText("Quotation matched in the analyzed text. Highlighted below.")).toBeVisible();
    await expect(source.getByRole("region", { name: "Source passage" }).locator("mark")).toHaveText(first.quote);
    await page.keyboard.press("Escape");
    await expect(source).toBeHidden();

    // So does the notice period's quotation of the clause stating it.
    await page.getByRole("button", { name: "View matched quotation of the notice-period clause" }).click();
    await expect(source.getByText("Quotation matched in the analyzed text. Highlighted below.")).toBeVisible();
    await expect(source.getByRole("region", { name: "Source passage" }).locator("mark")).toHaveText(STUB_NOTICE_QUOTE);
    await page.keyboard.press("Escape");
    await expect(source).toBeHidden();

    // A fresh load reads the stored report back from the database.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
    await expectStubAnalysis(page);
    await page.waitForLoadState("networkidle");
    await expectNoA11yViolations(page, { theme });

    // One report is stored, from the stub, and every finding kept its verified citation.
    const response = await page.request.get(`/api/contracts/${id}`);
    expect(response.status()).toBe(200);
    const stored = (await response.json()) as StoredContract;
    expect(stored.status).toBe("ANALYZED");
    expect(stored.analyses).toHaveLength(1);
    expect(stored.analyses[0]).toMatchObject({ llmModel: STUB_MODEL, llmProvider: "primary-openai-compatible" });
    expect(stored.analyses[0]!.resultJson.red_flags?.map((flag) => flag.citation)).toEqual(
      STUB_ANALYSIS_FLAGS.map(({ quote }) => expect.objectContaining({ status: "verified", quote })),
    );
    expect(stored.analyses[0]!.resultJson.summary?.cancellation?.notice_citation).toMatchObject({
      status: "verified",
      quote: STUB_NOTICE_QUOTE,
    });

    // The stub received exactly one analysis request for this contract, carrying its text.
    const received = (await stubRequests(page)).filter((request) => request.question.includes(reference));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ model: STUB_MODEL, kind: "analysis" });
    expect(received[0]!.question).toContain(contents.trim());

    expectNoCspViolations(violations, `an analysed contract page (${theme} theme)`);
    expect(pageErrors).toEqual([]);
  });
}
