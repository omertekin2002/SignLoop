import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api-client", () => ({
  apiClient: { get: mocks.get },
  getApiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

import { ContractDecisionSections } from "@/components/contract-decision-sections";
import { ContractSourceProvider } from "@/components/contract-source";
import type { AnalysisResult } from "@/lib/schemas";

const EMPTY_LIST = "None identified in this analysis.";
const OBLIGATIONS = "Obligations in the contract";
const TERM = "Term, renewal and how it ends";
const WITHHELD_TITLE = "Regional comparisons not shown";
const CONFIRMED_DESCRIPTION =
  "Compared with typical practice in the jurisdiction you confirmed. General information, not legal advice.";
const UNCONFIRMED_DESCRIPTION =
  "Generated without a confirmed jurisdiction — treat as general information, not local law.";

type Comparison = AnalysisResult["normal_in_region"][number];

const noticeComparison: Comparison = {
  topic: "Notice period",
  jurisdiction: "England and Wales",
  typical_range: "30–90 days",
  yours: "60 days",
  label: "typical",
};

function Sections({ result }: { result: unknown }) {
  return (
    <ContractDecisionSections
      contractId="11111111-2222-4333-8444-555555555555"
      // Saved reports and streamed partial results can hold values the schema would reject.
      result={result as Partial<AnalysisResult>}
      extractionWarning={null}
      riskBadge="MEDIUM"
      analyzedOn="Jan 2, 10:00"
      model={null}
      stale={false}
      jurisdiction={<h3>Jurisdiction</h3>}
    />
  );
}

function renderDetails(result: unknown) {
  return render(<Sections result={result} />);
}

/** A labelled group: the section holding the only heading with exactly this name. */
function section(heading: string, scope: HTMLElement = document.body) {
  const element = within(scope).getByRole("heading", { name: heading }).closest("section");
  if (!element) throw new Error(`No section for ${heading}`);
  return within(element);
}

/** One of the brief's groups, by its card title. */
function card(title: string) {
  return within(screen.getByRole("region", { name: title }));
}

function blankParagraphs(container: HTMLElement) {
  return Array.from(container.querySelectorAll("p")).filter(
    (paragraph) => !paragraph.textContent?.trim(),
  );
}

