import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeAnalysisResult } from "./analysis-sources";
import {
  citationForReport,
  CONTRACT_ANALYSIS_LIMIT,
  contractAnalysisCoverage,
  contractAnalysisSegments,
  PAYMENT_CITATION,
} from "./source-citations";
import {
  completed,
  contractOf,
  failure,
  hang,
  mergeOutput,
  provider,
  sectionOutput,
} from "./fixtures/analysis-provider";

const CONTRACT_ID = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("PRIMARY_LLM_BASE_URL", "https://analysis.test/v1");
  vi.stubEnv("PRIMARY_LLM_API_KEY", "test-primary-key");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("analysis of contracts longer than one request", () => {
  it("makes exactly one call for a contract within the limit", async () => {
    const text = "😀".repeat(CONTRACT_ANALYSIS_LIMIT - 20) + " Monthly fee.";
    const segments = contractAnalysisSegments(text);
    expect(segments).toHaveLength(1);
    const double = provider(segments, () =>
      completed(sectionOutput(segments[0]!)),
    );
    const { analyzeText } = await import("./analysis");

    await analyzeText(text);
    expect(double.calls).toHaveLength(1);
    expect(double.calls[0]!.input).toContain(
      "Contract segment: full (Unicode code points 0–",
    );
  });

  it("analyses a contract just over the limit in two sections plus one merge, summing usage", async () => {
    const text = contractOf(175);
    const segments = contractAnalysisSegments(text);
    expect(Array.from(text).length).toBeGreaterThan(CONTRACT_ANALYSIS_LIMIT);
    expect(segments).toHaveLength(2);
    const double = provider(segments, (call) =>
      call.section === "merge"
        ? completed(mergeOutput(), { input: 50, output: 30 })
        : completed(sectionOutput(double.segment(call)), {
            input: 1000,
            output: 200,
          }),
    );
    const { analyzeText } = await import("./analysis");

    const answer = await analyzeText(text);
    expect(double.sectionCalls().map((call) => call.section)).toEqual([1, 2]);
    expect(double.mergeCalls()).toHaveLength(1);
    expect(answer.promptTokens).toBe(2050);
    expect(answer.completionTokens).toBe(430);
    expect(answer.result.coverage_notices).toBeUndefined();
    expect(answer.result.summary.renewal.auto_renew).toBe(true);
  });

  it("sends every section once, in full, with at most the fixed number of calls at a time", async () => {
    const text = contractOf(1100);
    const segments = contractAnalysisSegments(text);
    expect(segments.length).toBeGreaterThan(6);
    const double = provider(segments, (call) =>
      call.section === "merge"
        ? completed(mergeOutput())
        : completed(sectionOutput(double.segment(call))),
    );
    const { analyzeText, SECTION_CONCURRENCY } = await import("./analysis");

    await analyzeText(text);
    const sections = double.sectionCalls();
    expect(
      sections.map((call) => call.section).sort((a, b) => +a - +b),
    ).toEqual(segments.map((_, index) => index + 1));
    for (const call of sections) {
      const segment = double.segment(call);
      expect(call.input).toContain(
        `Contract segment: ${segment.label} (Unicode code points ${segment.start}–${segment.end}, end exclusive)\n${segment.text}\n--- END UNTRUSTED CONTRACT ---`,
      );
      expect(call.input).toContain(
        `section ${call.section} of ${segments.length} only`,
      );
    }
    expect(segments.map((part) => part.text).join("")).toBe(text);
    expect(double.mergeCalls()).toHaveLength(1);
    expect(double.maxInFlight()).toBe(SECTION_CONCURRENCY);
  });

  it("keeps the merge's chosen flags verbatim, verifies a deep quotation, and drops quotations the merge invents", async () => {
    const renewal =
      "350.2 Renewal. This Agreement renews automatically for one (1) year unless notice of non-renewal is given.\n";
    const law =
      "690.1 Governing law. This Agreement is governed by the laws of the State of Delaware.\n";
    const text = contractOf(700, { 350: renewal, 690: law });
    expect(Array.from(text).length).toBeGreaterThan(60_000);
    const segments = contractAnalysisSegments(text);
    const deep = segments.find((part) => part.text.includes(renewal))!;
    const last = segments.find((part) => part.text.includes(law))!;
    expect(deep.label).not.toBe("section-1");
    const renewalQuote = "renews automatically for one (1) year";
    const lawQuote = "governed by the laws of the State of Delaware";
    const deepNumber = Number(deep.label.slice("section-".length));
    const double = provider(segments, (call) => {
      if (call.section === "merge") {
        return completed(
          mergeOutput({
            red_flag_ids: [`S${deepNumber}-F1`, `s${deepNumber}-f1`, "S99-F1"],
            red_flags: [
              {
                type: "Invented",
                explanation: "Not from any section.",
                evidence: {
                  quote: "Records. Each party",
                  segment: "section-1",
                },
              },
            ],
            proposed_jurisdiction: {
              jurisdiction: "Ontario",
              evidence: { quote: "Records", segment: "section-1" },
            },
          }),
        );
      }
      const segment = double.segment(call);
      return completed(
        sectionOutput(segment, {
          flags:
            segment === deep
              ? [
                  {
                    type: "Automatic renewal",
                    explanation: "Renews each year unless notice is given.",
                    quote: renewalQuote,
                  },
                ]
              : [],
          jurisdiction: segment === last ? lawQuote : undefined,
        }),
      );
    });
    const { analyzeText } = await import("./analysis");

    const answer = await analyzeText(text);
    const merge = double.mergeCalls()[0]!;
    expect(merge.input).toContain(`"id": "S${deepNumber}-F1"`);
    expect(merge.input).toContain(renewalQuote);
    expect(answer.result.red_flags).toEqual([
      expect.objectContaining({
        type: "Automatic renewal",
        evidence: { quote: renewalQuote, segment: deep.label },
      }),
    ]);
    expect(answer.result.proposed_jurisdiction).toEqual({
      jurisdiction: "State of Delaware",
      evidence: { quote: lawQuote, segment: last.label },
    });

    const stored = finalizeAnalysisResult(answer.result, {
      id: CONTRACT_ID,
      text,
    });
    const at = (quote: string) =>
      Array.from(text.slice(0, text.indexOf(quote))).length;
    expect(stored.red_flags[0]!.citation).toMatchObject({
      quote: renewalQuote,
      start: at(renewalQuote),
      end: at(renewalQuote) + renewalQuote.length,
    });
    expect(stored.proposed_jurisdiction?.citation).toMatchObject({
      start: at(lawQuote),
      end: at(lawQuote) + lawQuote.length,
    });
  });

  it("removes red flags and questions that two sections report for the same clause", async () => {
    const text = contractOf(320);
    const segments = contractAnalysisSegments(text);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    const duplicate = {
      type: "Unlimited liability",
      explanation: "Liability is not capped.",
    };
    const question = "Can liability be capped?";
    const double = provider(segments, (call) =>
      call.section === "merge"
        ? completed(
            mergeOutput({
              red_flag_ids: segments.map((_, index) => `S${index + 1}-F1`),
              next_actions: {
                questions_to_ask: [question, ` can LIABILITY be capped? `],
                email_templates: [],
              },
            }),
          )
        : completed(
            sectionOutput(double.segment(call), {
              flags: [duplicate],
              questions: [question],
            }),
          ),
    );
    const { analyzeText } = await import("./analysis");

    const answer = await analyzeText(text);
    expect(answer.result.red_flags).toHaveLength(1);
    expect(answer.result.red_flags[0]).toMatchObject(duplicate);
    expect(answer.result.next_actions.questions_to_ask).toEqual([question]);
  });

  it("keeps different risks that quote the same clause", async () => {
    const text = contractOf(320);
    const segments = contractAnalysisSegments(text);
    const quote = "1. Records. Each party keeps accurate records";
    const double = provider(segments, (call) =>
      call.section === "merge"
        ? completed(mergeOutput({ red_flag_ids: ["S1-F1", "S1-F2"] }))
        : completed(
            sectionOutput(double.segment(call), {
              flags:
                call.section === 1
                  ? [
                      {
                        type: "Record keeping",
                        explanation: "Records are required.",
                        quote,
                      },
                      {
                        type: "Audit exposure",
                        explanation: "Records may be audited.",
                        quote,
                      },
                    ]
                  : [],
            }),
          ),
    );
    const { analyzeText } = await import("./analysis");

    const answer = await analyzeText(text);
    expect(answer.result.red_flags.map((flag) => flag.type)).toEqual([
      "Record keeping",
      "Audit exposure",
    ]);
  });

  it("combines sections without a model when the merge call fails", async () => {
    const text = contractOf(320);
    const segments = contractAnalysisSegments(text);
    const double = provider(segments, (call) => {
      if (call.section === "merge") return failure();
      const index = (call.section as number) - 1;
      return completed(
        sectionOutput(double.segment(call), {
          badge: index === 1 ? "HIGH" : "LOW",
          flags: [
            {
              type: "Unlimited liability",
              explanation: "Liability is not capped.",
            },
            ...(index === 1
              ? [{ type: "Automatic renewal", explanation: "Renews yearly." }]
              : []),
          ],
          questions: ["Can liability be capped?"],
          autoRenew: index === 1 ? true : null,
          noticeDays: index === 1 ? 60 : null,
          noticeText: index === 1 ? "60 days" : null,
        }),
      );
    });
    const { analyzeText } = await import("./analysis");

    const answer = await analyzeText(text);
    expect(double.mergeCalls()).toHaveLength(1);
    expect(answer.result.risk_badge).toBe("HIGH");
    expect(answer.result.red_flags.map((flag) => flag.type)).toEqual([
      "Unlimited liability",
      "Automatic renewal",
    ]);
    expect(answer.result.next_actions.questions_to_ask).toEqual([
      "Can liability be capped?",
    ]);
    expect(answer.result.summary.renewal.auto_renew).toBe(true);
    expect(answer.result.summary.cancellation).toMatchObject({
      notice_period_days: 60,
      notice_period_text: "60 days",
    });
    expect(answer.result.key_points).toEqual(
      segments.map((segment) => `Covers ${segment.label}.`),
    );
  });

  it("names a failed section and its range in the coverage notices and keeps the others' findings", async () => {
    const text = contractOf(400);
    const segments = contractAnalysisSegments(text);
    expect(segments).toHaveLength(3);
    const double = provider(segments, (call) => {
      if (call.section === 2) return failure();
      if (call.section === "merge")
        return completed(mergeOutput({ red_flag_ids: ["S1-F1", "S3-F1"] }));
      return completed(
        sectionOutput(double.segment(call), {
          flags: [
            { type: `Risk in ${call.section}`, explanation: "Found here." },
          ],
        }),
      );
    });
    const { analyzeText } = await import("./analysis");

    const answer = await analyzeText(text);
    const notice = `Contract section 2 of ${segments.length} (Unicode code points ${segments[1]!.start}–${segments[1]!.end}, end exclusive) could not be analysed because the model call failed; terms in that text are not reflected in this analysis.`;
    expect(answer.result.coverage_notices).toEqual([notice]);
    expect(answer.result.key_points[0]).toBe(notice);
    expect(answer.result.red_flags.map((flag) => flag.type)).toEqual([
      "Risk in 1",
      "Risk in 3",
    ]);
    expect(double.mergeCalls()[0]!.input).not.toContain('"section": 2,');
  });

  it("reports sections still unanalysed at the deadline as one range and returns the rest", async () => {
    const text = contractOf(900);
    const segments = contractAnalysisSegments(text);
    expect(segments).toHaveLength(6);
    const double = provider(segments, (call) => {
      if (call.section === "merge") return completed(mergeOutput());
      return (call.section as number) <= 2
        ? completed(sectionOutput(double.segment(call)))
        : hang(call);
    });
    const { analyzeText, MERGE_RESERVE_MS } = await import("./analysis");

    const answer = await analyzeText(text, undefined, {
      deadline: Date.now() + MERGE_RESERVE_MS + 300,
    });
    expect(answer.result.coverage_notices).toEqual([
      `Contract sections 3–6 of 6 (Unicode code points ${segments[2]!.start}–${segments[5]!.end}, end exclusive) could not be analysed before the analysis deadline; terms in that text are not reflected in this analysis.`,
    ]);
    expect(double.mergeCalls()).toHaveLength(1);
    expect(answer.result.summary.renewal.auto_renew).toBe(true);
  });

  it("accepts a section that states no renewal or cancellation terms and keeps its parties and fees", async () => {
    const text = contractOf(320);
    const segments = contractAnalysisSegments(text);
    expect(segments).toHaveLength(2);
    const double = provider(segments, (call) => {
      if (call.section === "merge") return failure();
      const output = sectionOutput(double.segment(call));
      if (call.section === 1) return completed(output);
      // A fee schedule: no renewal facts and no cancellation method.
      return completed({
        ...output,
        summary: {
          ...output.summary,
          payments: { amount: null, frequency: null, fees: ["Setup fee"] },
          renewal: undefined,
          cancellation: { how: null, penalties: [] },
        },
        parties: ["Payment processor"],
      });
    });
    const { analyzeText } = await import("./analysis");

    const answer = await analyzeText(text);
    expect(answer.result.coverage_notices).toBeUndefined();
    expect(answer.result.summary.payments.fees).toEqual(["Setup fee"]);
    expect(answer.result.parties).toContain("Payment processor");
    expect(answer.result.summary.renewal.auto_renew).toBeNull();
  });

  it("analyses at most the section limit and names the remaining sections in one notice", async () => {
    const { analyzeText, MAX_ANALYSED_SECTIONS } = await import("./analysis");
    const text = contractOf(175 * (MAX_ANALYSED_SECTIONS + 2));
    const segments = contractAnalysisSegments(text);
    expect(segments.length).toBeGreaterThan(MAX_ANALYSED_SECTIONS);
    const double = provider(segments, (call) =>
      call.section === "merge"
        ? completed(mergeOutput())
        : completed(sectionOutput(double.segment(call))),
    );

    const answer = await analyzeText(text);
    expect(
      double
        .sectionCalls()
        .map((call) => call.section)
        .sort((a, b) => +a - +b),
    ).toEqual(
      segments.slice(0, MAX_ANALYSED_SECTIONS).map((_, index) => index + 1),
    );
    expect(double.mergeCalls()).toHaveLength(1);
    expect(answer.result.coverage_notices).toEqual([
      `Contract sections ${MAX_ANALYSED_SECTIONS + 1}–${segments.length} of ${segments.length} (Unicode code points ${segments[MAX_ANALYSED_SECTIONS]!.start}–${segments.at(-1)!.end}, end exclusive) could not be analysed because one analysis covers at most ${MAX_ANALYSED_SECTIONS} sections; terms in that text are not reflected in this analysis.`,
    ]);
  });

  it.each([
    ["one section", 1],
    ["several sections within the cap", 3],
    ["more sections than one analysis covers", 3 * 16],
  ])(
    "reports the coverage the analysis then runs for a contract of %s",
    async (_label, clauses) => {
      const { analyzeText, MAX_ANALYSED_SECTIONS } = await import("./analysis");
      const text = clauses === 1 ? "1. Monthly fee." : contractOf(175 * clauses);
      const segments = contractAnalysisSegments(text);
      expect(segments.length === 1).toBe(clauses === 1);
      expect(segments.length > MAX_ANALYSED_SECTIONS).toBe(
        clauses > MAX_ANALYSED_SECTIONS,
      );
      const coverage = await contractAnalysisCoverage(
        Array.from(text).length,
        () => text,
      );
      const double = provider(segments, (call) =>
        segments.length === 1
          ? completed(sectionOutput(segments[0]!))
          : call.section === "merge"
            ? completed(mergeOutput())
            : completed(sectionOutput(double.segment(call))),
      );

      const answer = await analyzeText(text);

      expect(coverage.sectionCount).toBe(segments.length);
      expect(coverage.characterCount).toBe(Array.from(text).length);
      // A single-section contract is one call; a longer one is one call per section plus a merge.
      expect(
        segments.length === 1
          ? double.calls.length
          : double.sectionCalls().length,
      ).toBe(coverage.analysedSectionCount);
      const overLimit = (answer.result.coverage_notices ?? []).filter(
        (notice) => notice.includes("one analysis covers at most"),
      );
      if (coverage.uncoveredFrom === null) {
        expect(coverage.analysedSectionCount).toBe(segments.length);
        expect(overLimit).toEqual([]);
      } else {
        expect(coverage.analysedSectionCount).toBe(MAX_ANALYSED_SECTIONS);
        expect(overLimit).toEqual([
          `Contract sections ${coverage.analysedSectionCount + 1}–${coverage.sectionCount} of ${coverage.sectionCount} (Unicode code points ${coverage.uncoveredFrom}–${coverage.characterCount}, end exclusive) could not be analysed because one analysis covers at most ${MAX_ANALYSED_SECTIONS} sections; terms in that text are not reflected in this analysis.`,
        ]);
      }
    },
  );

  it("does not load the text to count the sections of a contract within the limit", async () => {
    const loadText = vi.fn(() => "unused");
    expect(
      await contractAnalysisCoverage(CONTRACT_ANALYSIS_LIMIT, loadText),
    ).toEqual({
      characterCount: CONTRACT_ANALYSIS_LIMIT,
      sectionCount: 1,
      analysedSectionCount: 1,
      uncoveredFrom: null,
    });
    expect(loadText).not.toHaveBeenCalled();
  });

  it("reads loosely formatted red flag IDs and keeps every flag when one cannot be read", async () => {
    const text = contractOf(400);
    const segments = contractAnalysisSegments(text);
    expect(segments).toHaveLength(3);
    const run = async (ids: string[]) => {
      const double = provider(segments, (call) =>
        call.section === "merge"
          ? completed(mergeOutput({ red_flag_ids: ids }))
          : completed(
              sectionOutput(double.segment(call), {
                flags: [
                  { type: `Risk ${call.section}a`, explanation: "First." },
                  { type: `Risk ${call.section}b`, explanation: "Second." },
                ],
              }),
            ),
      );
      const { analyzeText } = await import("./analysis");
      return (await analyzeText(text)).result.red_flags.map(
        (flag) => flag.type,
      );
    };

    expect(await run(["S1-F1", "S3 F2", "s2-f01", "S99-F1"])).toEqual([
      "Risk 1a",
      "Risk 3b",
      "Risk 2a",
    ]);
    expect(await run(["S1-F1", "the renewal flag"])).toEqual([
      "Risk 1a",
      "Risk 1b",
      "Risk 2a",
      "Risk 2b",
      "Risk 3a",
      "Risk 3b",
    ]);
  });

  it("uses a later section's governing-law proposal when an earlier one's quotation is not in its section", async () => {
    const law =
      "390.1 Governing law. This Agreement is governed by the laws of the State of Delaware.\n";
    const text = contractOf(400, { 390: law });
    const segments = contractAnalysisSegments(text);
    const last = segments.find((part) => part.text.includes(law))!;
    expect(last.label).not.toBe("section-1");
    const lawQuote = "governed by the laws of the State of Delaware";
    for (const mergeFails of [false, true]) {
      const double = provider(segments, (call) => {
        if (call.section === "merge")
          return mergeFails ? failure() : completed(mergeOutput());
        const segment = double.segment(call);
        return completed(
          sectionOutput(segment, {
            jurisdiction:
              segment === last
                ? lawQuote
                : call.section === 1
                  ? "governed by the laws of Delaware"
                  : undefined,
          }),
        );
      });
      const { analyzeText } = await import("./analysis");

      const answer = await analyzeText(text);
      expect(double.mergeCalls()).toHaveLength(1);
      expect(answer.result.proposed_jurisdiction).toEqual({
        jurisdiction: "State of Delaware",
        evidence: { quote: lawQuote, segment: last.label },
      });
      const stored = finalizeAnalysisResult(answer.result, {
        id: CONTRACT_ID,
        text,
      });
      expect(stored.proposed_jurisdiction?.citation?.quote).toBe(lawQuote);
    }
  });

  describe("notice-period quotations", () => {
    const notice =
      "200.1 Notice. Either party may end this Agreement on sixty (60) days' written notice.\n";
    const noticeQuote = "Either party may end this Agreement on sixty (60) days' written notice.";
    const text = contractOf(400, { 200: notice });
    const segments = contractAnalysisSegments(text);
    const cited = segments.find((part) => part.text.includes(notice))!;
    const citedNumber = Number(cited.label.slice("section-".length));

    // Section `citedNumber` states 60 days with its quotation; `others` sets the rest.
    async function analyse(
      merge: "fails" | Record<string, unknown>,
      others: { noticeDays?: number | null; noticeText?: string | null; noticeQuote?: string } = {},
    ) {
      const double = provider(segments, (call) => {
        if (call.section === "merge")
          return merge === "fails" ? failure() : completed(mergeOutput(merge));
        return completed(
          sectionOutput(
            double.segment(call),
            call.section === citedNumber
              ? { noticeDays: 60, noticeText: "60 days", noticeQuote }
              : others,
          ),
        );
      });
      const { analyzeText } = await import("./analysis");
      const answer = await analyzeText(text);
      expect(double.mergeCalls()).toHaveLength(1);
      return {
        answer,
        stored: finalizeAnalysisResult(answer.result, { id: CONTRACT_ID, text }),
      };
    }

    it("carries the quotation with the duration of the section that supplied it when the merge call fails", async () => {
      expect(citedNumber).toBeGreaterThan(1);
      const { answer, stored } = await analyse("fails", {
        noticeDays: null,
        noticeText: null,
        // A section stating no notice period never lends its quotation.
        noticeQuote: "Records. Each party",
      });
      expect(answer.result.summary.cancellation).toMatchObject({
        notice_period_days: 60,
        notice_period_text: "60 days",
        notice_evidence: { quote: noticeQuote, segment: cited.label },
      });
      const start = text.indexOf(noticeQuote);
      expect(stored.summary.cancellation.notice_citation).toMatchObject({
        status: "verified",
        quote: noticeQuote,
        start: Array.from(text.slice(0, start)).length,
      });
    });

    it("keeps a section's quotation when the merged value equals it, never the merge model's", async () => {
      const { answer, stored } = await analyse({
        summary: {
          ...mergeOutput().summary,
          cancellation: {
            how: "Written notice",
            notice_period_days: 60,
            notice_period_text: "60 days",
            penalties: [],
            notice_evidence: { quote: "Records. Each party", segment: "section-1" },
            notice_citation: { status: "verified", quote: "Records", start: 0, end: 7 },
          },
        },
      });
      expect(answer.result.summary.cancellation.notice_evidence).toEqual({
        quote: noticeQuote,
        segment: cited.label,
      });
      expect(stored.summary.cancellation.notice_citation?.quote).toBe(noticeQuote);
    });

    it("drops the quotation when another section states a different notice period", async () => {
      const { answer, stored } = await analyse({}, {
        noticeDays: 30,
        noticeText: "30 days",
      });
      expect(answer.result.summary.cancellation.notice_period_text).toBe("60 days");
      expect(answer.result.summary.cancellation.notice_evidence).toBeNull();
      expect(stored.summary.cancellation.notice_citation).toBeNull();
    });

    it("has no quotation for a merged value that differs from every cited section", async () => {
      const { answer, stored } = await analyse({
        summary: {
          ...mergeOutput().summary,
          cancellation: {
            how: "Written notice",
            notice_period_days: 90,
            notice_period_text: "90 days",
            penalties: [],
          },
        },
      });
      expect(answer.result.summary.cancellation.notice_period_days).toBe(90);
      expect(answer.result.summary.cancellation.notice_evidence).toBeNull();
      expect(stored.summary.cancellation.notice_citation).toBeNull();
      expect(stored.summary.cancellation.notice_period_text).toBe("90 days");
    });

    it("ignores a section's quotation that is not in that section", async () => {
      // Every section states 60 days and claims the clause, but only one section contains it.
      const double = provider(segments, (call) =>
        call.section === "merge"
          ? failure()
          : completed(
              sectionOutput(double.segment(call), {
                noticeDays: 60,
                noticeText: "60 days",
                noticeQuote,
              }),
            ),
      );
      const { analyzeText } = await import("./analysis");
      const answer = await analyzeText(text);
      // The first section supplies the value but cannot quote it; the section stating the same value
      // that does contain the clause supplies the quotation.
      expect(answer.result.summary.cancellation.notice_evidence).toEqual({
        quote: noticeQuote,
        segment: cited.label,
      });
    });
  });

  describe("renewal quotations", () => {
    const clause =
      "300.1 Renewal. This Agreement renews automatically for successive one-year terms.\n";
    const renewalQuote = "This Agreement renews automatically for successive one-year terms.";
    const text = contractOf(400, { 300: clause });
    const segments = contractAnalysisSegments(text);
    const cited = segments.find((part) => part.text.includes(clause))!;
    const citedNumber = Number(cited.label.slice("section-".length));
    type Renewal = { autoRenew?: boolean | null; renewalPeriod?: string | null; renewalQuote?: string };

    // Section `citedNumber` states automatic one-year renewal with its quotation; `others` sets the
    // sections before it and `later` the sections after it.
    async function analyse(
      merge: "fails" | Record<string, unknown>,
      others: Renewal = {},
      later: Renewal = {},
    ) {
      const double = provider(segments, (call) => {
        if (call.section === "merge")
          return merge === "fails" ? failure() : completed(mergeOutput(merge));
        return completed(
          sectionOutput(
            double.segment(call),
            call.section === citedNumber
              ? { autoRenew: true, renewalPeriod: "1 year", renewalQuote }
              : call.section < citedNumber
                ? others
                : later,
          ),
        );
      });
      const { analyzeText } = await import("./analysis");
      const answer = await analyzeText(text);
      expect(double.mergeCalls()).toHaveLength(1);
      return {
        answer,
        stored: finalizeAnalysisResult(answer.result, { id: CONTRACT_ID, text }),
      };
    }

    const mergedRenewal = (renewal: Record<string, unknown>) => ({
      summary: { ...mergeOutput().summary, renewal },
    });

    it("takes renewal's values and quotation from the same section when the merge call fails", async () => {
      expect(citedNumber).toBeGreaterThan(1);
      const { answer, stored } = await analyse(
        "fails",
        // A section stating no renewal never lends its quotation.
        { autoRenew: null, renewalPeriod: "Not specified", renewalQuote: "Records. Each party" },
        // A later section's different period never sits beside the cited section's values.
        { autoRenew: null, renewalPeriod: "5 years" },
      );
      expect(answer.result.summary.renewal).toEqual({
        auto_renew: true,
        renewal_period: "1 year",
        renewal_evidence: { quote: renewalQuote, segment: cited.label },
      });
      const start = text.indexOf(renewalQuote);
      expect(stored.summary.renewal.renewal_citation).toMatchObject({
        status: "verified",
        quote: renewalQuote,
        start: Array.from(text.slice(0, start)).length,
      });
    });

    it("leaves renewal unknown, with no quotation, when no section states it and the merge call fails", async () => {
      const double = provider(segments, (call) =>
        call.section === "merge"
          ? failure()
          : completed(sectionOutput(double.segment(call), { renewalQuote })),
      );
      const { analyzeText } = await import("./analysis");
      const answer = await analyzeText(text);
      expect(answer.result.summary.renewal).toEqual({
        auto_renew: null,
        renewal_period: null,
        renewal_evidence: null,
      });
    });

    it("takes the first stating section's values even when it cannot quote them, and quotes them from a section stating the same", async () => {
      // An earlier section states the same renewal but claims a quotation it does not contain.
      const { answer } = await analyse("fails", {
        autoRenew: true,
        renewalPeriod: "1 Year",
        renewalQuote,
      });
      expect(answer.result.summary.renewal).toEqual({
        auto_renew: true,
        renewal_period: "1 Year",
        renewal_evidence: { quote: renewalQuote, segment: cited.label },
      });
    });

    it("has no quotation when the first stating section states different renewal values", async () => {
      const { answer, stored } = await analyse("fails", {
        autoRenew: false,
        renewalPeriod: null,
      });
      expect(answer.result.summary.renewal).toEqual({
        auto_renew: false,
        renewal_period: null,
        renewal_evidence: null,
      });
      expect(stored.summary.renewal.renewal_citation).toBeNull();
    });

    it("keeps a section's quotation when the merged values equal it, never the merge model's", async () => {
      const { answer, stored } = await analyse(
        mergedRenewal({
          auto_renew: true,
          renewal_period: "1 year",
          renewal_evidence: { quote: "Records. Each party", segment: "section-1" },
          renewal_citation: { status: "verified", quote: "Records", start: 0, end: 7 },
        }),
      );
      expect(answer.result.summary.renewal.renewal_evidence).toEqual({
        quote: renewalQuote,
        segment: cited.label,
      });
      expect(stored.summary.renewal.renewal_citation?.quote).toBe(renewalQuote);
    });

    it("drops the quotation when another section states different renewal values", async () => {
      for (const disagreeing of [
        { autoRenew: false },
        { autoRenew: true, renewalPeriod: "2 years" },
        { autoRenew: null, renewalPeriod: "monthly" },
      ]) {
        const { answer, stored } = await analyse(
          mergedRenewal({ auto_renew: true, renewal_period: "1 year" }),
          {},
          disagreeing,
        );
        expect(answer.result.summary.renewal).toMatchObject({
          auto_renew: true,
          renewal_period: "1 year",
          renewal_evidence: null,
        });
        expect(stored.summary.renewal.renewal_citation).toBeNull();
      }
    });

    it("has no quotation for merged values that differ from every cited section", async () => {
      for (const renewal of [
        { auto_renew: true, renewal_period: "2 years" },
        { auto_renew: false, renewal_period: "1 year" },
        { auto_renew: null, renewal_period: null },
      ]) {
        const { answer, stored } = await analyse(mergedRenewal(renewal));
        expect(answer.result.summary.renewal).toEqual({
          ...renewal,
          renewal_evidence: null,
        });
        expect(stored.summary.renewal.renewal_citation).toBeNull();
        expect(stored.summary.renewal.auto_renew).toBe(renewal.auto_renew);
      }
    });
  });

  describe("payment quotations", () => {
    const clause =
      "300.1 Fees. The Customer pays 500 EUR each month for the Services.\n";
    const paymentQuote = "The Customer pays 500 EUR each month for the Services.";
    const text = contractOf(400, { 300: clause });
    const segments = contractAnalysisSegments(text);
    const cited = segments.find((part) => part.text.includes(clause))!;
    const citedNumber = Number(cited.label.slice("section-".length));
    type Payment = { amount?: string | null; frequency?: string | null; paymentQuote?: string };

    // Section `citedNumber` states 500 EUR monthly with its quotation; `others` sets the sections
    // before it and `later` the sections after it.
    async function analyse(
      merge: "fails" | Record<string, unknown>,
      others: Payment = {},
      later: Payment = {},
      citedPayment: Payment = { amount: "500 EUR", frequency: "Monthly", paymentQuote },
    ) {
      const double = provider(segments, (call) => {
        if (call.section === "merge")
          return merge === "fails" ? failure() : completed(mergeOutput(merge));
        return completed(
          sectionOutput(
            double.segment(call),
            call.section === citedNumber
              ? citedPayment
              : call.section < citedNumber
                ? others
                : later,
          ),
        );
      });
      const { analyzeText } = await import("./analysis");
      const answer = await analyzeText(text);
      expect(double.mergeCalls()).toHaveLength(1);
      return {
        answer,
        stored: finalizeAnalysisResult(answer.result, { id: CONTRACT_ID, text }),
      };
    }

    const mergedPayments = (payments: Record<string, unknown>) => ({
      summary: { ...mergeOutput().summary, payments: { fees: [], ...payments } },
    });

    it("quotes the merged amount and frequency from the section stating both when the merge call fails", async () => {
      expect(citedNumber).toBeGreaterThan(1);
      const { answer, stored } = await analyse(
        "fails",
        // A section stating no payment never lends its quotation.
        { amount: "Not specified", frequency: null, paymentQuote: "Records. Each party" },
        // A later section's different figure never sits beside the cited section's quotation.
        { amount: "900 EUR", frequency: "Yearly" },
      );
      expect(answer.result.summary.payments).toEqual({
        amount: "500 EUR",
        frequency: "Monthly",
        fees: [],
        fee_evidence: [],
        payment_evidence: { quote: paymentQuote, segment: cited.label },
      });
      const start = text.indexOf(paymentQuote);
      expect(stored.summary.payments.payment_citation).toMatchObject({
        status: "verified",
        quote: paymentQuote,
        start: Array.from(text.slice(0, start)).length,
      });
    });

    it("leaves payment unknown, with no quotation, when no section states it and the merge call fails", async () => {
      const double = provider(segments, (call) =>
        call.section === "merge"
          ? failure()
          : completed(sectionOutput(double.segment(call), { paymentQuote })),
      );
      const { analyzeText } = await import("./analysis");
      const answer = await analyzeText(text);
      expect(answer.result.summary.payments).toEqual({
        amount: null,
        frequency: null,
        fees: [],
        fee_evidence: [],
        payment_evidence: null,
      });
    });

    it("quotes the merged pair from a later section stating the same pair when the first cannot quote it", async () => {
      // An earlier section states the same pair but claims a quotation it does not contain.
      const { answer } = await analyse("fails", {
        amount: "500 eur",
        frequency: "monthly",
        paymentQuote,
      });
      expect(answer.result.summary.payments).toEqual({
        amount: "500 eur",
        frequency: "monthly",
        fees: [],
        fee_evidence: [],
        payment_evidence: { quote: paymentQuote, segment: cited.label },
      });
    });

    it("has no quotation when the first stating section states a different amount", async () => {
      const { answer, stored } = await analyse("fails", {
        amount: "900 EUR",
        frequency: "Monthly",
      });
      expect(answer.result.summary.payments).toMatchObject({
        amount: "900 EUR",
        frequency: "Monthly",
        payment_evidence: null,
      });
      expect(stored.summary.payments.payment_citation).toBeNull();
    });

    it("has no quotation when the merged amount and frequency come from different sections", async () => {
      // The cited section states only the amount; a later one states only the frequency.
      const { answer, stored } = await analyse(
        "fails",
        {},
        { frequency: "Monthly" },
        { amount: "500 EUR", frequency: null, paymentQuote },
      );
      expect(answer.result.summary.payments).toEqual({
        amount: "500 EUR",
        frequency: "Monthly",
        fees: [],
        fee_evidence: [],
        payment_evidence: null,
      });
      expect(stored.summary.payments.payment_citation).toBeNull();
      expect(stored.summary.payments).toMatchObject({
        amount: "500 EUR",
        frequency: "Monthly",
      });
    });

    it("keeps a section's quotation when the merged pair equals it, never the merge model's", async () => {
      const { answer, stored } = await analyse(
        mergedPayments({
          amount: "500 EUR",
          frequency: "Monthly",
          payment_evidence: { quote: "Records. Each party", segment: "section-1" },
          payment_citation: { status: "verified", quote: "Records", start: 0, end: 7 },
        }),
      );
      expect(answer.result.summary.payments.payment_evidence).toEqual({
        quote: paymentQuote,
        segment: cited.label,
      });
      expect(stored.summary.payments.payment_citation?.quote).toBe(paymentQuote);
    });

    it("drops the quotation when another section states a different payment", async () => {
      for (const disagreeing of [
        { amount: "900 EUR", frequency: "Monthly" },
        { amount: "500 EUR", frequency: "Yearly" },
        { amount: null, frequency: "Quarterly" },
        // Stating only part of the pair is a different pair too.
        { amount: "500 EUR", frequency: null },
      ]) {
        const { answer, stored } = await analyse(
          mergedPayments({ amount: "500 EUR", frequency: "Monthly" }),
          {},
          disagreeing,
        );
        expect(answer.result.summary.payments).toMatchObject({
          amount: "500 EUR",
          frequency: "Monthly",
          payment_evidence: null,
        });
        expect(stored.summary.payments.payment_citation).toBeNull();
      }
    });

    it("has no quotation for a merged pair that differs from every cited section", async () => {
      for (const payments of [
        { amount: "900 EUR", frequency: "Monthly" },
        { amount: "500 EUR", frequency: null },
        { amount: null, frequency: null },
      ]) {
        const { answer, stored } = await analyse(mergedPayments(payments));
        expect(answer.result.summary.payments).toEqual({
          ...payments,
          fees: [],
          fee_evidence: [],
          payment_evidence: null,
        });
        expect(stored.summary.payments.payment_citation).toBeNull();
        expect(stored.summary.payments).toMatchObject(payments);
      }
    });
  });

  describe("penalty quotations", () => {
    const earlyExit = "Early termination fee equal to two months' fees";
    const earlyExitQuote = "Ending this agreement early costs two months' fees.";
    const equipment = "Unreturned equipment charged at cost";
    const equipmentQuote = "Equipment not returned within 30 days is charged at cost.";
    const text = contractOf(400, {
      200: `200.1 Early exit. ${earlyExitQuote}\n`,
      380: `380.1 Equipment. ${equipmentQuote}\n`,
    });
    const segments = contractAnalysisSegments(text);
    const sectionOf = (quote: string) =>
      Number(
        segments
          .find((part) => part.text.includes(quote))!
          .label.slice("section-".length),
      );
    const earlyExitSection = sectionOf(earlyExitQuote);
    const equipmentSection = sectionOf(equipmentQuote);
    type Penalties = { penalties?: string[]; penaltyQuotes?: Record<string, string> };
    const quoting: Record<number, Penalties> = {
      [earlyExitSection]: {
        penalties: [earlyExit],
        penaltyQuotes: { [earlyExit]: earlyExitQuote },
      },
      [equipmentSection]: {
        penalties: [equipment],
        penaltyQuotes: { [equipment]: equipmentQuote },
      },
    };

    // Each section's penalties come from `bySection`, falling back to the two quoting sections.
    async function analyse(
      merge: "fails" | Record<string, unknown>,
      bySection: Record<number, Penalties> = {},
    ) {
      const double = provider(segments, (call) => {
        if (call.section === "merge")
          return merge === "fails" ? failure() : completed(mergeOutput(merge));
        return completed(
          sectionOutput(
            double.segment(call),
            bySection[call.section] ?? quoting[call.section] ?? {},
          ),
        );
      });
      const { analyzeText } = await import("./analysis");
      const answer = await analyzeText(text);
      expect(double.mergeCalls()).toHaveLength(1);
      return {
        answer,
        stored: finalizeAnalysisResult(answer.result, { id: CONTRACT_ID, text }),
      };
    }

    const mergedPenalties = (cancellation: Record<string, unknown>) => ({
      summary: {
        ...mergeOutput().summary,
        cancellation: { ...mergeOutput().summary.cancellation, ...cancellation },
      },
    });
    const citedQuotes = (stored: { summary: { cancellation: unknown } }) =>
      (
        (stored.summary.cancellation as Record<string, unknown>)
          .penalty_citations as { penalty: string; citation: { quote: string } }[]
      ).map(({ penalty, citation }) => [penalty, citation.quote]);

    it("quotes each penalty from the section listing it when the merge call fails", async () => {
      expect([earlyExitSection, equipmentSection]).toEqual([
        expect.any(Number),
        expect.any(Number),
      ]);
      expect(earlyExitSection).toBeGreaterThan(1);
      expect(equipmentSection).toBeGreaterThan(earlyExitSection);
      const { answer, stored } = await analyse("fails");
      expect(answer.result.summary.cancellation.penalties).toEqual([
        earlyExit,
        equipment,
      ]);
      expect(answer.result.summary.cancellation.penalty_evidence).toEqual([
        { penalty: earlyExit, quote: earlyExitQuote, segment: `section-${earlyExitSection}` },
        { penalty: equipment, quote: equipmentQuote, segment: `section-${equipmentSection}` },
      ]);
      expect(citedQuotes(stored)).toEqual([
        [earlyExit, earlyExitQuote],
        [equipment, equipmentQuote],
      ]);
      const start = text.indexOf(equipmentQuote);
      expect(citationForReport(stored, CONTRACT_ID, "penalty-1")).toMatchObject({
        status: "verified",
        quote: equipmentQuote,
        start: Array.from(text.slice(0, start)).length,
      });
      expect(citationForReport(stored, CONTRACT_ID, "penalty-0")?.quote).toBe(
        earlyExitQuote,
      );
    });

    it("skips a section whose quotation is not in its own segment and uses a later one listing the same text", async () => {
      const { answer } = await analyse("fails", {
        1: { penalties: [earlyExit], penaltyQuotes: { [earlyExit]: earlyExitQuote } },
      });
      expect(answer.result.summary.cancellation.penalty_evidence).toContainEqual({
        penalty: earlyExit,
        quote: earlyExitQuote,
        segment: `section-${earlyExitSection}`,
      });
    });

    it("never borrows a quotation from a section that does not list that penalty", async () => {
      // Section 1 lists the equipment charge without a quotation; the section that quotes it does
      // not list it.
      const { answer, stored } = await analyse("fails", {
        1: { penalties: [equipment] },
        [equipmentSection]: { penaltyQuotes: { [equipment]: equipmentQuote } },
      });
      expect(answer.result.summary.cancellation.penalties).toEqual([
        equipment,
        earlyExit,
      ]);
      expect(citedQuotes(stored)).toEqual([[earlyExit, earlyExitQuote]]);
    });

    it("has no quotation for a penalty an earlier section worded differently", async () => {
      // De-duplication keeps the first section's wording, which no quoting section lists exactly.
      const reworded = earlyExit.toLowerCase();
      const { answer, stored } = await analyse("fails", {
        1: { penalties: [reworded] },
      });
      expect(answer.result.summary.cancellation.penalties).toEqual([
        reworded,
        equipment,
      ]);
      expect(citedQuotes(stored)).toEqual([[equipment, equipmentQuote]]);
      expect(citationForReport(stored, CONTRACT_ID, "penalty-0")).toBeNull();
    });

    it("keeps the sections' quotations for the merge model's penalties, never its own", async () => {
      const { answer, stored } = await analyse(
        mergedPenalties({
          penalties: [equipment, earlyExit],
          penalty_evidence: [
            { penalty: equipment, quote: "Records. Each party", segment: "section-1" },
          ],
          penalty_citations: [
            { penalty: equipment, citation: { status: "verified", quote: "Records", start: 0, end: 7 } },
          ],
        }),
      );
      expect(answer.result.summary.cancellation.penalty_evidence).toEqual([
        { penalty: equipment, quote: equipmentQuote, segment: `section-${equipmentSection}` },
        { penalty: earlyExit, quote: earlyExitQuote, segment: `section-${earlyExitSection}` },
      ]);
      expect(citedQuotes(stored)).toEqual([
        [equipment, equipmentQuote],
        [earlyExit, earlyExitQuote],
      ]);
    });

    it("has no quotation for a penalty the merge model reworded", async () => {
      const reworded = "Early exit costs two months of fees";
      const { answer, stored } = await analyse(
        mergedPenalties({ penalties: [reworded, equipment] }),
      );
      expect(answer.result.summary.cancellation.penalties).toEqual([
        reworded,
        equipment,
      ]);
      expect(citedQuotes(stored)).toEqual([[equipment, equipmentQuote]]);
      expect(citationForReport(stored, CONTRACT_ID, "penalty-0")).toBeNull();
      expect(citationForReport(stored, CONTRACT_ID, "penalty-1")?.quote).toBe(
        equipmentQuote,
      );
    });

    it("stores no penalty quotations when no penalties are merged", async () => {
      const { answer, stored } = await analyse(mergedPenalties({ penalties: [] }));
      expect(answer.result.summary.cancellation.penalty_evidence).toEqual([]);
      expect(stored.summary.cancellation.penalty_citations).toEqual([]);
    });
  });

  describe("fee quotations", () => {
    const late = "Late payment fee of 50 GBP";
    const lateQuote = "Invoices paid more than 14 days late incur a fee of 50 GBP.";
    const setup = "One-off set-up fee of 300 GBP";
    const setupQuote = "The Customer pays a one-off set-up fee of 300 GBP.";
    const paymentQuote = "The Customer pays 500 EUR each month for the Services.";
    const text = contractOf(400, {
      200: `200.1 Late payment. ${lateQuote}\n200.2 Price. ${paymentQuote}\n`,
      380: `380.1 Set-up. ${setupQuote}\n`,
    });
    const segments = contractAnalysisSegments(text);
    const sectionOf = (quote: string) =>
      Number(
        segments
          .find((part) => part.text.includes(quote))!
          .label.slice("section-".length),
      );
    const lateSection = sectionOf(lateQuote);
    const setupSection = sectionOf(setupQuote);
    type Fees = {
      fees?: string[];
      feeQuotes?: Record<string, string>;
      amount?: string | null;
      frequency?: string | null;
      paymentQuote?: string;
    };
    const quoting: Record<number, Fees> = {
      [lateSection]: {
        fees: [late],
        feeQuotes: { [late]: lateQuote },
        amount: "500 EUR",
        frequency: "Monthly",
        paymentQuote,
      },
      [setupSection]: { fees: [setup], feeQuotes: { [setup]: setupQuote } },
    };

    // Each section's fees come from `bySection`, falling back to the two quoting sections.
    async function analyse(
      merge: "fails" | Record<string, unknown>,
      bySection: Record<number, Fees> = {},
    ) {
      const double = provider(segments, (call) => {
        if (call.section === "merge")
          return merge === "fails" ? failure() : completed(mergeOutput(merge));
        return completed(
          sectionOutput(
            double.segment(call),
            bySection[call.section] ?? quoting[call.section] ?? {},
          ),
        );
      });
      const { analyzeText } = await import("./analysis");
      const answer = await analyzeText(text);
      expect(double.mergeCalls()).toHaveLength(1);
      return {
        answer,
        stored: finalizeAnalysisResult(answer.result, { id: CONTRACT_ID, text }),
      };
    }

    const mergedFees = (payments: Record<string, unknown>) => ({
      summary: {
        ...mergeOutput().summary,
        payments: { ...mergeOutput().summary.payments, ...payments },
      },
    });
    const citedQuotes = (stored: { summary: { payments: unknown } }) =>
      (
        (stored.summary.payments as Record<string, unknown>)
          .fee_citations as { fee: string; citation: { quote: string } }[]
      ).map(({ fee, citation }) => [fee, citation.quote]);

    it("quotes each fee from the section listing it, beside the payment's own quotation, when the merge call fails", async () => {
      expect(lateSection).toBeGreaterThan(1);
      expect(setupSection).toBeGreaterThan(lateSection);
      const { answer, stored } = await analyse("fails");
      expect(answer.result.summary.payments.fees).toEqual([late, setup]);
      expect(answer.result.summary.payments.fee_evidence).toEqual([
        { fee: late, quote: lateQuote, segment: `section-${lateSection}` },
        { fee: setup, quote: setupQuote, segment: `section-${setupSection}` },
      ]);
      expect(citedQuotes(stored)).toEqual([
        [late, lateQuote],
        [setup, setupQuote],
      ]);
      const start = text.indexOf(setupQuote);
      expect(citationForReport(stored, CONTRACT_ID, "fee-1")).toMatchObject({
        status: "verified",
        quote: setupQuote,
        start: Array.from(text.slice(0, start)).length,
      });
      expect(citationForReport(stored, CONTRACT_ID, "fee-0")?.quote).toBe(lateQuote);
      expect(citationForReport(stored, CONTRACT_ID, PAYMENT_CITATION)?.quote).toBe(
        paymentQuote,
      );
    });

    it("skips a section whose quotation is not in its own segment and uses a later one listing the same text", async () => {
      const { answer } = await analyse("fails", {
        1: { fees: [late], feeQuotes: { [late]: lateQuote } },
      });
      expect(answer.result.summary.payments.fee_evidence).toContainEqual({
        fee: late,
        quote: lateQuote,
        segment: `section-${lateSection}`,
      });
    });

    it("never borrows a quotation from a section that does not list that fee", async () => {
      const { answer, stored } = await analyse("fails", {
        1: { fees: [setup] },
        [setupSection]: { feeQuotes: { [setup]: setupQuote } },
      });
      expect(answer.result.summary.payments.fees).toEqual([setup, late]);
      expect(citedQuotes(stored)).toEqual([[late, lateQuote]]);
    });

    it("has no quotation for a fee an earlier section worded differently", async () => {
      const reworded = late.toLowerCase();
      const { answer, stored } = await analyse("fails", { 1: { fees: [reworded] } });
      expect(answer.result.summary.payments.fees).toEqual([reworded, setup]);
      expect(citedQuotes(stored)).toEqual([[setup, setupQuote]]);
      expect(citationForReport(stored, CONTRACT_ID, "fee-0")).toBeNull();
    });

    it("keeps the sections' quotations for the merge model's fees, never its own", async () => {
      const { answer, stored } = await analyse(
        mergedFees({
          fees: [setup, late],
          fee_evidence: [{ fee: setup, quote: "Records. Each party", segment: "section-1" }],
          fee_citations: [
            { fee: setup, citation: { status: "verified", quote: "Records", start: 0, end: 7 } },
          ],
        }),
      );
      expect(answer.result.summary.payments.fee_evidence).toEqual([
        { fee: setup, quote: setupQuote, segment: `section-${setupSection}` },
        { fee: late, quote: lateQuote, segment: `section-${lateSection}` },
      ]);
      expect(citedQuotes(stored)).toEqual([
        [setup, setupQuote],
        [late, lateQuote],
      ]);
    });

    it("has no quotation for a fee the merge model reworded", async () => {
      const reworded = "A 50 GBP fee for late payment";
      const { answer, stored } = await analyse(mergedFees({ fees: [reworded, setup] }));
      expect(answer.result.summary.payments.fees).toEqual([reworded, setup]);
      expect(citedQuotes(stored)).toEqual([[setup, setupQuote]]);
      expect(citationForReport(stored, CONTRACT_ID, "fee-0")).toBeNull();
      expect(citationForReport(stored, CONTRACT_ID, "fee-1")?.quote).toBe(setupQuote);
    });

    it("stores no fee quotations when no fees are merged", async () => {
      const { answer, stored } = await analyse(mergedFees({ fees: [] }));
      expect(answer.result.summary.payments.fee_evidence).toEqual([]);
      expect(stored.summary.payments.fee_citations).toEqual([]);
    });
  });

  it("uses a single surviving section as the result without a merge call", async () => {
    const text = contractOf(175);
    const segments = contractAnalysisSegments(text);
    const double = provider(segments, (call) =>
      call.section === 1
        ? completed(sectionOutput(double.segment(call), { badge: "MEDIUM" }))
        : failure(),
    );
    const { analyzeText } = await import("./analysis");

    const answer = await analyzeText(text);
    expect(double.mergeCalls()).toHaveLength(0);
    expect(answer.result.risk_badge).toBe("MEDIUM");
    expect(answer.result.coverage_notices).toHaveLength(1);
    expect(answer.result.coverage_notices![0]).toMatch(
      /^Contract section 2 of 2 \(Unicode code points/,
    );
  });

  it("fails like a one-call analysis when no section succeeds", async () => {
    const text = contractOf(175);
    const segments = contractAnalysisSegments(text);
    const double = provider(segments, () => failure());
    const { analyzeText } = await import("./analysis");

    await expect(analyzeText(text)).rejects.toThrow(
      /OpenRouter fallback is not configured/,
    );
    expect(double.mergeCalls()).toHaveLength(0);
  });

  it("fails rather than returning a partial result when the caller aborts", async () => {
    const text = contractOf(320);
    const segments = contractAnalysisSegments(text);
    const controller = new AbortController();
    const double = provider(segments, (call) => {
      if (call.section === 1) {
        controller.abort(new DOMException("Request cancelled", "AbortError"));
      }
      return hang(call);
    });
    const { analyzeText } = await import("./analysis");

    await expect(
      analyzeText(text, undefined, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(double.mergeCalls()).toHaveLength(0);
  });
});
