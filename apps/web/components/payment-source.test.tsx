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
  "2. Fees. The Client will pay a monthly fee of 1,200 GBP, invoiced on the first day of each month. Late payments accrue interest.";
const QUOTE =
  "The Client will pay a monthly fee of 1,200 GBP, invoiced on the first day of each month.";
const START = TEXT.indexOf(QUOTE);
const CITATION = {
  ...SOURCE,
  status: "verified" as const,
  quote: QUOTE,
  start: START,
  end: START + QUOTE.length,
};

type Payments = {
  amount?: string | null;
  frequency?: string | null;
  fees?: string[];
  payment_citation?: unknown;
};

function renderPayments(
  payments: Payments,
  renewal: Record<string, unknown> | null = null,
) {
  const result = { source: SOURCE, summary: { payments, renewal } };
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
        <PaymentSource payments={payments} />
        {renewal && <RenewalSource renewal={renewal} />}
      </ContractSourceProvider>
    </QueryClientProvider>,
  );
}

const VIEW = { name: "View matched quotation of the payment clause" };

describe("PaymentSource", () => {
  beforeEach(() => {
    mocks.get.mockReset();
  });

  it("shows a quoted payment with its verified quotation, and opens it in the source", async () => {
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
    renderPayments({
      amount: "1,200 GBP",
      frequency: "Monthly",
      fees: [],
      payment_citation: CITATION,
    });

    expect(screen.getByText("1,200 GBP")).toBeInTheDocument();
    expect(screen.getByText("Monthly")).toBeInTheDocument();
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
          flag: "payment",
        },
      }),
    );
  });

  it.each([
    [
      "a report stored before payment quotations",
      { amount: "1,200 GBP", frequency: "Monthly", fees: [] },
      "1,200 GBP",
    ],
    [
      "an unverified quotation of a payment stated only by its amount",
      { amount: "1,200 GBP", frequency: null, payment_citation: null },
      "1,200 GBP",
    ],
    [
      "a citation for another revision, with only a frequency stated",
      {
        amount: null,
        frequency: "Monthly",
        payment_citation: { ...CITATION, revision: `sha256:${"b".repeat(64)}` },
      },
      "Monthly",
    ],
  ])(
    "marks a stated payment without a verified quotation: %s",
    (_label, payments, label) => {
      renderPayments(payments);
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText("No verified quotation")).toBeInTheDocument();
      expect(screen.queryByRole("button", VIEW)).not.toBeInTheDocument();
      expect(document.querySelector("blockquote")).toBeNull();
    },
  );

  it("says Not specified when only the frequency is stated", () => {
    renderPayments({ amount: null, frequency: "Monthly" });
    expect(screen.getByText("Not specified")).toBeInTheDocument();
    expect(screen.getByText("Monthly")).toBeInTheDocument();
  });

  it("leaves an unknown payment as before, with no quotation or marker", () => {
    renderPayments({
      amount: null,
      frequency: null,
      fees: [],
      // Never shown for an unknown payment, even if a citation were stored.
      payment_citation: CITATION,
    });
    expect(screen.getByText("Not specified")).toBeInTheDocument();
    expect(screen.queryByText("No verified quotation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", VIEW)).not.toBeInTheDocument();
    expect(document.querySelector("blockquote")).toBeNull();
  });

  it("shows payment and renewal quotations independently", () => {
    const renewalQuote = "Late payments accrue interest.";
    const renewalStart = TEXT.indexOf(renewalQuote);
    renderPayments(
      { amount: "1,200 GBP", frequency: "Monthly", payment_citation: CITATION },
      {
        auto_renew: true,
        renewal_period: null,
        renewal_citation: {
          ...CITATION,
          quote: renewalQuote,
          start: renewalStart,
          end: renewalStart + renewalQuote.length,
        },
      },
    );
    expect(screen.getByRole("button", VIEW)).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "View matched quotation of the renewal clause",
      }),
    ).toBeInTheDocument();
    expect(document.querySelectorAll("blockquote")).toHaveLength(2);
  });
});
