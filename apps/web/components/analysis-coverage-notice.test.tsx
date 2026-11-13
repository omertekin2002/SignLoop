import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnalysisCoverageNotice } from "@/components/analysis-coverage-notice";

const OVER_CAP = {
  characterCount: 312_480,
  sectionCount: 22,
  analysedSectionCount: 16,
  uncoveredFrom: 228_115,
};

describe("AnalysisCoverageNotice", () => {
  it("warns before the first analysis with the counts, where coverage stops, and how to recover", () => {
    render(<AnalysisCoverageNotice coverage={OVER_CAP} />);

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Analysis coverage");
    expect(notice).toHaveTextContent(
      "This contract has 22 sections, and one analysis covers only the first 16. The analysis stops around character 228,116 of 312,480 (about 73% of the way through)",
    );
    expect(notice).toHaveTextContent(
      "upload the text from that point on as a separate contract",
    );
  });

  it("words the same warning for a re-run when a report exists", () => {
    render(<AnalysisCoverageNotice coverage={OVER_CAP} rerun />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "A re-run stops around character 228,116 of 312,480",
    );
  });

  it.each([
    ["no coverage summary", null],
    [
      "a one-section contract",
      { characterCount: 15_000, sectionCount: 1, analysedSectionCount: 1, uncoveredFrom: null },
    ],
  ])("renders nothing for %s", (_label, coverage) => {
    const { container } = render(<AnalysisCoverageNotice coverage={coverage} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows only a duration hint for a multi-section contract within the cap, and nothing on re-run", () => {
    const covered = {
      characterCount: 160_000,
      sectionCount: 12,
      analysedSectionCount: 12,
      uncoveredFrom: null,
    };
    const { container, rerender } = render(
      <AnalysisCoverageNotice coverage={covered} />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container).toHaveTextContent(
      "This contract is analysed in 12 sections, so this can take a few minutes.",
    );

    rerender(<AnalysisCoverageNotice coverage={covered} rerun />);
    expect(container).toBeEmptyDOMElement();
  });
});
