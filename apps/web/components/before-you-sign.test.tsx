import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BeforeYouSign } from "@/components/before-you-sign";
import { isClarifyItemKey } from "@/lib/clarify-ask";
import type { AnalysisResult } from "@/lib/schemas";

const CONTRACT_ID = "11111111-2222-4333-8444-555555555555";
const ANALYSIS_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const SOURCE = {
  contract_id: CONTRACT_ID,
  revision: `sha256:${"a".repeat(64)}`,
  index_unit: "unicode-code-points" as const,
};

function citation(quote: string) {
  return { ...SOURCE, status: "verified" as const, quote, start: 0, end: quote.length };
}

// Payment is quoted, the notice period is stated without a quotation, term and renewal are unknown.
const RESULT = {
  source: SOURCE,
  coverage_notices: ["Only part of this contract was analysed."],
  summary: {
    what_it_is: "A gym membership agreement.",
    payments: { amount: "£45", frequency: "Monthly", fees: [], payment_citation: citation("£45") },
    term: { start: null, end: null, minimum_term: null },
    renewal: { auto_renew: null, renewal_period: null },
    cancellation: { how: "Write to the club.", notice_period_days: 30, notice_period_text: null, penalties: [] },
  },
  red_flags: [
    { type: "Price increase", severity: 3, explanation: "", where: null, confidence: 60 },
    { type: "Auto-renewal", severity: 8, explanation: "", where: null, confidence: 80 },
  ],
  next_actions: { questions_to_ask: ["# Can I **cancel** early?"], email_templates: [] },
} as unknown as Partial<AnalysisResult>;

function card(
  result: Partial<AnalysisResult> | null,
  extractionWarning: string | null = null,
  askAnalysisId: string | null = null,
) {
  render(
    <BeforeYouSign
      contractId={CONTRACT_ID}
      extractionWarning={extractionWarning}
      result={result}
      askAnalysisId={askAnalysisId}
    />,
  );
  return screen.getByRole("region", { name: "Before you sign: what to clarify" });
}

describe("BeforeYouSign", () => {
  it("lists coverage gaps, unverified and unstated facts, findings and questions in order", () => {
    const region = card(RESULT, "Scanned pages were read with OCR.");

    expect(
      within(region)
        .getAllByRole("heading", { level: 4 })
        .map((heading) => heading.textContent),
    ).toEqual(["Coverage gaps", "Stated without a verified quotation", "Not stated", "Findings", "Questions to Ask"]);
    expect(region).toHaveTextContent("Text extraction: Scanned pages were read with OCR.");
    expect(region).toHaveTextContent("Analysis coverage: Only part of this contract was analysed.");
    expect(region).toHaveTextContent("Notice period: 30 daysNo verified quotation");
    expect(within(region).getAllByText("No verified quotation", { exact: true })).toHaveLength(1);
    expect(within(region).getAllByText("Not specified", { exact: true })).toHaveLength(2);
    // Fields with no citation slot are not listed.
    expect(region).not.toHaveTextContent("Write to the club.");
    expect(region).not.toHaveTextContent("A gym membership agreement.");
    expect(region).not.toHaveTextContent(/nothing to clarify/i);
  });

  it("links each finding, highest severity first, to its entry in the Findings and draft emails card", () => {
    const region = card(RESULT);
    const links = within(region).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Auto-renewal", "#finding-2"],
      ["Price increase", "#finding-1"],
    ]);
  });

  it("shows the questions as plain text, once", () => {
    const region = card(RESULT);
    expect(within(region).getAllByText("# Can I **cancel** early?", { exact: true })).toHaveLength(1);
    expect(within(region).queryByRole("heading", { name: /Can I/ })).toBeNull();
  });

  it("says every stated fact is quoted when coverage is full, and still lists findings and questions", () => {
    const region = card({
      ...RESULT,
      coverage_notices: [],
      summary: {
        ...RESULT.summary!,
        cancellation: { how: "", notice_period_days: null, notice_period_text: null, penalties: [] },
      },
    } as Partial<AnalysisResult>);
    expect(within(region).getByText("Every stated fact has a verified quotation.")).toBeInTheDocument();
    expect(within(region).queryByText("Stated without a verified quotation")).toBeNull();
    expect(within(region).getAllByRole("link")).toHaveLength(2);
    expect(within(region).getByText("# Can I **cancel** early?")).toBeInTheDocument();
  });

  it("renders a report without a result as four facts not specified", () => {
    const region = card(null);
    expect(within(region).getAllByText("Not specified", { exact: true })).toHaveLength(4);
    expect(within(region).queryByRole("link")).toBeNull();
  });
});

