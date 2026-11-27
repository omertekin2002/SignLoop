import type { AnalysisResult } from "../schemas";

// A stored analysis of CONTRACT_TEXT with every kind of "Before you sign" item, for the
// clarify-keys tests. Plain data with no Node imports, so the browser-environment test can use it.

export const CONTRACT_ID = "11111111-2222-4333-8444-555555555555";

export const CONTRACT_TEXT = [
  "1. Membership. The member pays £45 each month.",
  "2. Prices. The club may raise prices by 5% once a year.",
  "3. Renewal. This agreement renews automatically every 12 months.",
  "4. Exit. An early exit fee applies before the minimum term ends.",
  "",
].join("\n");

/** `contractSourceRevision(CONTRACT_TEXT)`; the Node test checks it. */
export const REVISION =
  "sha256:6aa435ef6e01a8fe29e64c35d32c22c23a1e1607a1e5f460ab7a6d23eb6a925f";

export const SOURCE = {
  contract_id: CONTRACT_ID,
  revision: REVISION,
  index_unit: "unicode-code-points" as const,
};

/** A verified citation of `quote`'s first occurrence in CONTRACT_TEXT, in code points. */
export function citation(quote: string, revision = REVISION) {
  const at = CONTRACT_TEXT.indexOf(quote);
  if (at < 0) throw new Error(`not in the fixture contract: ${quote}`);
  const start = Array.from(CONTRACT_TEXT.slice(0, at)).length;
  return {
    ...SOURCE,
    revision,
    status: "verified" as const,
    quote,
    start,
    end: start + Array.from(quote).length,
  };
}

export type StoredAnalysis = Partial<AnalysisResult> & Record<string, unknown>;

/**
 * One coverage gap; payment, the notice period, two fees and a key date stated without a
 * quotation; renewal quoted; the term unstated; a quoted finding, two unquoted findings of one
 * type in different places; two questions.
 */
export function storedAnalysis(): StoredAnalysis {
  return {
    source: SOURCE,
    coverage_notices: ["Pages 4 and 5 could not be read."],
    summary: {
      what_it_is: "A gym membership agreement.",
      payments: {
        amount: "£45",
        frequency: "Monthly",
        fees: ["Joining fee of £20", "Late payment fee of £5"],
        payment_citation: null,
        fee_citations: [],
      },
      term: { start: null, end: null, minimum_term: null, term_citation: null },
      renewal: {
        auto_renew: true,
        renewal_period: "12 months",
        renewal_citation: citation("renews automatically every 12 months"),
      },
      cancellation: {
        how: "Write to the club.",
        notice_period_days: 30,
        notice_period_text: null,
        penalties: [],
        notice_citation: null,
        penalty_citations: [],
      },
    } as unknown as AnalysisResult["summary"],
    red_flags: [
      {
        type: "Price increase",
        severity: 6,
        explanation: "The club can raise prices every year.",
        where: "Clause 2",
        evidence: null,
        citation: citation("The club may raise prices by 5% once a year."),
        confidence: 80,
      },
      {
        type: "Exit fee",
        severity: 7,
        explanation: "Leaving early costs money.",
        where: "Clause 4",
        evidence: null,
        citation: null,
        confidence: 70,
      },
      {
        type: "Exit fee",
        severity: 3,
        explanation: "The amount of the exit fee is not stated.",
        where: "Schedule 1",
        evidence: null,
        citation: null,
        confidence: 60,
      },
    ],
    key_dates: [
      { type: "PRICE_REVIEW", date: "2027-01-01", derived_from: "Clause 2" },
    ],
    key_date_citations: [],
    obligations: [],
    obligation_citations: [],
    next_actions: {
      questions_to_ask: [
        "Can the renewal be switched off?",
        "How much is the early exit fee?",
      ],
      email_templates: [],
    },
  };
}
