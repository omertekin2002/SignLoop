import { describe, expect, it } from "vitest";
import { finalizeAnalysisResult } from "@/lib/analysis-sources";
import type { AnalysisResult } from "@/lib/schemas";
import { contractAnalysisSegments } from "@/lib/source-citations";
import type { EvalCaseInput } from "./case-schema";
import { buildLoadedCase, type LoadedCase } from "./dataset";
import {
  canonicalDuration,
  caseMetrics,
  changedMetrics,
  classifyField,
  diagnoseQuote,
  imperfections,
  scoreCase,
  summarizeScores,
  type RunOutput,
} from "./score";

const RENEWAL =
  "1. This plan renews automatically for successive one (1) year terms.";
const LINES = [
  "Example Plans LLC and the Subscriber agree as follows.",
  RENEWAL,
  "2. To cancel, give written notice at least ten (10) business days before renewal.",
  "3. Fees are non-refundable. Setup fees are non-refundable.",
  "4. Disputes are heard in the courts of Springfield.",
  "5. The Subscriber\u2019s data is deleted after cancellation.",
];
const RENEWAL_SPAN =
  "This plan renews automatically for successive one (1) year terms.";
const NOTICE_SPAN =
  "give written notice at least ten (10) business days before renewal";

const spec: EvalCaseInput = {
  id: "score-unit",
  title: "Scorer unit case",
  provenance: "synthetic/hand-written",
  contract: "contracts/score-unit.txt",
  context: [],
  clauses: [
    { category: "auto_renewal", required: true, span: RENEWAL_SPAN },
    { category: "cancellation_notice", required: true, span: NOTICE_SPAN },
  ],
  absent: ["arbitration"],
  fields: {
    "summary.renewal.auto_renew": true,
    "summary.renewal.renewal_period": { canon: [1, "year"] },
    "summary.cancellation.notice_period_text": { canon: [10, "business_day"] },
    "summary.cancellation.notice_period_days": null,
  },
  key_dates: [
    { type: "RENEWAL", date: "2027-01-01" },
    { type: "NOTICE_CUTOFF", date: "2026-12-16", required: false },
  ],
  parties: [
    { name: "Example Plans LLC", aliases: ["Example Plans"] },
    { name: "Subscriber" },
  ],
};
const renewing = buildLoadedCase({ spec, text: LINES.join("\n") });
// The same plan with no renewal language: the ideal answer abstains on renewal.
const silent = buildLoadedCase({
  spec: {
    ...spec,
    id: "score-unit-silent",
    clauses: [spec.clauses[1]!],
    fields: {
      ...spec.fields,
      "summary.renewal.auto_renew": null,
      "summary.renewal.renewal_period": null,
    },
  },
  text: LINES.filter((line) => line !== RENEWAL).join("\n"),
});

function idealAnalysis(target: LoadedCase = renewing): AnalysisResult {
  const renews = target === renewing;
  return {
    risk_badge: "MEDIUM",
    key_points: ["Cancellation needs ten business days of notice."],
    summary: {
      what_it_is: "A subscription plan",
      payments: { amount: null, frequency: null, fees: [] },
      term: { start: null, end: null, minimum_term: null },
      renewal: {
        auto_renew: renews ? true : null,
        renewal_period: renews ? "1 year" : null,
      },
      cancellation: {
        how: "Written notice",
        notice_period_days: null,
        notice_period_text: "10 business days",
        penalties: [],
      },
    },
    red_flags: [
      ...(renews
        ? [
            {
              type: "Automatic renewal",
              severity: 5,
              explanation: "Renews every year.",
              where: "Section 1",
              confidence: 90,
              evidence: { quote: RENEWAL_SPAN, segment: "full" as const },
            },
          ]
        : []),
      {
        type: "Cancellation notice period",
        severity: 4,
        explanation: "Ten business days of notice.",
        where: "Section 2",
        confidence: 90,
        evidence: { quote: NOTICE_SPAN, segment: "full" as const },
      },
    ],
    normal_in_region: [],
    next_actions: { questions_to_ask: [], email_templates: [] },
    key_dates: [{ type: "RENEWAL", date: "2027-01-01", derived_from: null }],
    obligations: [],
    parties: ["Example Plans LLC (Provider)", "The Subscriber"],
    disclaimer: "This is an AI analysis, not legal advice.",
  };
}

function runOf(
  analysis: AnalysisResult,
  target: LoadedCase = renewing,
): RunOutput {
  return {
    analysis,
    stored: finalizeAnalysisResult(analysis, {
      id: target.contractId,
      text: target.text,
    }),
    parsePath: "strict",
  };
}
const metricsOf = (analysis: AnalysisResult, target: LoadedCase = renewing) =>
  caseMetrics(scoreCase(target, runOf(analysis, target)));

