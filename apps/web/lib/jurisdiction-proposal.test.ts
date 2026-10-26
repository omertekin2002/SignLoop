import { describe, expect, it, vi } from "vitest";
import { buildAnalysisPrompt, parseStrictJson } from "./analysis";
import { contractSourceRevision, finalizeAnalysisResult } from "./analysis-sources";
import { parseJurisdictionUpdate } from "./regional-comparisons";
import {
  AnalysisResultSchema,
  PartialAnalysisResultSchema,
  type AnalysisResult,
} from "./schemas";
import { citationForReport, JURISDICTION_CITATION } from "./source-citations";

const id = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const clause = "This Agreement is governed by the laws of the State of Oregon.";
const contract = { id, text: `Fees are due monthly.\n\n${clause}` };
const proposal = (quote: string, extra: Record<string, unknown> = {}) => ({
  jurisdiction: "State of Oregon",
  evidence: { quote, segment: "full" },
  ...extra,
});

const strict = {
  risk_badge: "LOW",
  key_points: ["Fees are due monthly."],
  summary: {
    what_it_is: "A services agreement",
    payments: { amount: null, frequency: "Monthly", fees: [] },
    term: { start: null, end: null, minimum_term: null },
    renewal: { auto_renew: null, renewal_period: null },
    cancellation: { how: "Not specified", notice_period_days: null, penalties: [] },
  },
  red_flags: [],
  normal_in_region: [],
  next_actions: { questions_to_ask: [], email_templates: [] },
  key_dates: [],
  obligations: [],
  parties: [],
  disclaimer: "This is an AI analysis, not legal advice.",
};
const partial = {
  risk_badge: "LOW",
  key_points: ["Fees are due monthly."],
  summary: {
    renewal: { auto_renew: null },
    cancellation: { how: "Not specified", notice_period_days: null },
  },
};
const answers = {
  strict,
  partial,
  normalized: { ...partial, risk_badge: "low" },
};

function parse(payload: Record<string, unknown>) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    return parseStrictJson<AnalysisResult>(JSON.stringify(payload));
  } finally {
    warn.mockRestore();
  }
}

describe("proposed_jurisdiction in analysis output", () => {
  it.each(Object.keys(answers) as Array<keyof typeof answers>)(
    "survives %s parsing with its evidence, and stays optional",
    (path) => {
      const withProposal = parse({
        ...answers[path],
        proposed_jurisdiction: proposal(clause),
      });
      expect(withProposal.proposed_jurisdiction).toMatchObject({
        jurisdiction: "State of Oregon",
        evidence: { quote: clause, segment: "full" },
      });
      expect(parse(answers[path]).proposed_jurisdiction ?? null).toBeNull();
      expect(
        parse({ ...answers[path], proposed_jurisdiction: null })
          .proposed_jurisdiction ?? null,
      ).toBeNull();
    },
  );

  it("drops a malformed proposal instead of rejecting the analysis", () => {
    for (const malformed of ["Oregon", { jurisdiction: "" }, { evidence: {} }, 7]) {
      const parsed = parse({ ...strict, proposed_jurisdiction: malformed });
      expect(parsed.proposed_jurisdiction ?? null).toBeNull();
    }
  });

  it("keeps reports stored before the field valid", () => {
    expect(AnalysisResultSchema.safeParse(strict).success).toBe(true);
    expect(PartialAnalysisResultSchema.safeParse(partial).success).toBe(true);
  });

  it("asks for the governing-law clause without legal conclusions, confirmed or not", () => {
    for (const metadata of [undefined, { region: "Ontario" }]) {
      const { prompt } = buildAnalysisPrompt("Contract body", metadata);
      expect(prompt).toContain('"proposed_jurisdiction" is the jurisdiction named');
      expect(prompt).toContain(
        'Use null for "proposed_jurisdiction" when no supplied CONTRACT segment contains a governing-law clause.',
      );
      expect(prompt).toContain(
        "Never state what that law provides or whether the contract complies with it.",
      );
      expect(prompt).toContain('"proposed_jurisdiction": { "jurisdiction":');
    }
  });
});

