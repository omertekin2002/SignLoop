import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnalysisDetails } from "@/components/analysis-details";
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
