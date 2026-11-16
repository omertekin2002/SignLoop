import { expect, test, type Page } from "@playwright/test";
import { THEMES, expectNoA11yViolations, startInTheme } from "../axe";
import { expectNoCspViolations, recordCspViolations } from "../csp";
import { SIGNED_IN_ORIGIN } from "./env";

// Its own project, after the workspace project, because it adds contracts the empty-account checks
// there must not see. Running an analysis needs a model provider, so the contract's detail response
// is fulfilled with a stored analysis instead; everything else on the page is real.

test.beforeEach(async ({ context }) => {
  await context.route(
    (url) => url.origin !== SIGNED_IN_ORIGIN,
    (route) => route.abort("blockedbyclient"),
  );
});

const REVISION = `sha256:${"b".repeat(64)}`;
const QUOTE = "This agreement shall renew automatically for successive twelve-month terms.";

function storedAnalysis(contractId: string) {
  const source = {
    contract_id: contractId,
    revision: REVISION,
    index_unit: "unicode-code-points",
  };
  return {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    riskBadge: "HIGH",
    llmModel: "fixture",
    createdAt: "2026-11-01T09:30:00.000Z",
    resultJson: {
      source,
      coverage_notices: ["Only part of this contract was analysed: the middle pages were skipped."],
      comparisons_withheld: false,
      comparison_jurisdiction: null,
      proposed_jurisdiction: null,
      risk_badge: "HIGH",
      key_points: ["Renews automatically every year."],
      summary: {
        what_it_is: "A gym membership agreement.",
        payments: { amount: "£45", frequency: "Monthly", fees: [] },
        term: { start: null, end: null, minimum_term: "12 months" },
        renewal: { auto_renew: true, renewal_period: "12 months" },
        cancellation: {
          how: "Write to the club.",
          notice_period_days: 30,
          notice_period_text: null,
          penalties: [],
        },
      },
      red_flags: [
        {
          type: "Auto-renewal",
          severity: 7,
          explanation: "The membership renews for a further year unless cancelled in time.",
          where: "Clause 9.2",
          evidence: { quote: QUOTE, segment: "section-2" },
          citation: {
            ...source,
            status: "verified",
            quote: QUOTE,
            start: 120,
            end: 120 + QUOTE.length,
          },
          confidence: 85,
        },
      ],
      key_dates: [],
      obligations: [],
      parties: [],
      next_actions: { questions_to_ask: ["Can I cancel before the first year ends?"], email_templates: [] },
      disclaimer: "This is an AI analysis, not legal advice.",
    },
  };
}

// Creates a real contract, then serves its detail response with a stored analysis added.
async function contractWithAnalysis(page: Page, title: string): Promise<string> {
  const created = await page.request.post("/api/contracts", { data: { title } });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  await page.route(
    (url) => url.origin === SIGNED_IN_ORIGIN && url.pathname === `/api/contracts/${id}`,
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      const contract = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        json: {
          ...contract,
          status: "ANALYZED",
          extractionWarning: "Scanned pages were read with OCR.",
          analyses: [storedAnalysis(id)],
          analysesHasMore: false,
        },
      });
    },
  );
  return id;
}

for (const theme of THEMES) {
  test(`a contract page prints only its decision brief (${theme} theme)`, async ({ page }) => {
    await startInTheme(page, theme);
    const violations = await recordCspViolations(page);
    const title = `E2E print brief ${theme} ${Date.now()}`;
    const id = await contractWithAnalysis(page, title);

    await page.goto(`/contracts/${id}`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    const notes = page.getByRole("region", { name: "Your notes" });
    await expect(notes.getByLabel("Why I'd accept")).toBeEnabled();
    const printButton = page.getByRole("button", { name: "Print brief" });
    await expect(printButton).toBeVisible();
    await expect(page.getByRole("button", { name: "Download brief" })).toBeVisible();

    // On screen the brief stays out of sight, and the page meets the accessibility bar.
    const brief = page.locator("body > [data-print-brief]");
    await expect(brief).toHaveCount(1);
    await expect(brief).toBeHidden();
    await page.waitForLoadState("networkidle");
    await expectNoA11yViolations(page, { theme });

    // The button opens the browser's print dialog, and printing fetches nothing.
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.evaluate(() => {
      const printed = window as unknown as { __printed: number };
      printed.__printed = 0;
      window.print = () => {
        printed.__printed += 1;
      };
    });
    await printButton.click();
    expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);

    await page.emulateMedia({ media: "print" });
    await expect(brief).toBeVisible();
    await expect(
      brief.getByRole("heading", { level: 1, name: `Decision brief: ${title}` }),
    ).toBeVisible();
    for (const section of ["Coverage", "Jurisdiction", "Summary", "Findings", "Next steps"]) {
      await expect(brief.getByRole("heading", { level: 2, name: section })).toBeVisible();
    }
    await expect(brief.locator("blockquote")).toContainText(QUOTE);
    await expect(brief).toContainText("Scanned pages were read with OCR.");
    await expect(brief).toContainText("Only part of this contract was analysed");
    await expect(brief).toContainText(`Source revision: ${REVISION}`);

    // The interactive page is not printed.
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeHidden();
    await expect(printButton).toBeHidden();
    await expect(page.getByRole("button", { name: "Delete Contract" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Back to Dashboard" })).toBeHidden();
    await expect(notes).toBeHidden();

    // Dark text on white paper, whichever theme the page is in.
    const colors = await brief.evaluate((element) => ({
      text: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor,
      page: getComputedStyle(document.body).backgroundColor,
    }));
    expect(colors).toEqual({
      text: "rgb(26, 26, 26)",
      background: "rgb(255, 255, 255)",
      page: "rgb(255, 255, 255)",
    });

    expect(requests).toEqual([]);
    await page.emulateMedia({ media: "screen" });
    await expect(brief).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    expectNoCspViolations(violations, "a contract page with a printable brief");
  });
}
