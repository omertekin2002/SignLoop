import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { THEMES, expectNoA11yViolations, startInTheme } from "../axe";
import { expectNoCspViolations, recordCspViolations } from "../csp";
import {
  STUB_ANALYSIS_FLAGS,
  STUB_ANALYSIS_SUMMARY,
  STUB_CONTRACT_FIXTURE,
  STUB_FEE,
  STUB_FEE_QUOTE,
  STUB_KEY_DATE,
  STUB_KEY_DATE_DERIVED_FROM,
  STUB_KEY_DATE_QUOTE,
  STUB_MODEL,
  STUB_NOTICE_QUOTE,
  STUB_OBLIGATION,
  STUB_OBLIGATION_QUOTE,
  STUB_PAYMENT_QUOTE,
  STUB_PENALTY,
  STUB_PENALTY_QUOTE,
  STUB_QUESTION,
  STUB_RENEWAL_QUOTE,
  STUB_TERM_QUOTE,
  STUB_UNQUOTED_OBLIGATION,
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
      obligation_citations?: { obligation?: string; citation?: { status?: string; quote?: string } }[];
      key_date_citations?: { type?: string; date?: string; citation?: { status?: string; quote?: string } }[];
      summary?: {
        payments?: {
          payment_citation?: { status?: string; quote?: string } | null;
          fee_citations?: { fee?: string; citation?: { status?: string; quote?: string } }[];
        };
        term?: { term_citation?: { status?: string; quote?: string } | null };
        renewal?: { renewal_citation?: { status?: string; quote?: string } | null };
        cancellation?: {
          notice_citation?: { status?: string; quote?: string } | null;
          penalty_citations?: { penalty?: string; citation?: { status?: string; quote?: string } }[];
        };
      };
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
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function onScreen(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

// The stub's report as the contract page renders it: its summary and key points, the payment, the
// extra fee, the term, renewal, the notice period, the cancellation penalty, the obligation, the key date and every finding with
// the quotation the server verified, and the stub named as the model.
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
  // The first finding's quotation starts with the renewal clause, so match the renewal quotation's
  // own element: the block quote holding exactly that clause.
  await expect(onScreen(page.getByText("Auto-renews", { exact: true }))).toBeVisible();
  await expect(onScreen(page.getByText("Period: 12 months", { exact: true }))).toBeVisible();
  await expect(
    onScreen(page.locator("blockquote").filter({ hasText: new RegExp(`^“${escapeRegExp(STUB_RENEWAL_QUOTE)}”$`) })),
  ).toHaveCount(1);
  // The late-interest finding quotes the line after the payment clause, which also mentions
  // payments, so match the payment quotation's own element too.
  await expect(onScreen(page.getByText("1,200 GBP", { exact: true }))).toBeVisible();
  await expect(
    onScreen(page.locator("blockquote").filter({ hasText: new RegExp(`^“${escapeRegExp(STUB_PAYMENT_QUOTE)}”$`) })),
  ).toHaveCount(1);
  // The term card lists the minimum term and the start. The renewal and penalty lines right after the
  // term clause also speak of the term, so match the term quotation's own element.
  await expect(onScreen(page.getByText("12 months", { exact: true }))).toBeVisible();
  await expect(onScreen(page.getByText("Starts: The date of the order form", { exact: true }))).toBeVisible();
  await expect(
    onScreen(page.locator("blockquote").filter({ hasText: new RegExp(`^“${escapeRegExp(STUB_TERM_QUOTE)}”$`) })),
  ).toHaveCount(1);
  // The penalty is listed with its own quotation, in the same list item. The fixture's termination
  // line also ends with the notice clause's wording, so match the quotation's own element.
  const penalty = onScreen(page.getByRole("listitem").filter({ hasText: STUB_PENALTY }));
  await expect(penalty).toHaveCount(1);
  await expect(
    penalty.locator("blockquote").filter({ hasText: new RegExp(`^“${escapeRegExp(STUB_PENALTY_QUOTE)}”$`) }),
  ).toHaveCount(1);
  await expect(penalty.getByRole("button", { name: "View matched quotation of penalty 1" })).toBeVisible();
  // So is the fee, in the Payment fees section. Its clause sits right after the payment clause and
  // the late-interest finding's line, so match the list item holding exactly the fee's text and the
  // quotation's own element.
  const fees = page.getByRole("heading", { level: 3, name: "Payment fees", exact: true }).locator("xpath=..");
  const fee = onScreen(fees.getByRole("listitem").filter({ has: page.getByText(STUB_FEE, { exact: true }) }));
  await expect(fee).toHaveCount(1);
  await expect(
    fee.locator("blockquote").filter({ hasText: new RegExp(`^“${escapeRegExp(STUB_FEE_QUOTE)}”$`) }),
  ).toHaveCount(1);
  await expect(fee.getByRole("button", { name: "View matched quotation of fee 1" })).toBeVisible();
  // So is the obligation, in the Obligations section: the list item holding exactly its text and the
  // quotation's own element.
  const obligations = page.getByRole("heading", { level: 3, name: "Obligations", exact: true }).locator("xpath=..");
  const obligation = onScreen(
    obligations.getByRole("listitem").filter({ has: page.getByText(STUB_OBLIGATION, { exact: true }) }),
  );
  await expect(obligation).toHaveCount(1);
  await expect(
    obligation.locator("blockquote").filter({ hasText: new RegExp(`^“${escapeRegExp(STUB_OBLIGATION_QUOTE)}”$`) }),
  ).toHaveCount(1);
  await expect(obligation.getByRole("button", { name: "View matched quotation of obligation 1" })).toBeVisible();
  // So is the key date, in the Key Dates card, beside the analysis's own explanation, which is
  // labelled as such rather than shown as contract text.
  const keyDate = onScreen(
    page
      .getByRole("list", { name: "Key dates" })
      .getByRole("listitem")
      .filter({ has: page.getByText(STUB_KEY_DATE.date, { exact: true }) }),
  );
  await expect(keyDate).toHaveCount(1);
  await expect(keyDate.getByText("PRICE REVIEW", { exact: true })).toBeVisible();
  await expect(
    keyDate.getByText(`Analysis’s explanation: ${STUB_KEY_DATE_DERIVED_FROM}`, { exact: true }),
  ).toBeVisible();
  await expect(
    keyDate.locator("blockquote").filter({ hasText: new RegExp(`^“${escapeRegExp(STUB_KEY_DATE_QUOTE)}”$`) }),
  ).toHaveCount(1);
  await expect(keyDate.getByRole("button", { name: "View matched quotation of key date 1" })).toBeVisible();
  // The second obligation has no quotation, so it carries the marker, and only it does on the page.
  const unquoted = onScreen(
    obligations.getByRole("listitem").filter({ has: page.getByText(STUB_UNQUOTED_OBLIGATION, { exact: true }) }),
  );
  await expect(unquoted.getByText("No verified quotation", { exact: true })).toBeVisible();
  await expect(unquoted.locator("blockquote")).toHaveCount(0);
  await expect(onScreen(page.getByRole("button", { name: "View matched quotation of obligation 2" }))).toHaveCount(0);
  // Before you sign lists that obligation, every finding (highest severity first, each linking to its
  // entry in the Red Flags card) and the stub's question, which appears nowhere else.
  const checklist = page.getByRole("region", { name: "Before you sign" });
  await expect(checklist).toBeVisible();
  await expect(
    checklist.getByRole("listitem").filter({ hasText: `Obligation: ${STUB_UNQUOTED_OBLIGATION}` }),
  ).toContainText("No verified quotation");
  await expect(checklist.getByText("Every stated fact has a verified quotation", { exact: false })).toHaveCount(0);
  await expect(checklist.getByRole("link")).toHaveText(STUB_ANALYSIS_FLAGS.map(({ type }) => type));
  for (const [index, { type }] of STUB_ANALYSIS_FLAGS.entries()) {
    await expect(checklist.getByRole("link", { name: type, exact: true })).toHaveAttribute(
      "href",
      `#finding-${index + 1}`,
    );
  }
  await expect(checklist.getByRole("listitem").filter({ hasText: STUB_QUESTION })).toHaveCount(1);
  await expect(onScreen(page.getByText(STUB_QUESTION, { exact: true }))).toHaveCount(1);
  await expect(onScreen(page.getByRole("heading", { name: "Questions to Ask" }))).toHaveCount(1);
  await expect(onScreen(page.getByText("No verified quotation", { exact: true }))).toHaveCount(2);
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

    // So does renewal's quotation of the clause stating it.
    await page.getByRole("button", { name: "View matched quotation of the renewal clause" }).click();
    await expect(source.getByText("Quotation matched in the analyzed text. Highlighted below.")).toBeVisible();
    await expect(source.getByRole("region", { name: "Source passage" }).locator("mark")).toHaveText(STUB_RENEWAL_QUOTE);
    await page.keyboard.press("Escape");
    await expect(source).toBeHidden();

    // So does the payment's quotation of the clause stating its amount and frequency.
    await page.getByRole("button", { name: "View matched quotation of the payment clause" }).click();
    await expect(source.getByText("Quotation matched in the analyzed text. Highlighted below.")).toBeVisible();
    await expect(source.getByRole("region", { name: "Source passage" }).locator("mark")).toHaveText(STUB_PAYMENT_QUOTE);
    await page.keyboard.press("Escape");
    await expect(source).toBeHidden();

    // So does the term's quotation of the clause stating it.
    await page.getByRole("button", { name: "View matched quotation of the term clause" }).click();
    await expect(source.getByText("Quotation matched in the analyzed text. Highlighted below.")).toBeVisible();
    await expect(source.getByRole("region", { name: "Source passage" }).locator("mark")).toHaveText(STUB_TERM_QUOTE);
    await page.keyboard.press("Escape");
    await expect(source).toBeHidden();

    // So does the penalty's quotation of the clause stating it.
    await page.getByRole("button", { name: "View matched quotation of penalty 1" }).click();
    await expect(source.getByText("Quotation matched in the analyzed text. Highlighted below.")).toBeVisible();
    await expect(source.getByRole("region", { name: "Source passage" }).locator("mark")).toHaveText(STUB_PENALTY_QUOTE);
    await page.keyboard.press("Escape");
    await expect(source).toBeHidden();

    // So does the fee's quotation of the clause stating it.
    await page.getByRole("button", { name: "View matched quotation of fee 1" }).click();
    await expect(source.getByText("Quotation matched in the analyzed text. Highlighted below.")).toBeVisible();
    await expect(source.getByRole("region", { name: "Source passage" }).locator("mark")).toHaveText(STUB_FEE_QUOTE);
    await page.keyboard.press("Escape");
    await expect(source).toBeHidden();

    // So does the obligation's quotation of the clause stating it.
    await page.getByRole("button", { name: "View matched quotation of obligation 1" }).click();
    await expect(source.getByText("Quotation matched in the analyzed text. Highlighted below.")).toBeVisible();
    await expect(source.getByRole("region", { name: "Source passage" }).locator("mark")).toHaveText(
      STUB_OBLIGATION_QUOTE,
    );
    await page.keyboard.press("Escape");
    await expect(source).toBeHidden();

    // And the key date's quotation of the clause stating it.
    await page.getByRole("button", { name: "View matched quotation of key date 1" }).click();
    await expect(source.getByText("Quotation matched in the analyzed text. Highlighted below.")).toBeVisible();
    await expect(source.getByRole("region", { name: "Source passage" }).locator("mark")).toHaveText(
      STUB_KEY_DATE_QUOTE,
    );
    await page.keyboard.press("Escape");
    await expect(source).toBeHidden();

    // A fresh load reads the stored report back from the database.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
    await expectStubAnalysis(page);
    await page.waitForLoadState("networkidle");
    await expectNoA11yViolations(page, { theme });

    // A finding's link in Before you sign goes to that finding in the Red Flags card.
    const second = STUB_ANALYSIS_FLAGS[1];
    await page
      .getByRole("region", { name: "Before you sign" })
      .getByRole("link", { name: second.type, exact: true })
      .click();
    await expect(page).toHaveURL(`${SIGNED_IN_ORIGIN}/contracts/${id}#finding-2`);
    const target = page.locator("#red-flags").locator("#finding-2");
    await expect(target).toContainText(second.explanation);
    await expect(target).toBeInViewport();

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
    expect(stored.analyses[0]!.resultJson.summary?.renewal?.renewal_citation).toMatchObject({
      status: "verified",
      quote: STUB_RENEWAL_QUOTE,
    });
    expect(stored.analyses[0]!.resultJson.summary?.payments?.payment_citation).toMatchObject({
      status: "verified",
      quote: STUB_PAYMENT_QUOTE,
    });
    expect(stored.analyses[0]!.resultJson.summary?.term?.term_citation).toMatchObject({
      status: "verified",
      quote: STUB_TERM_QUOTE,
    });
    expect(stored.analyses[0]!.resultJson.summary?.cancellation?.penalty_citations).toEqual([
      {
        penalty: STUB_PENALTY,
        citation: expect.objectContaining({ status: "verified", quote: STUB_PENALTY_QUOTE }),
      },
    ]);

    expect(stored.analyses[0]!.resultJson.summary?.payments?.fee_citations).toEqual([
      {
        fee: STUB_FEE,
        citation: expect.objectContaining({ status: "verified", quote: STUB_FEE_QUOTE }),
      },
    ]);
    expect(stored.analyses[0]!.resultJson.obligation_citations).toEqual([
      {
        obligation: STUB_OBLIGATION,
        citation: expect.objectContaining({ status: "verified", quote: STUB_OBLIGATION_QUOTE }),
      },
    ]);
    expect(stored.analyses[0]!.resultJson.key_date_citations).toEqual([
      {
        ...STUB_KEY_DATE,
        citation: expect.objectContaining({ status: "verified", quote: STUB_KEY_DATE_QUOTE }),
      },
    ]);

    // The stub received exactly one analysis request for this contract, carrying its text.
    const received = (await stubRequests(page)).filter((request) => request.question.includes(reference));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ model: STUB_MODEL, kind: "analysis" });
    expect(received[0]!.question).toContain(contents.trim());

    expectNoCspViolations(violations, `an analysed contract page (${theme} theme)`);
    expect(pageErrors).toEqual([]);
  });
}
