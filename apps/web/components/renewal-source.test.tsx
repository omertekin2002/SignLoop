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
  NoticePeriodSource,
  RenewalSource,
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
  "3. Renewal. This agreement renews automatically for successive twelve-month terms unless either party gives 60 days' written notice.";
const QUOTE = "This agreement renews automatically for successive twelve-month terms";
const START = TEXT.indexOf(QUOTE);
const CITATION = {
  ...SOURCE,
  status: "verified" as const,
  quote: QUOTE,
  start: START,
  end: START + QUOTE.length,
};

type Renewal = {
  auto_renew?: boolean | null;
  renewal_period?: string | null;
  renewal_citation?: unknown;
};

function renderRenewal(
  renewal: Renewal,
  cancellation: Record<string, unknown> | null = null,
) {
  const result = { source: SOURCE, summary: { renewal, cancellation } };
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
        <RenewalSource renewal={renewal} />
        {cancellation && <NoticePeriodSource cancellation={cancellation} />}
      </ContractSourceProvider>
    </QueryClientProvider>,
  );
}

const VIEW = { name: "View matched quotation of the renewal clause" };

describe("RenewalSource", () => {
  beforeEach(() => {
    mocks.get.mockReset();
  });

  it("shows quoted renewal with its verified quotation, and opens it in the source", async () => {
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
    renderRenewal({
      auto_renew: true,
      renewal_period: "12 months",
      renewal_citation: CITATION,
    });

    expect(screen.getByText("Auto-renews")).toBeInTheDocument();
    expect(screen.getByText("Period: 12 months")).toBeInTheDocument();
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
          flag: "renewal",
        },
      }),
    );
  });

  it.each([
    [
      "a report stored before renewal quotations",
      { auto_renew: true, renewal_period: "12 months" },
      "Auto-renews",
    ],
    [
      "an unverified quotation of renewal stated as not automatic",
      { auto_renew: false, renewal_period: null, renewal_citation: null },
      "Does not auto-renew",
    ],
    [
      "a citation for another revision, with only a period stated",
      {
        auto_renew: null,
        renewal_period: "12 months",
        renewal_citation: { ...CITATION, revision: `sha256:${"b".repeat(64)}` },
      },
      "Not specified",
    ],
  ])(
    "marks stated renewal without a verified quotation: %s",
    (_label, renewal, label) => {
      renderRenewal(renewal);
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText("No verified quotation")).toBeInTheDocument();
      expect(screen.queryByRole("button", VIEW)).not.toBeInTheDocument();
      expect(document.querySelector("blockquote")).toBeNull();
    },
  );

  it("says the contract does not auto-renew, never that renewal is manual", () => {
    renderRenewal({ auto_renew: false, renewal_period: null });
    expect(screen.getByText("Does not auto-renew")).toBeInTheDocument();
    expect(screen.queryByText("Manual renewal")).not.toBeInTheDocument();
  });

  it("leaves unknown renewal as before, with no quotation or marker", () => {
    renderRenewal({
      auto_renew: null,
      renewal_period: null,
      // Never shown for unknown renewal, even if a citation were stored.
      renewal_citation: CITATION,
    });
    expect(screen.getByText("Not specified")).toBeInTheDocument();
    expect(screen.queryByText(/^Period:/)).not.toBeInTheDocument();
    expect(screen.queryByText("No verified quotation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", VIEW)).not.toBeInTheDocument();
    expect(document.querySelector("blockquote")).toBeNull();
  });

  it("shows renewal and notice quotations independently, even when they overlap", () => {
    const noticeQuote = "unless either party gives 60 days' written notice.";
    const noticeStart = TEXT.indexOf(noticeQuote);
    renderRenewal(
      { auto_renew: true, renewal_period: "12 months", renewal_citation: CITATION },
      {
        notice_period_days: 60,
        notice_period_text: "60 days",
        notice_citation: {
          ...CITATION,
          quote: noticeQuote,
          start: noticeStart,
          end: noticeStart + noticeQuote.length,
        },
      },
    );
    expect(screen.getByRole("button", VIEW)).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "View matched quotation of the notice-period clause",
      }),
    ).toBeInTheDocument();
    expect(document.querySelectorAll("blockquote")).toHaveLength(2);
  });
});