describe("ContractDecisionSections details", () => {
  it("renders parties, obligations, fees and the term's start and end once", () => {
    renderDetails({
      parties: ["Acme Ltd", "Jane Doe"],
      obligations: ["Pay rent monthly"],
      summary: {
        payments: { fees: ["Late fee of £25"] },
        term: { start: "2026-01-01", end: "2026-12-31" },
      },
    });

    expect(section("Parties").getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Acme Ltd",
      "Jane Doe",
    ]);
    expect(card(OBLIGATIONS).getByRole("listitem")).toHaveTextContent("Pay rent monthly");
    expect(section("Fees").getByRole("listitem")).toHaveTextContent("Late fee of £25");
    // The start and end appear once, in the Term group; the old "Term dates" box is gone.
    expect(section("Term").getByText("Starts: 2026-01-01")).toBeInTheDocument();
    expect(section("Term").getByText("Ends: 2026-12-31")).toBeInTheDocument();
    expect(card(TERM).getAllByText(/2026-01-01/)).toHaveLength(1);
    expect(card(TERM).getAllByText(/2026-12-31/)).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Term dates" })).toBeNull();
    // Only the key points and key dates are empty.
    expect(screen.getAllByText(EMPTY_LIST)).toHaveLength(2);
  });

  it("falls back for empty or non-string items and a missing term", () => {
    renderDetails({
      parties: [],
      obligations: ["", "   ", 42, null, { text: "Pay rent" }],
      summary: { payments: { fees: "Late fee" }, term: { start: null, end: "" } },
    });

    for (const group of [section("Parties"), section("Fees"), card(OBLIGATIONS)]) {
      expect(group.queryByRole("list")).not.toBeInTheDocument();
      expect(group.getByText(EMPTY_LIST)).toBeInTheDocument();
    }
    expect(section("Term").getByText("Not specified")).toBeInTheDocument();
    expect(section("Term").queryByText(/Starts:|Ends:/)).toBeNull();
  });

  it("keeps the string items of a mixed list", () => {
    renderDetails({ parties: ["Acme Ltd", 7, " ", "Jane Doe"] });

    expect(section("Parties").getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Acme Ltd",
      "Jane Doe",
    ]);
  });

  it("explains withheld regional comparisons", () => {
    renderDetails({ comparisons_withheld: true, normal_in_region: [noticeComparison] });

    const note = screen.getByRole("note");
    expect(within(note).getByText(WITHHELD_TITLE)).toBeInTheDocument();
    expect(note).toHaveTextContent(/No jurisdiction was confirmed when this analysis ran/);
    expect(screen.queryByText("Regional comparisons")).not.toBeInTheDocument();
    expect(screen.queryByText("Typical: 30–90 days")).not.toBeInTheDocument();
  });

  it("describes comparisons against a confirmed jurisdiction", () => {
    renderDetails({ comparisons_withheld: false, normal_in_region: [noticeComparison] });

    expect(screen.getByText("Regional comparisons")).toBeInTheDocument();
    const description = screen.getByText(CONFIRMED_DESCRIPTION);
    expect(description).not.toHaveClass("text-highlight");
    expect(screen.queryByText(UNCONFIRMED_DESCRIPTION)).not.toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    const item = section("Notice period (typical)");
    expect(item.getByText("Jurisdiction: England and Wales")).toBeInTheDocument();
    expect(item.getByText("Typical: 30–90 days")).toBeInTheDocument();
    expect(item.getByText("Your contract: 60 days")).toBeInTheDocument();
  });

  it("warns that comparisons from reports without the flag are unconfirmed", () => {
    renderDetails({
      normal_in_region: [{ ...noticeComparison, jurisdiction: null, yours: null, label: "unusual" }],
    });

    expect(screen.getByText(UNCONFIRMED_DESCRIPTION)).toHaveClass("text-highlight");
    expect(screen.queryByText(CONFIRMED_DESCRIPTION)).not.toBeInTheDocument();
    const item = section("Notice period (unusual)");
    expect(item.queryByText(/Jurisdiction:/)).not.toBeInTheDocument();
    expect(item.getByText("Your contract: Not specified")).toBeInTheDocument();
  });

  it("warns when a comparison lacks a jurisdiction even though one was confirmed", () => {
    renderDetails({
      comparisons_withheld: false,
      normal_in_region: [noticeComparison, { ...noticeComparison, topic: "Deposit", jurisdiction: "Unknown" }],
    });

    expect(screen.getByText(UNCONFIRMED_DESCRIPTION)).toBeInTheDocument();
    expect(screen.queryByText(CONFIRMED_DESCRIPTION)).not.toBeInTheDocument();
  });

  it("shows no comparison section when there are none", () => {
    renderDetails({ comparisons_withheld: false, normal_in_region: [] });

    expect(screen.queryByText("Regional comparisons")).not.toBeInTheDocument();
    expect(screen.queryByText(WITHHELD_TITLE)).not.toBeInTheDocument();
  });

  it("renders the disclaimer only when it is not blank", () => {
    const disclaimer = "This analysis is general information, not legal advice.";
    const { container, rerender } = renderDetails({ disclaimer });
    expect(screen.getByText(disclaimer)).toBeInTheDocument();

    rerender(<Sections result={{ disclaimer: "   " }} />);
    expect(screen.queryByText(disclaimer)).not.toBeInTheDocument();
    expect(blankParagraphs(container)).toHaveLength(0);

    rerender(<Sections result={{ disclaimer: 42 }} />);
    expect(blankParagraphs(container)).toHaveLength(0);
    expect(screen.queryByText("42")).not.toBeInTheDocument();
  });
});

