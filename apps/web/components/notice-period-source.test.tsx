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
  "9. Termination. Either party may end this agreement on 10 business days' written notice to the other.";
const QUOTE = "on 10 business days' written notice to the other";
const START = TEXT.indexOf(QUOTE);
const CITATION = {
  ...SOURCE,
  status: "verified" as const,
  quote: QUOTE,
  start: START,
  end: START + QUOTE.length,
};

type Cancellation = {
  how?: string;
  notice_period_days?: number | null;
  notice_period_text?: string | null;
  notice_citation?: unknown;
};

function renderNotice(cancellation: Cancellation, source: unknown = SOURCE) {
  const result = { source, summary: { cancellation } };
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
        <NoticePeriodSource cancellation={cancellation} />
      </ContractSourceProvider>
    </QueryClientProvider>,
  );
}

const VIEW = { name: "View matched quotation of the notice-period clause" };

describe("NoticePeriodSource", () => {
  beforeEach(() => {
    mocks.get.mockReset();
  });

  it("shows a quoted notice period with its verified quotation, and opens it in the source", async () => {
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
    renderNotice({
      notice_period_days: null,
      notice_period_text: "10 business days",
      notice_citation: CITATION,
    });

    expect(screen.getByText("10 business days")).toBeInTheDocument();
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
          flag: "notice",
        },
      }),
    );
  });

  it.each([
    [
      "a report stored before notice quotations",
      { notice_period_days: 60, notice_period_text: "60 days" },
    ],
    [
      "an unverified quotation",
      {
        notice_period_days: 60,
        notice_period_text: null,
        notice_citation: null,
      },
    ],
    [
      "a citation for another revision",
      {
        notice_period_days: null,
        notice_period_text: "10 business days",
        notice_citation: { ...CITATION, revision: `sha256:${"b".repeat(64)}` },
      },
    ],
  ])(
    "marks a stated notice period without a verified quotation: %s",
    (_label, cancellation) => {
      renderNotice(cancellation);
      expect(
        screen.getByText(cancellation.notice_period_text ?? "60 days"),
      ).toBeInTheDocument();
      expect(screen.getByText("No verified quotation")).toBeInTheDocument();
      expect(screen.queryByRole("button", VIEW)).not.toBeInTheDocument();
      expect(document.querySelector("blockquote")).toBeNull();
    },
  );

  it("leaves an unknown notice period as before, with no quotation or marker", () => {
    renderNotice({
      notice_period_days: null,
      notice_period_text: null,
      // Never shown for an unknown period, even if a citation were stored.
      notice_citation: CITATION,
    });
    expect(screen.getByText("Not specified")).toBeInTheDocument();
    expect(screen.queryByText("No verified quotation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", VIEW)).not.toBeInTheDocument();
    expect(document.querySelector("blockquote")).toBeNull();
  });
});
