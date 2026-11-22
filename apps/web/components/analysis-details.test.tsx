import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api-client", () => ({
  apiClient: { get: mocks.get },
  getApiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

import { AnalysisDetails } from "@/components/analysis-details";
import { ContractSourceProvider } from "@/components/contract-source";
import type { AnalysisResult } from "@/lib/schemas";

const EMPTY_LIST = "None identified in this analysis.";
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

// Saved reports and streamed partial results can hold values the schema would reject.
function renderDetails(result: unknown) {
  return render(<AnalysisDetails result={result as Partial<AnalysisResult>} />);
}

function section(heading: string) {
  const element = screen.getByRole("heading", { name: heading }).closest("section");
  if (!element) throw new Error(`No section for ${heading}`);
  return within(element);
}

function blankParagraphs(container: HTMLElement) {
  return Array.from(container.querySelectorAll("p")).filter(
    (paragraph) => !paragraph.textContent?.trim(),
  );
}

describe("AnalysisDetails", () => {
  it("renders parties, obligations, fees and term dates", () => {
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
    expect(section("Obligations").getByRole("listitem")).toHaveTextContent("Pay rent monthly");
    expect(section("Payment fees").getByRole("listitem")).toHaveTextContent("Late fee of £25");
    expect(section("Term dates").getByText("Start: 2026-01-01")).toBeInTheDocument();
    expect(section("Term dates").getByText("End: 2026-12-31")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_LIST)).not.toBeInTheDocument();
  });

  it("falls back for empty or non-string items and missing term dates", () => {
    renderDetails({
      parties: [],
      obligations: ["", "   ", 42, null, { text: "Pay rent" }],
      summary: { payments: { fees: "Late fee" }, term: { start: null, end: "" } },
    });

    for (const heading of ["Parties", "Obligations", "Payment fees"]) {
      expect(section(heading).queryByRole("list")).not.toBeInTheDocument();
      expect(section(heading).getByText(EMPTY_LIST)).toBeInTheDocument();
    }
    expect(section("Term dates").getByText("Start: Not specified")).toBeInTheDocument();
    expect(section("Term dates").getByText("End: Not specified")).toBeInTheDocument();
  });

  it("keeps the string items of a mixed list", () => {
    renderDetails({ parties: ["Acme Ltd", 7, " ", "Jane Doe"] });

    expect(section("Parties").getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Acme Ltd",
      "Jane Doe",
    ]);
  });

  it("shows term dates as not specified when the summary is missing", () => {
    renderDetails({});

    expect(screen.getByText("Start: Not specified")).toBeInTheDocument();
    expect(screen.getByText("End: Not specified")).toBeInTheDocument();
    expect(screen.getAllByText(EMPTY_LIST)).toHaveLength(3);
  });

  it("explains withheld regional comparisons", () => {
    renderDetails({ comparisons_withheld: true, normal_in_region: [noticeComparison] });

    const note = screen.getByRole("note");
    expect(within(note).getByText(WITHHELD_TITLE)).toBeInTheDocument();
    expect(note).toHaveTextContent(/No jurisdiction was confirmed when this analysis ran/);
    expect(screen.queryByText("Regional comparisons")).not.toBeInTheDocument();
    expect(screen.queryByText(/Notice period/)).not.toBeInTheDocument();
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

    rerender(<AnalysisDetails result={{ disclaimer: "   " }} />);
    expect(screen.queryByText(disclaimer)).not.toBeInTheDocument();
    expect(blankParagraphs(container)).toHaveLength(0);

    rerender(<AnalysisDetails result={{ disclaimer: 42 } as unknown as Partial<AnalysisResult>} />);
    expect(blankParagraphs(container)).toHaveLength(0);
    expect(screen.queryByText("42")).not.toBeInTheDocument();
  });
});

describe("AnalysisDetails payment fees", () => {
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
          <AnalysisDetails result={result as Partial<AnalysisResult>} />
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

    const [first, second] = section("Payment fees").getAllByRole("listitem");
    expect(within(first!).getByText(LATE)).toBeInTheDocument();
    expect(within(first!).getByText(`“${LATE_QUOTE}”`).tagName).toBe("BLOCKQUOTE");
    expect(within(first!).getByRole("button", view(0))).toBeInTheDocument();
    expect(within(second!).getByText(SETUP)).toBeInTheDocument();
    expect(within(second!).getByText(`“${SETUP_QUOTE}”`).tagName).toBe("BLOCKQUOTE");
    expect(screen.queryByText("No verified quotation")).not.toBeInTheDocument();
    // The payment amount's quotation is shown with the payment, never among the fees.
    expect(section("Payment fees").queryByText(/1,200 GBP/)).toBeNull();

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
    const [first, second] = section("Payment fees").getAllByRole("listitem");
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
    expect(section("Payment fees").getByText(LATE)).toBeInTheDocument();
    expect(section("Payment fees").getByText("No verified quotation")).toBeInTheDocument();
    expect(screen.queryByRole("button", view(0))).not.toBeInTheDocument();
    expect(document.querySelector("blockquote")).toBeNull();
  });

  it.each([[[]], [undefined], [["  "]], ["not a list"]])(
    "keeps None identified with no fees: %j",
    (fees) => {
      renderFees({ fees, fee_citations: [{ fee: LATE, citation: citation(LATE_QUOTE) }] });
      expect(section("Payment fees").getByText(EMPTY_LIST)).toBeInTheDocument();
      expect(section("Payment fees").queryByRole("list")).not.toBeInTheDocument();
      expect(screen.queryByText("No verified quotation")).not.toBeInTheDocument();
      expect(document.querySelector("blockquote")).toBeNull();
    },
  );
});

describe("AnalysisDetails obligations", () => {
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
          <AnalysisDetails result={result as Partial<AnalysisResult>} />
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

    const [first, second] = section("Obligations").getAllByRole("listitem");
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
    expect(section("Obligations").queryByText("No verified quotation")).toBeNull();
    expect(section("Payment fees").getByText("No verified quotation")).toBeInTheDocument();

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
    const [first, second] = section("Obligations").getAllByRole("listitem");
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
    expect(section("Obligations").getByText(BUILD)).toBeInTheDocument();
    expect(section("Obligations").getByText("No verified quotation")).toBeInTheDocument();
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
      expect(section("Obligations").getByText(EMPTY_LIST)).toBeInTheDocument();
      expect(section("Obligations").queryByRole("list")).not.toBeInTheDocument();
      expect(screen.queryByText("No verified quotation")).not.toBeInTheDocument();
      expect(document.querySelector("blockquote")).toBeNull();
    },
  );
});
