import { describe, expect, it } from "vitest";
import {
  clarifyBeforeSigning,
  quotationStatusLine,
  type ClarifyInput,
} from "@/lib/analysis-clarify";
import type { AnalysisResult } from "@/lib/schemas";

const CONTRACT_ID = "11111111-2222-4333-8444-555555555555";
const REVISION = `sha256:${"a".repeat(64)}`;
const SOURCE = {
  contract_id: CONTRACT_ID,
  revision: REVISION,
  index_unit: "unicode-code-points" as const,
};

function citation(quote: string, start = 100) {
  return {
    ...SOURCE,
    status: "verified" as const,
    quote,
    start,
    end: start + Array.from(quote).length,
  };
}

/** Every stated fact quoted, full coverage, two findings and a question. */
function quotedResult(): Partial<AnalysisResult> & Record<string, unknown> {
  return {
    source: SOURCE,
    coverage_notices: [],
    summary: {
      what_it_is: "A gym membership agreement.",
      payments: {
        amount: "£45",
        frequency: "Monthly",
        fees: ["Joining fee of £20"],
        payment_citation: citation("pay £45 each month"),
        fee_citations: [{ fee: "Joining fee of £20", citation: citation("a joining fee of £20") }],
      },
      term: {
        start: "2026-01-01",
        end: null,
        minimum_term: "12 months",
        term_citation: citation("for a minimum of twelve months"),
      },
      renewal: {
        auto_renew: true,
        renewal_period: "12 months",
        renewal_citation: citation("renews automatically"),
      },
      cancellation: {
        how: "Write to the club.",
        notice_period_days: 30,
        notice_period_text: null,
        penalties: ["Early exit fee"],
        notice_citation: citation("30 days' notice"),
        penalty_citations: [{ penalty: "Early exit fee", citation: citation("an early exit fee") }],
      },
    } as AnalysisResult["summary"],
    red_flags: [
      {
        type: "Price increase",
        severity: 4,
        explanation: "Fees may rise.",
        where: null,
        evidence: null,
        citation: null,
        confidence: 70,
      },
      {
        type: "Auto-renewal",
        severity: 8,
        explanation: "Renews for a year.",
        where: null,
        evidence: null,
        citation: null,
        confidence: 80,
      },
    ],
    key_dates: [{ type: "NOTICE_CUTOFF", date: "2026-11-30", derived_from: "A month before renewal" }],
    key_date_citations: [
      { type: "NOTICE_CUTOFF", date: "2026-11-30", citation: citation("one month before") },
    ],
    obligations: ["Pay monthly dues"],
    obligation_citations: [{ obligation: "Pay monthly dues", citation: citation("pay your dues") }],
    parties: ["Example Gym Ltd", "Member"],
    key_points: ["Renews automatically every year."],
    next_actions: {
      questions_to_ask: ["Can the renewal be switched off?"],
      email_templates: [],
    },
  };
}

function clarify(
  resultJson: ClarifyInput["resultJson"] | Record<string, unknown>,
  extractionWarning: string | null = null,
) {
  return clarifyBeforeSigning({
    contractId: CONTRACT_ID,
    extractionWarning,
    resultJson: resultJson as ClarifyInput["resultJson"],
  });
}

/** A report from before quotations existed: no source and no citation fields. */
function preQuotationResult() {
  const result = quotedResult();
  const stripped = JSON.parse(
    JSON.stringify(result, (key, value) =>
      key === "source" || key.endsWith("citation") || key.endsWith("citations")
        ? undefined
        : value,
    ),
  ) as Record<string, unknown>;
  return stripped;
}

