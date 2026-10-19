import { describe, expect, it, vi } from "vitest";
import { parseStrictJson } from "./analysis";
import { finalizeAnalysisResult } from "./analysis-sources";
import {
  confirmedRegion,
  regionalComparisonsView,
  withholdUnsupportedComparisons,
} from "./regional-comparisons";
import {
  AnalysisResultSchema,
  PartialAnalysisResultSchema,
  type AnalysisResult,
} from "./schemas";

const contract = {
  id: "11e3e947-f71f-4ecd-a901-adbf24edbb8a",
  text: "The membership renews yearly. Cancel by email.",
};
const named = {
  topic: "Cancellation notice",
  jurisdiction: "Ontario",
  typical_range: "30 days",
  yours: "Email before renewal",
  label: "typical" as const,
};
const { jurisdiction: _omitted, ...unnamed } = { ...named, topic: "Renewal" };

const partialAnswer = {
  risk_badge: "LOW",
  key_points: ["The membership renews yearly."],
  summary: {
    renewal: { auto_renew: true },
    cancellation: { how: "Email notice", notice_period_days: null },
  },
};
const answers = {
  strict: {
    ...partialAnswer,
    summary: {
      what_it_is: "A membership agreement",
      payments: { amount: null, frequency: null, fees: [] },
      term: { start: null, end: null, minimum_term: null },
      renewal: { auto_renew: true, renewal_period: "1 year" },
      cancellation: {
        how: "Email notice",
        notice_period_days: null,
        penalties: [],
      },
    },
    red_flags: [],
    next_actions: { questions_to_ask: [], email_templates: [] },
    key_dates: [],
    obligations: [],
    parties: [],
    disclaimer: "This is an AI analysis, not legal advice.",
  },
  partial: partialAnswer,
  normalized: { ...partialAnswer, risk_badge: "low" },
};
type ParsePath = keyof typeof answers;
const PARSE_PATHS = Object.keys(answers) as ParsePath[];

function parse(path: ParsePath, extra: Record<string, unknown>) {
  const payload = { ...answers[path], ...extra };
  // Pin the path each answer takes, so withholding is shown to follow every one of them.
  expect(AnalysisResultSchema.safeParse(payload).success).toBe(
    path === "strict",
  );
  expect(PartialAnalysisResultSchema.safeParse(payload).success).toBe(
    path !== "normalized",
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    return parseStrictJson<AnalysisResult>(JSON.stringify(payload));
  } finally {
    warn.mockRestore();
  }
}

describe("regional comparisons in stored reports", () => {
  it.each(PARSE_PATHS)(
    "are withheld after %s parsing without a confirmed region, whatever flag the model sends",
    (path) => {
      for (const forged of [false, true, "no"]) {
        const parsed = parse(path, {
          normal_in_region: [named],
          comparisons_withheld: forged,
        });
        // Parsing keeps the proposal, like evidence; only finalization decides what is stored.
        expect(parsed.normal_in_region).toHaveLength(1);
        for (const region of [undefined, null, "", " \n ", "Unknown"]) {
          const stored = finalizeAnalysisResult(parsed, { ...contract, region });
          expect(stored.normal_in_region).toEqual([]);
          expect(stored.comparisons_withheld).toBe(true);
          expect(regionalComparisonsView(stored)).toEqual({
            status: "withheld",
          });
        }
      }
    },
  );

  it.each(PARSE_PATHS)(
    "keep only comparisons naming a jurisdiction once a region is confirmed (%s)",
    (path) => {
      const parsed = parse(path, {
        normal_in_region: [named, unnamed],
        comparisons_withheld: true,
      });
      const stored = finalizeAnalysisResult(parsed, {
        ...contract,
        region: "Ontario",
      });

      expect(stored.comparisons_withheld).toBe(false);
      expect(stored.normal_in_region).toEqual([
        expect.objectContaining({ topic: "Cancellation notice", jurisdiction: "Ontario" }),
      ]);
      expect(regionalComparisonsView(stored)).toMatchObject({
        status: "confirmed",
      });
    },
  );

  it("owns both fields even when the result carries no comparisons", () => {
    expect(withholdUnsupportedComparisons(undefined, undefined)).toEqual({
      normal_in_region: [],
      comparisons_withheld: true,
    });
    expect(withholdUnsupportedComparisons("not a list", "Ontario")).toEqual({
      normal_in_region: [],
      comparisons_withheld: false,
    });
  });
});

describe("confirmedRegion", () => {
  it("normalizes a region as the prompt shows it", () => {
    expect(confirmedRegion("  Ontario,\n  Canada ")).toBe("Ontario, Canada");
    expect(confirmedRegion("x".repeat(150))).toHaveLength(100);
  });

  it.each([undefined, null, "", " \n ", "Unknown", "N/A", "not specified"])(
    "treats %j as unconfirmed",
    (region) => {
      expect(confirmedRegion(region)).toBeNull();
    },
  );
});

describe("regionalComparisonsView", () => {
  it("explains withheld comparisons and never shows any beside the flag", () => {
    expect(
      regionalComparisonsView({ comparisons_withheld: true, normal_in_region: [] }),
    ).toEqual({ status: "withheld" });
    expect(
      regionalComparisonsView({
        comparisons_withheld: true,
        normal_in_region: [unnamed],
      }),
    ).toEqual({ status: "withheld" });
  });

  it("keeps comparisons from reports saved before withholding, marked unconfirmed", () => {
    expect(
      regionalComparisonsView({ normal_in_region: [null, unnamed] as never }),
    ).toEqual({ status: "unconfirmed", items: [unnamed] });
    expect(regionalComparisonsView({ normal_in_region: [] })).toBeNull();
    expect(regionalComparisonsView({})).toBeNull();
  });

  it("marks comparisons confirmed only when the server kept them and each names a jurisdiction", () => {
    expect(
      regionalComparisonsView({
        comparisons_withheld: false,
        normal_in_region: [named],
      }),
    ).toEqual({ status: "confirmed", items: [named] });
    expect(
      regionalComparisonsView({
        comparisons_withheld: false,
        normal_in_region: [named, unnamed],
      }),
    ).toMatchObject({ status: "unconfirmed" });
    expect(regionalComparisonsView({ normal_in_region: [named] })).toMatchObject(
      { status: "unconfirmed" },
    );
  });
});
