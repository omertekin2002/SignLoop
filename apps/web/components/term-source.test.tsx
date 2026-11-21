import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api-client", () => ({
  apiClient: { get: mocks.get },
  getApiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

import {
  ContractSourceProvider,
  PaymentSource,
  TermSource,
} from "@/components/contract-source";

const CONTRACT_ID = "11111111-2222-4333-8444-555555555555";
const ANALYSIS_ID = "22222222-3333-4444-8555-666666666666";
const REVISION = `sha256:${"a".repeat(64)}`;
const SOURCE = {
  contract_id: CONTRACT_ID,
  revision: REVISION,
  index_unit: "unicode-code-points" as const,
};
const TEXT =
  "3. Term. This agreement starts on the date of the order form and lasts for twelve months. It renews automatically.";
const QUOTE =
  "This agreement starts on the date of the order form and lasts for twelve months.";
const START = TEXT.indexOf(QUOTE);
const CITATION = {
  ...SOURCE,
  status: "verified" as const,
  quote: QUOTE,
  start: START,
  end: START + QUOTE.length,
};

type Term = {
  start?: string | null;
  end?: string | null;
  minimum_term?: string | null;
  term_citation?: unknown;
};

function renderTerm(
  term: Term,
  payments: Record<string, unknown> | null = null,
) {
  const result = { source: SOURCE, summary: { term, payments } };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ContractSourceProvider
        contractId={CONTRACT_ID}
        analysisId={ANALYSIS_ID}
        result={result}
      >
        <TermSource term={term} />
        {payments && <PaymentSource payments={payments} />}
      </ContractSourceProvider>
    </QueryClientProvider>,
  );
}

const VIEW = { name: "View matched quotation of the term clause" };

describe("TermSource", () => {
  beforeEach(() => {
    mocks.get.mockReset();
  });

  it("shows a quoted term with its start and verified quotation, and opens it in the source", async () => {
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
        highlight: CITATION,
      },
    });
    renderTerm({
      start: "The date of the order form",
      end: null,
      minimum_term: "12 months",
      term_citation: CITATION,
    });

    expect(screen.getByText("12 months")).toBeInTheDocument();
    expect(
      screen.getByText("Starts: The date of the order form"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Ends:/)).not.toBeInTheDocument();
    expect(screen.getByText(`“${QUOTE}”`).tagName).toBe("BLOCKQUOTE");
    expect(
      screen.getByText(
        "The quotation shows where this value comes from, not that this reading of it is correct.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("No verified quotation")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", VIEW));
    const dialog = await screen.findByRole("dialog", {
      name: "Extracted contract text",
    });
    expect(
      await within(dialog).findByText(
        "Quotation matched in the analyzed text. Highlighted below.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog)
        .getByRole("region", { name: "Source passage" })
        .querySelector("mark"),
    ).toHaveTextContent(QUOTE);
    expect(mocks.get).toHaveBeenCalledWith(
      `/contracts/${CONTRACT_ID}/source`,
      expect.objectContaining({
        params: {
          offset: 0,
          revision: REVISION,
          analysisId: ANALYSIS_ID,
          flag: "term",
        },
      }),
    );
  });

  it.each([
    [
      "a report stored before term quotations",
      { start: "1 March 2027", end: "28 February 2029", minimum_term: "24 months" },
      "24 months",
    ],
    [
      "an unverified quotation of a term stated only by its minimum term",
      { start: null, end: null, minimum_term: "24 months", term_citation: null },
      "24 months",
    ],
    [
      "a citation for another revision, with only an end stated",
      {
        start: null,
        end: "28 February 2029",
        minimum_term: null,
        term_citation: { ...CITATION, revision: `sha256:${"b".repeat(64)}` },
      },
      "Ends: 28 February 2029",
    ],
  ])(
    "marks a stated term without a verified quotation: %s",
    (_label, term, label) => {
      renderTerm(term);
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText("No verified quotation")).toBeInTheDocument();
      expect(screen.queryByRole("button", VIEW)).not.toBeInTheDocument();
      expect(document.querySelector("blockquote")).toBeNull();
    },
  );

  it("lists a stated start and end beside the minimum term, so the quotation never backs a hidden value", () => {
    renderTerm({
      start: "1 March 2027",
      end: "28 February 2029",
      minimum_term: null,
      term_citation: CITATION,
    });
    expect(screen.getByText("Not specified")).toBeInTheDocument();
    expect(screen.getByText("Starts: 1 March 2027")).toBeInTheDocument();
    expect(screen.getByText("Ends: 28 February 2029")).toBeInTheDocument();
    expect(screen.getByRole("button", VIEW)).toBeInTheDocument();
  });

  it("leaves an unknown term as before, with no quotation, marker or placeholder start and end", () => {
    renderTerm({
      start: "Not specified",
      end: "Unknown",
      minimum_term: null,
      // Never shown for an unknown term, even if a citation were stored.
      term_citation: CITATION,
    });
    expect(screen.getByText("Not specified")).toBeInTheDocument();
    expect(screen.queryByText(/^Starts:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Ends:/)).not.toBeInTheDocument();
    expect(screen.queryByText("No verified quotation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", VIEW)).not.toBeInTheDocument();
    expect(document.querySelector("blockquote")).toBeNull();
  });

  it("shows term and payment quotations independently", () => {
    const paymentQuote = "It renews automatically.";
    const paymentStart = TEXT.indexOf(paymentQuote);
    renderTerm(
      { start: null, end: null, minimum_term: "12 months", term_citation: CITATION },
      {
        amount: "1,200 GBP",
        frequency: null,
        payment_citation: {
          ...CITATION,
          quote: paymentQuote,
          start: paymentStart,
          end: paymentStart + paymentQuote.length,
        },
      },
    );
    expect(screen.getByRole("button", VIEW)).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "View matched quotation of the payment clause",
      }),
    ).toBeInTheDocument();
    expect(document.querySelectorAll("blockquote")).toHaveLength(2);
  });
});
