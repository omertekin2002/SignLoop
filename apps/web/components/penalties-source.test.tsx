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
  PenaltiesSource,
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
  "3. Termination. If the Client ends this agreement early, the Client must pay an early termination fee equal to two months' fees. Unreturned equipment is charged at cost.";
const EARLY_EXIT = "Early termination fee equal to two months' fees";
const EARLY_EXIT_QUOTE =
  "If the Client ends this agreement early, the Client must pay an early termination fee equal to two months' fees.";
const EQUIPMENT = "Unreturned equipment charged at cost";
const EQUIPMENT_QUOTE = "Unreturned equipment is charged at cost.";

function citation(quote: string) {
  const start = TEXT.indexOf(quote);
  return {
    ...SOURCE,
    status: "verified" as const,
    quote,
    start,
    end: start + quote.length,
  };
}

function renderPenalties(cancellation: {
  penalties?: unknown;
  penalty_citations?: unknown;
}) {
  const result = { source: SOURCE, summary: { cancellation } };
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
        <PenaltiesSource penalties={cancellation.penalties} />
      </ContractSourceProvider>
    </QueryClientProvider>,
  );
}

const view = (index: number) => ({
  name: `View matched quotation of penalty ${index + 1}`,
});

describe("PenaltiesSource", () => {
  beforeEach(() => {
    mocks.get.mockReset();
  });

  it("shows each penalty with its own verified quotation, and opens it in the source", async () => {
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
        highlight: citation(EQUIPMENT_QUOTE),
      },
    });
    renderPenalties({
      penalties: [EARLY_EXIT, EQUIPMENT],
      // Listed in the other order, so nothing depends on position.
      penalty_citations: [
        { penalty: EQUIPMENT, citation: citation(EQUIPMENT_QUOTE) },
        { penalty: EARLY_EXIT, citation: citation(EARLY_EXIT_QUOTE) },
      ],
    });

    const [first, second] = screen.getAllByRole("listitem");
    expect(within(first!).getByText(EARLY_EXIT)).toBeInTheDocument();
    expect(within(first!).getByText(`“${EARLY_EXIT_QUOTE}”`).tagName).toBe(
      "BLOCKQUOTE",
    );
    expect(within(first!).getByRole("button", view(0))).toBeInTheDocument();
    expect(within(second!).getByText(EQUIPMENT)).toBeInTheDocument();
    expect(within(second!).getByText(`“${EQUIPMENT_QUOTE}”`).tagName).toBe(
      "BLOCKQUOTE",
    );
    expect(screen.queryByText("No verified quotation")).not.toBeInTheDocument();

    await userEvent.click(within(second!).getByRole("button", view(1)));
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
    ).toHaveTextContent(EQUIPMENT_QUOTE);
    expect(mocks.get).toHaveBeenCalledWith(
      `/contracts/${CONTRACT_ID}/source`,
      expect.objectContaining({
        params: {
          offset: 0,
          revision: REVISION,
          analysisId: ANALYSIS_ID,
          flag: "penalty-1",
        },
      }),
    );
  });

  it("marks a penalty without a verified quotation, never showing another penalty's", () => {
    renderPenalties({
      penalties: [EARLY_EXIT, EQUIPMENT],
      penalty_citations: [
        { penalty: EQUIPMENT, citation: citation(EQUIPMENT_QUOTE) },
      ],
    });
    const [first, second] = screen.getAllByRole("listitem");
    expect(within(first!).getByText("No verified quotation")).toBeInTheDocument();
    expect(within(first!).queryByRole("button")).not.toBeInTheDocument();
    expect(within(first!).queryByText(/charged at cost\.”/)).toBeNull();
    expect(within(second!).getByRole("button", view(1))).toBeInTheDocument();
    expect(document.querySelectorAll("blockquote")).toHaveLength(1);
  });

  it.each([
    ["a report stored before penalty quotations", undefined],
    ["no verified entries", []],
    [
      "a citation keyed by different text",
      [{ penalty: EARLY_EXIT.toLowerCase(), citation: citation(EARLY_EXIT_QUOTE) }],
    ],
    [
      "a citation for another revision",
      [
        {
          penalty: EARLY_EXIT,
          citation: { ...citation(EARLY_EXIT_QUOTE), revision: `sha256:${"b".repeat(64)}` },
        },
      ],
    ],
  ])("marks a listed penalty without a verified quotation: %s", (_label, citations) => {
    renderPenalties({ penalties: [EARLY_EXIT], penalty_citations: citations });
    expect(screen.getByText(EARLY_EXIT)).toBeInTheDocument();
    expect(screen.getByText("No verified quotation")).toBeInTheDocument();
    expect(screen.queryByRole("button", view(0))).not.toBeInTheDocument();
    expect(document.querySelector("blockquote")).toBeNull();
  });

  it.each([[[]], [undefined], [["  "]], ["not a list"]])(
    "says None listed with no penalties: %j",
    (penalties) => {
      renderPenalties({
        penalties,
        penalty_citations: [{ penalty: EARLY_EXIT, citation: citation(EARLY_EXIT_QUOTE) }],
      });
      expect(screen.getByText("None listed")).toBeInTheDocument();
      expect(screen.queryByText("No verified quotation")).not.toBeInTheDocument();
      expect(screen.queryByRole("list")).not.toBeInTheDocument();
      expect(document.querySelector("blockquote")).toBeNull();
    },
  );
});