describe("durations", () => {
  it.each([
    ["10 business days", [10, "business_day"]],
    ["ten (10) business days", [10, "business_day"]],
    ["5 working days", [5, "business_day"]],
    ["not less than thirty (30) days\u2019 prior written notice", [30, "day"]],
    ["15 calendar days", [15, "day"]],
    ["forty-five days", [45, "day"]],
    ["two weeks", [14, "day"]],
    ["one (1) year", [12, "month"]],
    ["successive twelve (12) month terms", [12, "month"]],
    ["12-month", [12, "month"]],
    ["1 month (month to month)", [1, "month"]],
    ["month-to-month", [1, "month"]],
  ])("reads %j as %j", (text, expected) => {
    expect(canonicalDuration(text)).toEqual(expected);
  });

  it.each(["Not specified", "within a reasonable period", "upon renewal"])(
    "finds no duration in %j",
    (text) => {
      expect(canonicalDuration(text)).toBeNull();
    },
  );
});

describe("abstention", () => {
  it.each([
    [true, true, true, "correct"],
    [true, true, false, "wrong"],
    [true, false, false, "false_abstention"],
    [false, false, false, "correct_abstention"],
    [false, true, false, "fabricated"],
  ] as const)(
    "gold known %s, predicted %s, same %s is %s",
    (goldKnown, predictedKnown, same, outcome) => {
      expect(classifyField(goldKnown, predictedKnown, same)).toBe(outcome);
    },
  );

  it("compares notice as (number, unit) and treats placeholders as abstaining", () => {
    const outcomeFor = (wording: string) => {
      const analysis = idealAnalysis();
      analysis.summary.cancellation.notice_period_text = wording;
      return metricsOf(analysis)[
        "fields.summary.cancellation.notice_period_text"
      ];
    };
    expect(outcomeFor("ten (10) business days")).toBe("correct");
    expect(outcomeFor("10 days")).toBe("wrong");
    expect(outcomeFor("Not specified")).toBe("false_abstention");
  });

  it("treats false for an unknown renewal as the critical error", () => {
    const guessed = idealAnalysis(silent);
    guessed.summary.renewal.auto_renew = false;
    const score = scoreCase(silent, runOf(guessed, silent));
    expect(score.autoRenew).toEqual({
      gold: null,
      predicted: false,
      critical: true,
    });
    expect(score.fields["summary.renewal.auto_renew"]?.outcome).toBe(
      "fabricated",
    );

    const summary = summarizeScores([
      score,
      scoreCase(renewing, runOf(idealAnalysis())),
    ]);
    expect(summary.criticalErrors).toBe(1);
    expect(summary.autoRenewConfusion).toEqual({
      true: { true: 1, false: 0, null: 0 },
      false: { true: 0, false: 0, null: 0 },
      null: { true: 0, false: 1, null: 0 },
    });
  });
});

describe("clause recall and span precision", () => {
  it("finds a clause when at least half of a verified quotation lies inside it", () => {
    const analysis = idealAnalysis();
    analysis.red_flags[0]!.evidence = {
      quote: "1. This plan renews automatically",
      segment: "full",
    };
    expect(
      scoreCase(renewing, runOf(analysis)).clauses.byCategory.auto_renewal,
    ).toEqual({
      required: 1,
      found: 1,
    });

    const outside = "Subscriber agree as follows.\n1. This";
    analysis.red_flags[0]!.evidence = { quote: outside, segment: "full" };
    const score = scoreCase(renewing, runOf(analysis));
    expect(score.quotes.verified).toBe(2);
    expect(score.clauses.byCategory.auto_renewal).toEqual({
      required: 1,
      found: 0,
    });
    expect(score.clauses.recall).toBe(0.5);
    expect(score.spans.precision).toBe(
      ("This".length + NOTICE_SPAN.length) /
        (outside.length + NOTICE_SPAN.length),
    );
  });

  it("ignores unverified quotations and still credits a correctly named flag", () => {
    const analysis = idealAnalysis();
    analysis.red_flags[0]!.evidence = {
      quote: "This plan renews forever.",
      segment: "full",
    };
    const score = scoreCase(renewing, runOf(analysis));
    expect(score.clauses.found).toBe(1);
    expect(score.clauses.labelRecall).toBe(1);
    expect(score.spans.precision).toBe(1);
    expect(score.quotes).toMatchObject({
      flags: 2,
      withEvidence: 2,
      verified: 1,
    });
  });

  it("scores a rejected run as finding nothing", () => {
    const metrics = caseMetrics(
      scoreCase(renewing, {
        analysis: null,
        stored: null,
        parsePath: "rejected",
      }),
    );
    expect(imperfections(metrics)).toEqual({
      "clauses.recall": 0,
      "clauses.category.auto_renewal": 0,
      "clauses.category.cancellation_notice": 0,
      "labels.recall": 0,
      "dates.recall": 0,
      "parties.recall": 0,
      "parse.path": "rejected",
      "coverage.notice": false,
      "comparisons.withheld": false,
      "fields.summary.renewal.auto_renew": "no_result",
      "fields.summary.renewal.renewal_period": "no_result",
      "fields.summary.cancellation.notice_period_text": "no_result",
      "fields.summary.cancellation.notice_period_days": "no_result",
    });
  });
});