describe("ContractDecisionSections fees", () => {
  const CONTRACT_ID = "11111111-2222-4333-8444-555555555555";
  const ANALYSIS_ID = "22222222-3333-4444-8555-666666666666";
  const REVISION = `sha256:${"a".repeat(64)}`;
  const SOURCE = {
    contract_id: CONTRACT_ID,
    revision: REVISION,
    index_unit: "unicode-code-points" as const,
  };
  const TEXT =
    "2. Fees. The Client pays 1,200 GBP monthly. A late payment fee of 50 GBP applies to invoices paid late. Set-up costs 300 GBP.";
  const LATE = "Late payment fee of 50 GBP";
  const LATE_QUOTE = "A late payment fee of 50 GBP applies to invoices paid late.";
  const SETUP = "Set-up fee of 300 GBP";
  const SETUP_QUOTE = "Set-up costs 300 GBP.";

  function citation(quote: string) {
    const start = TEXT.indexOf(quote);
    return { ...SOURCE, status: "verified" as const, quote, start, end: start + quote.length };
  }

  function renderFees(payments: Record<string, unknown>) {
    const result = { source: SOURCE, summary: { payments } };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <ContractSourceProvider contractId={CONTRACT_ID} analysisId={ANALYSIS_ID} result={result}>
          <Sections result={result} />
        </ContractSourceProvider>
      </QueryClientProvider>,
    );
  }

  const view = (index: number) => ({ name: `View matched quotation of fee ${index + 1}` });

  beforeEach(() => {
    mocks.get.mockReset();
  });

  it("shows each fee with its own verified quotation, and opens it in the source", async () => {
    mocks.get.mockResolvedValue({
      data: {
        contractId: CONTRACT_ID,
        revision: REVISION,
        text: TEXT,
        offset: 0,
        totalCharacters: TEXT.length,
        nextOffset: null,
        previousOffset: null,
        extractionWarning: null,
        highlight: citation(SETUP_QUOTE),
      },
    });
    renderFees({
      fees: [LATE, SETUP],
      // Listed in the other order, so nothing depends on position.
      fee_citations: [
        { fee: SETUP, citation: citation(SETUP_QUOTE) },
        { fee: LATE, citation: citation(LATE_QUOTE) },
      ],
      payment_citation: citation("The Client pays 1,200 GBP monthly."),
    });

    const [first, second] = section("Fees").getAllByRole("listitem");
    expect(within(first!).getByText(LATE)).toBeInTheDocument();
    expect(within(first!).getByText(`“${LATE_QUOTE}”`).tagName).toBe("BLOCKQUOTE");
    expect(within(first!).getByRole("button", view(0))).toBeInTheDocument();
    expect(within(second!).getByText(SETUP)).toBeInTheDocument();
    expect(within(second!).getByText(`“${SETUP_QUOTE}”`).tagName).toBe("BLOCKQUOTE");
    expect(screen.queryByText("No verified quotation")).not.toBeInTheDocument();
    // The payment amount's quotation is shown with the payment, never among the fees.
    expect(section("Fees").queryByText(/1,200 GBP/)).toBeNull();

    await userEvent.click(within(second!).getByRole("button", view(1)));
    const dialog = await screen.findByRole("dialog", { name: "Extracted contract text" });
    expect(
      await within(dialog).findByText("Quotation matched in the analyzed text. Highlighted below."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("region", { name: "Source passage" }).querySelector("mark"),
    ).toHaveTextContent(SETUP_QUOTE);
    expect(mocks.get).toHaveBeenCalledWith(
      `/contracts/${CONTRACT_ID}/source`,
      expect.objectContaining({
        params: { offset: 0, revision: REVISION, analysisId: ANALYSIS_ID, flag: "fee-1" },
      }),
    );
  });

  it("marks a fee without a verified quotation, never showing another fee's", () => {
    renderFees({
      fees: [LATE, SETUP],
      fee_citations: [{ fee: SETUP, citation: citation(SETUP_QUOTE) }],
    });
    const [first, second] = section("Fees").getAllByRole("listitem");
    expect(within(first!).getByText("No verified quotation")).toBeInTheDocument();
    expect(within(first!).queryByRole("button")).not.toBeInTheDocument();
    expect(within(first!).queryByText(/300 GBP\.”/)).toBeNull();
    expect(within(second!).getByRole("button", view(1))).toBeInTheDocument();
    expect(document.querySelectorAll("blockquote")).toHaveLength(1);
  });

  it.each([
    ["a report stored before fee quotations", undefined],
    ["no verified entries", []],
    ["a citation keyed by different text", [{ fee: LATE.toLowerCase(), citation: citation(LATE_QUOTE) }]],
    ["a citation stored as a penalty's", [{ penalty: LATE, citation: citation(LATE_QUOTE) }]],
    [
      "a citation for another revision",
      [{ fee: LATE, citation: { ...citation(LATE_QUOTE), revision: `sha256:${"b".repeat(64)}` } }],
    ],
  ])("marks a listed fee without a verified quotation: %s", (_label, citations) => {
    renderFees({ fees: [LATE], fee_citations: citations });
    expect(section("Fees").getByText(LATE)).toBeInTheDocument();
    expect(section("Fees").getByText("No verified quotation")).toBeInTheDocument();
    expect(screen.queryByRole("button", view(0))).not.toBeInTheDocument();
    expect(document.querySelector("blockquote")).toBeNull();
  });

  it.each([[[]], [undefined], [["  "]], ["not a list"]])(
    "keeps None identified with no fees: %j",
    (fees) => {
      renderFees({ fees, fee_citations: [{ fee: LATE, citation: citation(LATE_QUOTE) }] });
      expect(section("Fees").getByText(EMPTY_LIST)).toBeInTheDocument();
      expect(section("Fees").queryByRole("list")).not.toBeInTheDocument();
      expect(screen.queryByText("No verified quotation")).not.toBeInTheDocument();
      expect(document.querySelector("blockquote")).toBeNull();
    },
  );
});