describe("clarifyBeforeSigning", () => {
  it("says every stated fact is quoted when coverage is full, then lists findings and questions", () => {
    const checklist = clarify(quotedResult());

    expect(checklist).toEqual({
      coverageGaps: [],
      unverified: [],
      everyStatedFactQuoted: true,
      unstated: [],
      findings: [
        { number: 2, type: "Auto-renewal", severity: 8 },
        { number: 1, type: "Price increase", severity: 4 },
      ],
      questions: ["Can the renewal be switched off?"],
    });
    expect(quotationStatusLine(checklist)).toBe("Every stated fact has a verified quotation.");
  });

  it("lists every stated fact of an analysis from before quotations as unverified, in a fixed order", () => {
    let checklist: ReturnType<typeof clarify> | undefined;
    expect(() => {
      checklist = clarify(preQuotationResult());
    }).not.toThrow();

    expect(checklist!.everyStatedFactQuoted).toBe(false);
    expect(quotationStatusLine(checklist!)).toBeNull();
    expect(checklist!.unverified.map(({ fact, value, ref }) => [fact, value, ref])).toEqual([
      ["Notice period", "30 days", "notice"],
      ["Renewal", "Auto-renews, period 12 months", "renewal"],
      ["Payment", "£45, Monthly", "payment"],
      ["Term", "12 months, starts 2026-01-01", "term"],
      ["Fee", "Joining fee of £20", "fee-0"],
      ["Penalty", "Early exit fee", "penalty-0"],
      ["Obligation", "Pay monthly dues", "obligation-0"],
      ["Key date", "Notice cutoff: 2026-11-30", "key-date-0"],
    ]);
    expect(checklist!.unstated).toEqual([]);
  });

  it("treats a citation for another contract or revision as unverified, like the page", () => {
    const result = quotedResult();
    result.source = { ...SOURCE, revision: `sha256:${"b".repeat(64)}` };
    expect(clarify(result).unverified).toHaveLength(8);

    expect(
      clarifyBeforeSigning({
        contractId: "99999999-2222-4333-8444-555555555555",
        resultJson: quotedResult(),
      }).unverified,
    ).toHaveLength(8);
  });

  it("lists only the four singular facts as not specified, and adds nothing for empty lists", () => {
    const checklist = clarify({
      source: SOURCE,
      summary: {
        what_it_is: "",
        payments: { amount: "Not specified", frequency: null, fees: [] },
        term: { start: null, end: "  ", minimum_term: "Unknown" },
        renewal: { auto_renew: null, renewal_period: null },
        cancellation: { how: "", notice_period_days: null, notice_period_text: null, penalties: [] },
      },
      red_flags: [],
      key_dates: [],
      obligations: [],
      parties: [],
      key_points: [],
    });

    expect(checklist.unstated).toEqual([
      { fact: "Notice period" },
      { fact: "Renewal" },
      { fact: "Payment" },
      { fact: "Term" },
    ]);
    expect(checklist.unverified).toEqual([]);
    // Nothing is stated, so nothing may be called quoted.
    expect(checklist.everyStatedFactQuoted).toBe(false);
    expect(quotationStatusLine(checklist)).toBeNull();
    expect(checklist.findings).toEqual([]);
    expect(checklist.questions).toEqual([]);
  });

  it("never lists fields that have no citation slot", () => {
    const result = preQuotationResult();
    const checklist = clarify(result);
    const listed = JSON.stringify(checklist);
    // How to cancel, what it is, the parties and the key points have no quotation to miss.
    for (const value of [
      "Write to the club.",
      "A gym membership agreement.",
      "Example Gym Ltd",
      "Member",
      "Renews automatically every year.",
    ]) {
      expect(listed).not.toContain(value);
    }
  });

  it("lists the extraction warning and each coverage notice once, and never hides them", () => {
    const result = quotedResult();
    result.coverage_notices = [
      "Only part of this contract was analysed: sections 4 to 6 were skipped.",
      "Scanned pages were read with OCR.",
      "Only part of this contract was analysed: sections 4 to 6 were skipped.",
    ];
    const checklist = clarify(result, "Scanned pages were read with OCR.");

    expect(checklist.coverageGaps).toEqual([
      { label: "Text extraction", text: "Scanned pages were read with OCR." },
      {
        label: "Analysis coverage",
        text: "Only part of this contract was analysed: sections 4 to 6 were skipped.",
      },
    ]);
    // Every stated fact is quoted, but only in the text the analysis read.
    expect(checklist.everyStatedFactQuoted).toBe(true);
    expect(quotationStatusLine(checklist)).toMatch(
      /^Every stated fact has a verified quotation in the text this analysis read\. .*coverage gaps/,
    );
  });

  it("orders findings by severity, missing severities last and ties in stored order", () => {
    const flag = (type: string, severity: unknown) => ({ type, severity, explanation: "" });
    const checklist = clarify({
      red_flags: [
        flag("A", null),
        flag("B", 5),
        flag("", 12),
        flag("D", 5),
        flag("E", Number.NaN),
      ],
    });
    expect(checklist.findings).toEqual([
      { number: 3, type: "Risk", severity: 10 },
      { number: 2, type: "B", severity: 5 },
      { number: 4, type: "D", severity: 5 },
      { number: 1, type: "A", severity: null },
      { number: 5, type: "E", severity: null },
    ]);
  });

  it("reads only its input: malformed values neither throw nor change it", () => {
    const result = quotedResult();
    const before = JSON.stringify(result);
    clarify(result, "Warning");
    expect(JSON.stringify(result)).toBe(before);

    for (const malformed of [null, undefined, {}, [], "text", { summary: "x", red_flags: "y" }]) {
      expect(() => clarify(malformed as ClarifyInput["resultJson"])).not.toThrow();
    }
    expect(clarify(null).unstated).toHaveLength(4);
    expect(clarify(null).questions).toEqual([]);
  });

  it("keeps the analysis's questions, dropping blank ones", () => {
    const result = quotedResult();
    result.next_actions = {
      questions_to_ask: ["  First?  ", "", "# Second **bold**?"],
      email_templates: [],
    };
    expect(clarify(result).questions).toEqual(["First?", "# Second **bold**?"]);
  });
});
