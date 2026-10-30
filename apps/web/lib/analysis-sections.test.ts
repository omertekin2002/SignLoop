import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeAnalysisResult } from "./analysis-sources";
import {
  CONTRACT_ANALYSIS_LIMIT,
  contractAnalysisSegments,
  type ContractSegment,
} from "./source-citations";

const CONTRACT_ID = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";

// Numbered clauses of about 88 code points; the emoji make code point and UTF-16 offsets differ.
const clause = (number: number) =>
  `${number}. Records. Each party keeps accurate records of its own work under this agreement 😀.\n`;
const contractOf = (clauses: number, extra: Record<number, string> = {}) =>
  Array.from(
    { length: clauses },
    (_, index) => extra[index + 1] ?? clause(index + 1),
  ).join("");

type Flag = {
  type: string;
  explanation: string;
  quote?: string;
  severity?: number;
};

function sectionOutput(
  segment: ContractSegment,
  options: {
    flags?: Flag[];
    questions?: string[];
    badge?: "LOW" | "MEDIUM" | "HIGH";
    autoRenew?: boolean | null;
    noticeDays?: number | null;
    noticeText?: string | null;
    jurisdiction?: string;
  } = {},
) {
  return {
    risk_badge: options.badge ?? "LOW",
    key_points: [`Covers ${segment.label}.`],
    summary: {
      what_it_is: "A services agreement.",
      payments: { amount: null, frequency: null, fees: [] },
      term: { start: null, end: null, minimum_term: null },
      renewal: { auto_renew: options.autoRenew ?? null, renewal_period: null },
      cancellation: {
        how: "Not specified",
        notice_period_days: options.noticeDays ?? null,
        notice_period_text: options.noticeText ?? null,
        penalties: [],
      },
    },
    red_flags: (options.flags ?? []).map((flag) => ({
      type: flag.type,
      severity: flag.severity ?? 6,
      explanation: flag.explanation,
      where: null,
      confidence: 80,
      evidence: flag.quote
        ? { quote: flag.quote, segment: segment.label }
        : null,
    })),
    proposed_jurisdiction: options.jurisdiction
      ? {
          jurisdiction: "State of Delaware",
          evidence: { quote: options.jurisdiction, segment: segment.label },
        }
      : null,
    normal_in_region: [],
    next_actions: {
      questions_to_ask: options.questions ?? [],
      email_templates: [],
    },
    key_dates: [],
    obligations: [],
    parties: ["Provider", "Customer"],
    disclaimer: "This is an AI analysis, not legal advice.",
  };
}

function mergeOutput(overrides: Record<string, unknown> = {}) {
  return {
    risk_badge: "HIGH",
    key_points: ["Renews automatically each year."],
    summary: {
      what_it_is: "A services agreement.",
      payments: { amount: null, frequency: null, fees: [] },
      term: { start: null, end: null, minimum_term: null },
      renewal: { auto_renew: true, renewal_period: "1 year" },
      cancellation: {
        how: "Written notice",
        notice_period_days: 60,
        notice_period_text: "60 days",
        penalties: [],
      },
    },
    red_flag_ids: [],
    normal_in_region: [],
    next_actions: { questions_to_ask: [], email_templates: [] },
    key_dates: [],
    obligations: [],
    parties: ["Provider", "Customer"],
    disclaimer: "This is an AI analysis, not legal advice.",
    ...overrides,
  };
}

function completed(output: unknown, usage = { input: 100, output: 10 }) {
  return Response.json({
    id: "resp_test",
    object: "response",
    status: "completed",
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.input + usage.output,
    },
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: JSON.stringify(output),
            annotations: [],
          },
        ],
      },
    ],
  });
}

type Call = { section: number | "merge"; input: string; signal?: AbortSignal };
type Reply = (call: Call) => Response | Promise<Response>;

/** A provider double that answers section and merge calls and records how many ran at once. */
function provider(segments: readonly ContractSegment[], reply: Reply) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const input = String(JSON.parse(String(init?.body)).input);
    const match = input.match(/This request contains section (\d+) of/);
    const call: Call = {
      section: match ? Number(match[1]) : "merge",
      input,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      // Yield so concurrent calls overlap, as real requests would.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await reply(call);
    } finally {
      inFlight -= 1;
    }
  });
  vi.stubGlobal("fetch", fetch);
  return {
    calls,
    maxInFlight: () => maxInFlight,
    sectionCalls: () => calls.filter((call) => call.section !== "merge"),
    mergeCalls: () => calls.filter((call) => call.section === "merge"),
    segment: (call: Call) => segments[(call.section as number) - 1]!,
  };
}

/** Never answers; rejects once the request is aborted, as the SDK's fetch would. */
const hang: Reply = ({ signal }) =>
  new Promise((_resolve, reject) => {
    const abort = () =>
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort);
  });

const failure = () =>
  Response.json(
    { error: { message: "upstream unavailable" } },
    { status: 500 },
  );

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