describe("BeforeYouSign Ask links", () => {
  const askLinks = (region: HTMLElement) =>
    within(region)
      .getAllByRole("link")
      .filter((link) => link.textContent === "Ask");

  it("offers Ask on every unverified fact, unstated fact, finding and question, naming each", () => {
    const region = card(RESULT, "Scanned pages were read with OCR.", ANALYSIS_ID);

    expect(
      askLinks(region).map((link) => [
        link.getAttribute("aria-label"),
        new URL(link.getAttribute("href")!, "https://app.test").searchParams.get("ask"),
      ]),
    ).toEqual([
      ["Ask about Notice period: 30 days", "unverified-1"],
      ["Ask about Renewal", "unstated-renewal"],
      ["Ask about Term", "unstated-term"],
      ["Ask about finding: Auto-renewal", "finding-2"],
      ["Ask about finding: Price increase", "finding-1"],
      ["Ask question 1", "question-1"],
    ]);
    expect(
      within(region).getByRole("link", { name: "Ask about finding: Auto-renewal" }),
    ).toBeInTheDocument();
    // The question keeps its own text element beside its Ask link.
    expect(within(region).getAllByText("# Can I **cancel** early?", { exact: true })).toHaveLength(1);
    // The coverage gaps' list has no Ask link: a chat could not see what the analysis did not.
    const gaps = within(region).getByText("Coverage gaps").closest("section")!;
    expect(within(gaps).queryByRole("link")).toBeNull();
  });

  it("puts only the ids and the item's key in each link, never its text", () => {
    const region = card(RESULT, null, ANALYSIS_ID);
    // The items' text and values as the card shows them; the keys are structural (`unstated-term`).
    const texts = ["30 days", "Notice period", "Auto-renewal", "Price increase", "Can I", "Renewal", "Term", "gym"];
    for (const link of askLinks(region)) {
      const href = link.getAttribute("href")!;
      const url = new URL(href, "https://app.test");
      expect(url.pathname).toBe("/dashboard");
      expect([...url.searchParams.keys()]).toEqual(["contract", "analysis", "ask"]);
      expect(url.searchParams.get("contract")).toBe(CONTRACT_ID);
      expect(url.searchParams.get("analysis")).toBe(ANALYSIS_ID);
      expect(isClarifyItemKey(url.searchParams.get("ask"))).toBe(true);
      for (const text of texts) expect(decodeURIComponent(href)).not.toContain(text);
    }
  });

  it("offers no Ask links without an analysis to name (no extracted text)", () => {
    const region = card(RESULT, null, null);
    expect(askLinks(region)).toHaveLength(0);
  });

  it("distinguishes Ask link labels by finding number when two findings share a type", () => {
    const region = card(
      {
        ...RESULT,
        red_flags: [
          { type: "Indemnity", severity: 8, explanation: "First", where: "Clause 9.1", evidence: null, citation: null, confidence: 80 },
          { type: "Indemnity", severity: 5, explanation: "Second", where: "Clause 12", evidence: null, citation: null, confidence: 70 },
        ],
      },
      null,
      ANALYSIS_ID,
    );
    expect(
      within(region).getByRole("link", { name: "Ask about finding 1: Indemnity" }),
    ).toHaveAttribute("href", `/dashboard?contract=${CONTRACT_ID}&analysis=${ANALYSIS_ID}&ask=finding-1`);
    expect(
      within(region).getByRole("link", { name: "Ask about finding 2: Indemnity" }),
    ).toHaveAttribute("href", `/dashboard?contract=${CONTRACT_ID}&analysis=${ANALYSIS_ID}&ask=finding-2`);
  });
});
