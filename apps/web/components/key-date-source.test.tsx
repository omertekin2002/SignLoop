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
  KeyDateSource,
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
  "4. Fees. The Provider may review the fees once a year, on 1 April. 5. Term. This agreement renews on 1 January 2027.";
const REVIEW_QUOTE = "The Provider may review the fees once a year, on 1 April.";
const RENEWAL_QUOTE = "This agreement renews on 1 January 2027.";
const citationOf = (quote: string) => {
  const start = TEXT.indexOf(quote);
  return {
    ...SOURCE,
    status: "verified" as const,
    quote,
    start,
    end: start + quote.length,
  };
};
const REVIEW = { type: "PRICE_REVIEW", date: "1 April each year" };
const RENEWAL = { type: "RENEWAL", date: "2027-01-01" };
const CAVEAT =
  "The quotation shows which clause this date comes from, not that the date was worked out correctly.";

function renderDates(result: Record<string, unknown>, count: number) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ContractSourceProvider
        contractId={CONTRACT_ID}
        analysisId={ANALYSIS_ID}
        result={{ source: SOURCE, ...result }}
      >
        <ul>
          {Array.from({ length: count }, (_, index) => (
            <li key={index} data-testid={`key-date-${index}`}>
              <KeyDateSource index={index} />
            </li>
          ))}
        </ul>
      </ContractSourceProvider>
    </QueryClientProvider>,
  );
}

describe("KeyDateSource", () => {
  beforeEach(() => {
    mocks.get.mockReset();
  });

  it("shows each key date's own verified quotation, and opens it in the source", async () => {
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
        highlight: citationOf(RENEWAL_QUOTE),
      },
    });
    renderDates(
      {
        key_dates: [
          { ...REVIEW, derived_from: null },
          { ...RENEWAL, derived_from: "End of the first year" },
        ],
        // Stored in the other order, so nothing depends on position.
        key_date_citations: [
          { ...RENEWAL, citation: citationOf(RENEWAL_QUOTE) },
          { ...REVIEW, citation: citationOf(REVIEW_QUOTE) },
        ],
      },
      2,
    );

    const review = screen.getByTestId("key-date-0");
    const renewal = screen.getByTestId("key-date-1");
    expect(within(review).getByText(`“${REVIEW_QUOTE}”`).tagName).toBe("BLOCKQUOTE");
    expect(within(renewal).getByText(`“${RENEWAL_QUOTE}”`).tagName).toBe("BLOCKQUOTE");
    expect(within(renewal).getByText(CAVEAT)).toBeInTheDocument();
    expect(screen.queryByText("No verified quotation")).not.toBeInTheDocument();

    await userEvent.click(
      within(renewal).getByRole("button", {
        name: "View matched quotation of key date 2",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Extracted contract text",
    });
    expect(
      within(dialog)
        .getByRole("region", { name: "Source passage" })
        .querySelector("mark"),
    ).toHaveTextContent(RENEWAL_QUOTE);
    expect(mocks.get).toHaveBeenCalledWith(
      `/contracts/${CONTRACT_ID}/source`,
      expect.objectContaining({
        params: {
          offset: 0,
          revision: REVISION,
          analysisId: ANALYSIS_ID,
          flag: "key-date-1",
        },
      }),
    );
  });

  it("marks a date without its own quotation, never showing another date's", () => {
    renderDates(
      {
        key_dates: [
          // The same type as the cited date, and the same date as it under another type.
          { type: "RENEWAL", date: "2028-01-01", derived_from: null },
          { type: "OTHER", date: RENEWAL.date, derived_from: null },
          { ...RENEWAL, derived_from: null },
        ],
        key_date_citations: [{ ...RENEWAL, citation: citationOf(RENEWAL_QUOTE) }],
      },
      3,
    );
    for (const index of [0, 1]) {
      const item = screen.getByTestId(`key-date-${index}`);
      expect(within(item).getByText("No verified quotation")).toBeInTheDocument();
      expect(item.querySelector("blockquote")).toBeNull();
      expect(within(item).queryByRole("button")).not.toBeInTheDocument();
    }
    expect(
      within(screen.getByTestId("key-date-2")).getByText(`“${RENEWAL_QUOTE}”`),
    ).toBeInTheDocument();
  });

  it.each([
    ["a report stored before key-date quotations", {}],
    [
      "a citation for another revision",
      {
        key_date_citations: [
          {
            ...RENEWAL,
            citation: { ...citationOf(RENEWAL_QUOTE), revision: `sha256:${"b".repeat(64)}` },
          },
        ],
      },
    ],
  ])("marks a key date without a verified quotation: %s", (_label, fields) => {
    renderDates({ key_dates: [{ ...RENEWAL, derived_from: null }], ...fields }, 1);
    expect(screen.getByText("No verified quotation")).toBeInTheDocument();
    expect(document.querySelector("blockquote")).toBeNull();
  });
});