describe("quote diagnosis", () => {
  const filler = (character: string, length: number) =>
    character.repeat(length);
  const longText = [
    "Head clause: fees renew yearly.",
    filler("x", 9800),
    "Middle clause: renewal is automatic.",
    filler("y", 5300),
    "Tail clause: disputes go to court.",
    filler("z", 100),
  ].join(" ");
  const short = {
    text: renewing.text,
    segments: renewing.segments,
    contextTexts: ["Template text: renewal is optional."],
    prompt: 'Evidence must contain "quote" (exact contract wording).',
  };
  const long = {
    text: longText,
    segments: contractAnalysisSegments(longText),
    contextTexts: [],
  };

  it.each([
    ["too_long", short, { quote: "a".repeat(2001), segment: "full" }],
    ["ambiguous", short, { quote: "are non-refundable", segment: "full" }],
    ["wrong_segment", short, { quote: RENEWAL_SPAN, segment: "head" }],
    [
      "wrong_segment",
      long,
      { quote: "Tail clause: disputes go to court.", segment: "head" },
    ],
    [
      "omitted_middle",
      long,
      { quote: "Middle clause: renewal is automatic.", segment: "head" },
    ],
    [
      "omission_marker",
      long,
      {
        quote: "[5300 characters omitted from the middle of the contract]",
        segment: "head",
      },
    ],
    [
      "quoted_context",
      short,
      { quote: "renewal is optional", segment: "full" },
    ],
    [
      "quoted_prompt",
      short,
      { quote: "exact contract wording", segment: "full" },
    ],
    [
      "whitespace_drift",
      short,
      { quote: "agree as follows. 1. This plan", segment: "full" },
    ],
    [
      "typography_drift",
      short,
      { quote: "The Subscriber's data is deleted", segment: "full" },
    ],
    [
      "typography_drift",
      short,
      { quote: "this plan renews automatically", segment: "full" },
    ],
    [
      "unicode_drift",
      short,
      { quote: "courts of Spring\uFB01eld", segment: "full" },
    ],
    [
      "near_miss",
      short,
      {
        quote: "This plan automatically renews for further one year terms",
        segment: "full",
      },
    ],
    [
      "fabricated",
      short,
      { quote: "Early exit costs three months of charges", segment: "full" },
    ],
  ] as const)("diagnoses %s", (diagnosis, source, evidence) => {
    expect(diagnoseQuote(evidence, source)).toBe(diagnosis);
  });
});