describe("finalizing a jurisdiction proposal", () => {
  it("keeps a proposal whose governing-law quotation verifies, with a server citation", () => {
    const stored = finalizeAnalysisResult(
      {
        ...strict,
        proposed_jurisdiction: proposal(clause, {
          citation: { status: "verified", start: 0, end: 3, quote: "Fee" },
        }),
      },
      contract,
    );
    const start = Array.from(contract.text).indexOf("T");
    expect(stored.proposed_jurisdiction).toEqual({
      jurisdiction: "State of Oregon",
      citation: {
        contract_id: id,
        revision: contractSourceRevision(contract.text),
        index_unit: "unicode-code-points",
        status: "verified",
        quote: clause,
        start,
        end: start + clause.length,
      },
    });
    expect(citationForReport(stored, id, JURISDICTION_CITATION)).toEqual(
      stored.proposed_jurisdiction!.citation,
    );
    // Red-flag citations are looked up separately.
    expect(citationForReport(stored, id, 0)).toBeNull();
  });

  it.each([
    ["a hallucinated quotation", proposal("This Agreement is governed by the laws of California.")],
    ["a paraphrased quotation", proposal("governed by Oregon law")],
    ["a quotation from the wrong segment", proposal(clause, { evidence: { quote: clause, segment: "tail" } })],
    ["no evidence", { jurisdiction: "State of Oregon" }],
    ["a placeholder jurisdiction", proposal(clause, { jurisdiction: "Unknown" })],
    ["no proposal", null],
    ["an omitted field", undefined],
  ])("stores null for %s", (_label, proposed) => {
    const stored = finalizeAnalysisResult(
      { ...strict, proposed_jurisdiction: proposed },
      contract,
    );
    expect(stored.proposed_jurisdiction).toBeNull();
    expect(citationForReport(stored, id, JURISDICTION_CITATION)).toBeNull();
  });

  it("bounds a long proposal by code points, never splitting a character", () => {
    const long = `${"x".repeat(99)}😀 and beyond`;
    const stored = finalizeAnalysisResult(
      { ...strict, proposed_jurisdiction: { ...proposal(clause), jurisdiction: long } },
      contract,
    );
    expect(stored.proposed_jurisdiction?.jurisdiction).toBe(`${"x".repeat(99)}😀`);
    expect(parseJurisdictionUpdate({ jurisdiction: "😀".repeat(100) })).toEqual({
      jurisdiction: "😀".repeat(100),
    });
    expect(parseJurisdictionUpdate({ jurisdiction: "😀".repeat(101) })).toBeNull();
  });

  it("records the confirmed region the analysis ran with", () => {
    expect(
      finalizeAnalysisResult(strict, { ...contract, region: "  Ontario " })
        .comparison_jurisdiction,
    ).toBe("Ontario");
    expect(
      finalizeAnalysisResult(
        { ...strict, comparison_jurisdiction: "Forged" },
        { ...contract, region: null },
      ).comparison_jurisdiction,
    ).toBeNull();
  });
});

describe("parseJurisdictionUpdate", () => {
  it("accepts a jurisdiction, normalized, or null to clear it", () => {
    expect(parseJurisdictionUpdate({ jurisdiction: "State of Oregon" })).toEqual(
      { jurisdiction: "State of Oregon" },
    );
    expect(
      parseJurisdictionUpdate({ jurisdiction: "  England\n and   Wales " }),
    ).toEqual({ jurisdiction: "England and Wales" });
    expect(parseJurisdictionUpdate({ jurisdiction: null })).toEqual({
      jurisdiction: null,
    });
    expect(parseJurisdictionUpdate({ jurisdiction: "x".repeat(100) })).toEqual({
      jurisdiction: "x".repeat(100),
    });
  });

  it.each([
    null,
    "Ontario",
    [],
    {},
    { jurisdiction: "Ontario", extra: true },
    { jurisdiction: 1 },
    { jurisdiction: "" },
    { jurisdiction: "N/A" },
    { jurisdiction: "x".repeat(101) },
  ])("rejects %j", (body) => {
    expect(parseJurisdictionUpdate(body)).toBeNull();
  });
});