describe("ContractDecisionSections obligations", () => {
  const CONTRACT_ID = "11111111-2222-4333-8444-555555555555";
  const ANALYSIS_ID = "22222222-3333-4444-8555-666666666666";
  const REVISION = `sha256:${"a".repeat(64)}`;
  const SOURCE = {
    contract_id: CONTRACT_ID,
    revision: REVISION,
    index_unit: "unicode-code-points" as const,
  };
  const TEXT =
    "1. Services. The Provider will design and host the Client's website. 2. Access. The Client gives the Provider access to its hosting account. 3. Fees. A late fee of 50 GBP applies.";
  const BUILD = "Design and host the Client's website";
  const BUILD_QUOTE = "The Provider will design and host the Client's website.";
  const ACCESS = "Give the Provider access to the hosting account";
  const ACCESS_QUOTE = "The Client gives the Provider access to its hosting account.";
  const LATE = "Late fee of 50 GBP";

  function citation(quote: string) {
    const start = TEXT.indexOf(quote);
    return { ...SOURCE, status: "verified" as const, quote, start, end: start + quote.length };
  }

  function renderObligations(fields: Record<string, unknown>) {
    const result = { source: SOURCE, ...fields };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <ContractSourceProvider contractId={CONTRACT_ID} analysisId={ANALYSIS_ID} result={result}>
          <Sections result={result} />
        </ContractSourceProvider>
      </QueryClientProvider>,
    );
  }

  const view = (index: number) => ({ name: `View matched quotation of obligation ${index + 1}` });

  beforeEach(() => {
    mocks.get.mockReset();
  });

  it("shows each obligation with its own verified quotation, and opens it in the source", async () => {
    mocks.get.mockResolvedValue({
      data: {
        contractId: CONTRACT_ID,
        revision: REVISION,
        text: TEXT,
        offset: 0,
        totalCharacters: TEXT.length,
        nextOffset: null,
        previousOffset: null,
        extractionWarning: null,
        highlight: citation(ACCESS_QUOTE),
      },
    });
    renderObligations({
      parties: ["Provider", "Client"],
      obligations: [BUILD, ACCESS],
      // Listed in the other order, so nothing depends on position.
      obligation_citations: [
        { obligation: ACCESS, citation: citation(ACCESS_QUOTE) },
        { obligation: BUILD, citation: citation(BUILD_QUOTE) },
      ],
      summary: { payments: { fees: [LATE] } },
    });

    const [first, second] = card(OBLIGATIONS).getAllByRole("listitem");
    expect(within(first!).getByText(BUILD)).toBeInTheDocument();
    expect(within(first!).getByText(`“${BUILD_QUOTE}”`).tagName).toBe("BLOCKQUOTE");
    expect(within(first!).getByRole("button", view(0))).toBeInTheDocument();
    expect(within(second!).getByText(ACCESS)).toBeInTheDocument();
    expect(within(second!).getByText(`“${ACCESS_QUOTE}”`).tagName).toBe("BLOCKQUOTE");
    // Parties stay a plain list, and the uncited fee keeps its own marker.
    expect(section("Parties").getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Provider",
      "Client",
    ]);
    expect(section("Parties").queryByRole("button")).toBeNull();
    expect(card(OBLIGATIONS).queryByText("No verified quotation")).toBeNull();
    expect(section("Fees").getByText("No verified quotation")).toBeInTheDocument();

    await userEvent.click(within(second!).getByRole("button", view(1)));
    const dialog = await screen.findByRole("dialog", { name: "Extracted contract text" });
    expect(
      await within(dialog).findByText("Quotation matched in the analyzed text. Highlighted below."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("region", { name: "Source passage" }).querySelector("mark"),
    ).toHaveTextContent(ACCESS_QUOTE);
    expect(mocks.get).toHaveBeenCalledWith(
      `/contracts/${CONTRACT_ID}/source`,
      expect.objectContaining({
        params: { offset: 0, revision: REVISION, analysisId: ANALYSIS_ID, flag: "obligation-1" },
      }),
    );
  });

  it("marks an obligation without a verified quotation, never showing another obligation's", () => {
    renderObligations({
      obligations: [BUILD, ACCESS],
      obligation_citations: [{ obligation: ACCESS, citation: citation(ACCESS_QUOTE) }],
    });
    const [first, second] = card(OBLIGATIONS).getAllByRole("listitem");
    expect(within(first!).getByText("No verified quotation")).toBeInTheDocument();
    expect(within(first!).queryByRole("button")).not.toBeInTheDocument();
    expect(within(first!).queryByText(/website\.”/)).toBeNull();
    expect(within(second!).getByRole("button", view(1))).toBeInTheDocument();
    expect(document.querySelectorAll("blockquote")).toHaveLength(1);
  });

  it.each([
    ["a report stored before obligation quotations", undefined],
    ["no verified entries", []],
    [
      "a citation keyed by different text",
      [{ obligation: BUILD.toLowerCase(), citation: citation(BUILD_QUOTE) }],
    ],
    ["a citation stored as a fee's", [{ fee: BUILD, citation: citation(BUILD_QUOTE) }]],
    [
      "a citation for another revision",
      [
        {
          obligation: BUILD,
          citation: { ...citation(BUILD_QUOTE), revision: `sha256:${"b".repeat(64)}` },
        },
      ],
    ],
  ])("marks a listed obligation without a verified quotation: %s", (_label, citations) => {
    renderObligations({ obligations: [BUILD], obligation_citations: citations });
    expect(card(OBLIGATIONS).getByText(BUILD)).toBeInTheDocument();
    expect(card(OBLIGATIONS).getByText("No verified quotation")).toBeInTheDocument();
    expect(screen.queryByRole("button", view(0))).not.toBeInTheDocument();
    expect(document.querySelector("blockquote")).toBeNull();
  });

  it.each([[[]], [undefined], [["  "]], ["not a list"]])(
    "keeps None identified with no obligations: %j",
    (obligations) => {
      renderObligations({
        obligations,
        obligation_citations: [{ obligation: BUILD, citation: citation(BUILD_QUOTE) }],
      });
      expect(card(OBLIGATIONS).getByText(EMPTY_LIST)).toBeInTheDocument();
      expect(card(OBLIGATIONS).queryByRole("list")).not.toBeInTheDocument();
      expect(screen.queryByText("No verified quotation")).not.toBeInTheDocument();
      expect(document.querySelector("blockquote")).toBeNull();
    },
  );
});