describe("negative controls, dates, and parties", () => {
  it("counts flags naming an absent category and alarms on benign contracts", () => {
    const analysis = idealAnalysis();
    analysis.red_flags.push({
      type: "Mandatory arbitration",
      severity: 8,
      explanation: "Disputes go to arbitration.",
      where: null,
      confidence: 40,
      evidence: null,
    });
    const score = scoreCase(renewing, runOf(analysis));
    expect(score.negatives).toEqual({
      falseFlags: [
        { flag: 2, type: "Mandatory arbitration", categories: ["arbitration"] },
      ],
      benignAlarms: null,
    });
    expect(score.quotes.evidenceRate).toBe(2 / 3);

    const benign = buildLoadedCase({
      spec: { ...spec, id: "score-unit-benign", benign: true },
      text: renewing.text,
    });
    analysis.risk_badge = "HIGH";
    expect(
      scoreCase(benign, runOf(analysis, benign)).negatives.benignAlarms,
    ).toBe(2);
  });

  it("counts comparisons proposed without a jurisdiction and requires the stored report to withhold them", () => {
    const analysis = idealAnalysis();
    analysis.normal_in_region = [
      {
        topic: "Cancellation notice",
        typical_range: "Usually 30 days",
        yours: "10 business days",
        label: "typical",
      },
    ];
    const run = runOf(analysis);
    expect(scoreCase(renewing, run).comparisons).toEqual({
      proposed: 1,
      withheld: true,
    });

    // A report that kept the comparisons, or lost the server's flag, fails the stored-side check.
    for (const stored of [
      { ...run.stored!, normal_in_region: analysis.normal_in_region },
      { ...run.stored!, comparisons_withheld: false },
    ]) {
      expect(
        imperfections(caseMetrics(scoreCase(renewing, { ...run, stored }))),
      ).toEqual({
        "negatives.unsupported_comparisons": 1,
        "comparisons.withheld": false,
      });
    }
  });

  it("matches ISO dates and party aliases", () => {
    const analysis = idealAnalysis();
    analysis.key_dates = [
      { type: "OTHER", date: "2027-01-01 (first renewal)", derived_from: null },
      {
        type: "NOTICE_CUTOFF",
        date: "2026-12-16",
        derived_from: "Ten business days earlier",
      },
      { type: "OTHER", date: "2025-01-01", derived_from: null },
      { type: "OTHER", date: "Upon renewal", derived_from: null },
    ];
    analysis.parties = ["Example Plans (Provider)", "A Different Company"];
    const score = scoreCase(renewing, runOf(analysis));
    expect(score.dates).toEqual({
      required: 1,
      matched: 1,
      recall: 1,
      unsupported: ["2025-01-01"],
      typeMismatches: 1,
    });
    expect(score.parties).toEqual({
      gold: 2,
      matched: 1,
      recall: 0.5,
      unmatchedPredicted: ["A Different Company"],
    });
  });
});

describe("metric isolation", () => {
  it.each([
    {
      name: "paraphrased quote",
      target: renewing,
      change: (analysis: AnalysisResult) => {
        analysis.red_flags[0]!.evidence = {
          quote: "This plan automatically renews for further one year terms",
          segment: "full",
        };
      },
      moved: [
        "clauses.category.auto_renewal",
        "clauses.recall",
        "quotes.diagnosis.near_miss",
        "quotes.verification_rate",
      ],
    },
    {
      name: "wrong segment",
      target: renewing,
      change: (analysis: AnalysisResult) => {
        analysis.red_flags[1]!.evidence = {
          quote: NOTICE_SPAN,
          segment: "tail",
        };
      },
      moved: [
        "clauses.category.cancellation_notice",
        "clauses.recall",
        "quotes.diagnosis.wrong_segment",
        "quotes.verification_rate",
      ],
    },
    {
      name: "false instead of null",
      target: silent,
      change: (analysis: AnalysisResult) => {
        analysis.summary.renewal.auto_renew = false;
      },
      moved: ["auto_renew.critical", "fields.summary.renewal.auto_renew"],
    },
    {
      name: "lost notice unit",
      target: renewing,
      change: (analysis: AnalysisResult) => {
        analysis.summary.cancellation.notice_period_text = "10 days";
      },
      moved: ["fields.summary.cancellation.notice_period_text"],
    },
    {
      name: "unsupported comparison",
      target: renewing,
      change: (analysis: AnalysisResult) => {
        analysis.normal_in_region = [
          {
            topic: "Cancellation notice",
            typical_range: "Usually 30 days",
            yours: "10 business days",
            label: "typical",
          },
        ];
      },
      moved: ["negatives.unsupported_comparisons"],
    },
  ])("$name moves only its targeted metrics", ({ target, change, moved }) => {
    const before = metricsOf(idealAnalysis(target), target);
    expect(imperfections(before)).toEqual({});
    const analysis = idealAnalysis(target);
    change(analysis);
    const after = metricsOf(analysis, target);
    expect(changedMetrics(before, after)).toEqual(moved);
    expect(Object.keys(imperfections(after)).sort()).toEqual(moved);
  });

  it("micro-averages recall across cases", () => {
    const paraphrased = idealAnalysis();
    paraphrased.red_flags[0]!.evidence = {
      quote: "Renews yearly.",
      segment: "full",
    };
    const summary = summarizeScores([
      scoreCase(renewing, runOf(idealAnalysis())),
      scoreCase(renewing, runOf(paraphrased)),
    ]);
    expect(summary.clauseRecall).toBe(0.75);
    expect(summary.byCategory.auto_renewal).toEqual({ required: 2, found: 1 });
    expect(summary.quotes.diagnoses).toEqual({ fabricated: 1 });
  });

  it("refuses to judge a metric without a defined ideal", () => {
    expect(() => imperfections({ "mystery.metric": 1 })).toThrow(
      /No ideal value/,
    );
  });
});