describe("ContractDecisionSections layout", () => {
  const CONTRACT_ID = "11111111-2222-4333-8444-555555555555";
  const ANALYSIS_ID = "22222222-3333-4444-8555-666666666666";
  const REVISION = `sha256:${"a".repeat(64)}`;
  const SOURCE = {
    contract_id: CONTRACT_ID,
    revision: REVISION,
    index_unit: "unicode-code-points" as const,
  };
  const ORDER = [
    "Overview",
    "Jurisdiction",
    "Before you sign: what to clarify",
    "Payments and fees",
    TERM,
    OBLIGATIONS,
    "Key dates",
    "Findings and draft emails",
  ];
  const QUOTES = {
    payment: "The Client pays 1,200 GBP each month.",
    fee: "A late payment fee of 50 GBP applies.",
    term: "The agreement lasts at least 12 months.",
    renewal: "It renews automatically for further 12-month terms.",
    notice: "Either party may end it with 60 days' written notice.",
    penalty: "Ending early costs two months' fees.",
    obligation: "The Provider will host the Client's website.",
    keyDate: "The fee is reviewed on 1 April each year.",
    finding: "Interest of 8% accrues on late invoices.",
  };
  const KEY_POINT = "The agreement renews automatically.";
  const COVERAGE = "Only part of this contract was analysed.";
  const QUESTION = "Can the late-payment interest be reduced?";
  const EMAIL_SUBJECT = "Question about renewal";

  function citation(quote: string) {
    return { ...SOURCE, status: "verified" as const, quote, start: 0, end: quote.length };
  }

  // Every fact with a value, quoted or not.
  function report(cited: boolean) {
    const cite = (quote: string) => (cited ? citation(quote) : undefined);
    return {
      source: SOURCE,
      risk_badge: "MEDIUM",
      key_points: [KEY_POINT, COVERAGE],
      coverage_notices: [COVERAGE],
      parties: ["Example Studio Ltd", "The Client"],
      summary: {
        what_it_is: "A website services agreement.",
        payments: {
          amount: "1,200 GBP",
          frequency: "Monthly",
          payment_citation: cite(QUOTES.payment),
          fees: ["Late payment fee of 50 GBP"],
          fee_citations: cited
            ? [{ fee: "Late payment fee of 50 GBP", citation: citation(QUOTES.fee) }]
            : [],
        },
        term: {
          start: "The date of the order form",
          end: null,
          minimum_term: "12 months",
          term_citation: cite(QUOTES.term),
        },
        renewal: { auto_renew: true, renewal_period: "Yearly", renewal_citation: cite(QUOTES.renewal) },
        cancellation: {
          how: "Written notice before the end of the term.",
          notice_period_days: 60,
          notice_period_text: "60 days",
          notice_citation: cite(QUOTES.notice),
          penalties: ["Two months' fees"],
          penalty_citations: cited
            ? [{ penalty: "Two months' fees", citation: citation(QUOTES.penalty) }]
            : [],
        },
      },
      obligations: ["Host the Client's website"],
      obligation_citations: cited
        ? [{ obligation: "Host the Client's website", citation: citation(QUOTES.obligation) }]
        : [],
      key_dates: [{ type: "PRICE_REVIEW", date: "1 April each year", derived_from: "The Fees clause" }],
      key_date_citations: cited
        ? [{ type: "PRICE_REVIEW", date: "1 April each year", citation: citation(QUOTES.keyDate) }]
        : [],
      red_flags: [
        {
          type: "Late interest",
          severity: 6,
          explanation: "Late invoices accrue interest.",
          where: "Fees",
          confidence: 80,
          citation: cite(QUOTES.finding),
        },
        { type: "Auto-renewal", severity: 8, explanation: "It renews by default.", where: null, confidence: 90 },
      ],
      next_actions: {
        questions_to_ask: [QUESTION],
        email_templates: [{ subject: EMAIL_SUBJECT, body: "Hello, could we discuss the renewal?" }],
      },
      normal_in_region: [],
      disclaimer: "This is an AI analysis, not legal advice.",
    };
  }

  function renderPage(
    result: unknown,
    props: Partial<Parameters<typeof ContractDecisionSections>[0]> = {},
  ) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <ContractSourceProvider contractId={CONTRACT_ID} analysisId={ANALYSIS_ID} result={result}>
          <ContractDecisionSections
            contractId={CONTRACT_ID}
            result={result as Partial<AnalysisResult>}
            extractionWarning={null}
            riskBadge="MEDIUM"
            analyzedOn="Jan 2, 10:00"
            model="Primary provider • e2e-stub"
            stale={false}
            jurisdiction={<h3>Jurisdiction</h3>}
            {...props}
          />
        </ContractSourceProvider>
      </QueryClientProvider>,
    );
  }

  const cardTitles = () =>
    screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);

  const quoteIn = (scope: ReturnType<typeof within>, quote: string) =>
    scope.getByText(`“${quote}”`, { exact: true });

  beforeEach(() => {
    mocks.get.mockReset();
  });

  it("orders the cards like the brief's sections, without the old card names", () => {
    renderPage(report(true));
    expect(cardTitles()).toEqual(ORDER);
    for (const old of [
      "Contract Summary",
      "Cancellation Terms",
      "Parties and obligations",
      "Recommended Actions",
      "Risk Assessment",
      "Key Findings",
    ]) {
      expect(screen.queryByRole("heading", { name: old })).toBeNull();
    }
    expect(screen.queryByRole("heading", { name: /^Red Flags/ })).toBeNull();
  });

  it("shows regional comparisons right after the Jurisdiction card", () => {
    renderPage({
      ...report(true),
      comparisons_withheld: false,
      normal_in_region: [
        { topic: "Notice period", jurisdiction: "England and Wales", typical_range: "30–90 days", yours: "60 days", label: "typical" },
      ],
    });
    expect(cardTitles()).toEqual([...ORDER.slice(0, 2), "Regional comparisons", ...ORDER.slice(2)]);
  });

  it("shows every cited fact once, in its group, with its own quotation", () => {
    renderPage(report(true));
    const payments = card("Payments and fees");
    const term = card(TERM);

    expect(section("Payment").getByText("1,200 GBP")).toBeInTheDocument();
    expect(payments.getByText("Monthly")).toBeInTheDocument();
    quoteIn(section("Payment"), QUOTES.payment);
    quoteIn(section("Fees"), QUOTES.fee);
    expect(section("Term").getByText("12 months")).toBeInTheDocument();
    expect(section("Term").getByText("Starts: The date of the order form")).toBeInTheDocument();
    quoteIn(section("Term"), QUOTES.term);
    expect(section("Renewal").getByText("Auto-renews")).toBeInTheDocument();
    quoteIn(section("Renewal"), QUOTES.renewal);
    const cancellation = section("Cancellation");
    expect(cancellation.getByText("Written notice before the end of the term.")).toBeInTheDocument();
    expect(cancellation.getByText("60 days")).toBeInTheDocument();
    quoteIn(cancellation, QUOTES.notice);
    quoteIn(cancellation, QUOTES.penalty);
    expect(term.getByRole("button", { name: "View matched quotation of penalty 1" })).toBeInTheDocument();
    quoteIn(card(OBLIGATIONS), QUOTES.obligation);
    expect(card(OBLIGATIONS).getByText("This analysis does not record which party owes each obligation.")).toBeInTheDocument();
    const keyDates = within(card("Key dates").getByRole("list", { name: "Key dates" }));
    expect(keyDates.getByText("PRICE REVIEW")).toBeInTheDocument();
    expect(keyDates.getByText("Analysis’s explanation: The Fees clause")).toBeInTheDocument();
    quoteIn(keyDates, QUOTES.keyDate);
    quoteIn(within(document.getElementById("finding-1")!), QUOTES.finding);

    // Each quotation once on the page, and no fact is marked as unquoted.
    for (const quote of Object.values(QUOTES)) {
      expect(screen.getAllByText(`“${quote}”`, { exact: true })).toHaveLength(1);
    }
    expect(document.querySelectorAll("blockquote")).toHaveLength(Object.keys(QUOTES).length);
    expect(screen.queryByText("No verified quotation", { exact: true })).toBeNull();
  });

  it("marks every stated fact without a quotation in its group, never in the Overview", () => {
    renderPage(report(false));
    const marker = "No verified quotation";
    for (const group of [
      section("Payment"),
      section("Fees"),
      section("Term"),
      section("Renewal"),
      card(OBLIGATIONS),
      card("Key dates"),
    ]) {
      expect(group.getAllByText(marker, { exact: true })).toHaveLength(1);
    }
    // The notice period and the penalty.
    expect(section("Cancellation").getAllByText(marker, { exact: true })).toHaveLength(2);
    expect(card("Overview").queryByText(marker)).toBeNull();
    expect(within(document.getElementById("finding-1")!).getByText("Verified source quotation unavailable.")).toBeInTheDocument();
    expect(document.querySelector("blockquote")).toBeNull();
    // Each value is shown once in its group; Before you sign lists the same facts to clarify.
    expect(card("Payments and fees").getAllByText("1,200 GBP")).toHaveLength(1);
    expect(card(TERM).getAllByText("12 months")).toHaveLength(1);
    expect(card(OBLIGATIONS).getAllByText("Host the Client's website")).toHaveLength(1);
  });

  it("keeps every group visible with an honest empty state", () => {
    renderPage({ source: SOURCE });
    expect(cardTitles()).toEqual(ORDER);
    expect(section("What it is").getByText("Not specified")).toBeInTheDocument();
    expect(section("Parties").getByText(EMPTY_LIST)).toBeInTheDocument();
    expect(section("Key points").getByText(EMPTY_LIST)).toBeInTheDocument();
    expect(section("Payment").getByText("Not specified")).toBeInTheDocument();
    expect(section("Fees").getByText(EMPTY_LIST)).toBeInTheDocument();
    expect(section("Term").getByText("Not specified")).toBeInTheDocument();
    expect(section("Renewal").getByText("Not specified")).toBeInTheDocument();
    expect(section("How to cancel").getByText("Not specified")).toBeInTheDocument();
    expect(section("Notice period").getByText("Not specified")).toBeInTheDocument();
    expect(section("Penalties").getByText("None listed")).toBeInTheDocument();
    expect(card(OBLIGATIONS).getByText(EMPTY_LIST)).toBeInTheDocument();
    expect(card("Key dates").getByText(EMPTY_LIST)).toBeInTheDocument();
    expect(card("Key dates").queryByRole("list")).toBeNull();
    const findings = card("Findings and draft emails");
    expect(findings.getByText("No red flags were identified in this analysis.")).toBeInTheDocument();
    expect(findings.getByText("No draft emails were suggested in this analysis.")).toBeInTheDocument();
  });

  it("puts questions only in Before you sign and draft emails only under Findings and draft emails", () => {
    renderPage(report(true));
    expect(screen.getAllByText(QUESTION, { exact: true })).toHaveLength(1);
    expect(card("Before you sign: what to clarify").getByText(QUESTION, { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText(`Subject: ${EMAIL_SUBJECT}`)).toHaveLength(1);
    expect(section("Draft emails").getByText(`Subject: ${EMAIL_SUBJECT}`)).toBeInTheDocument();
  });

  it("keeps #red-flags and each finding's anchor, which Before you sign links to", () => {
    renderPage(report(true));
    const findings = document.getElementById("red-flags");
    expect(findings).toBe(screen.getByRole("region", { name: "Findings and draft emails" }));
    const links = within(screen.getByRole("region", { name: "Before you sign: what to clarify" })).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["#finding-2", "#finding-1"]);
    for (const link of links) {
      const target = findings!.querySelector(link.getAttribute("href")!);
      expect(target).not.toBeNull();
    }
    expect(within(findings!.querySelector<HTMLElement>("#finding-2")!).getByText("It renews by default.")).toBeInTheDocument();
  });

  it("shows the risk, analysis date, model, notices and key points in the Overview", () => {
    renderPage(report(true), { extractionWarning: "Scanned pages were read with OCR.", stale: true });
    const overview = card("Overview");
    expect(overview.getByText("MEDIUM")).toBeInTheDocument();
    expect(overview.getByText("Analyzed on Jan 2, 10:00")).toBeInTheDocument();
    expect(overview.getByText("LLM: Primary provider • e2e-stub")).toBeInTheDocument();
    expect(overview.getByText("A website services agreement.")).toBeInTheDocument();
    // The coverage notice is shown as a notice, not repeated as a key point.
    expect(within(section("Key points").getAllByRole("list")[1]!).getAllByRole("listitem").map((item) => item.textContent)).toEqual([KEY_POINT]);
    expect(overview.getByText(COVERAGE)).toBeInTheDocument();
    expect(overview.getByText(/This analysis uses older evidence/)).toBeInTheDocument();
    expect(overview.queryByText("Scanned pages were read with OCR.")).toBeNull();
  });
});
