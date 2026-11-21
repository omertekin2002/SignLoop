import { describe, expect, it, vi } from "vitest";
import {
  buildAnalysisPrompt,
  buildMergePrompt,
  parseStrictJson,
} from "./analysis";
import {
  contractSourceRevision,
  finalizeAnalysisResult,
} from "./analysis-sources";
import { isTermStated } from "./term";
import {
  AnalysisResultSchema,
  PartialAnalysisResultSchema,
  type AnalysisResult,
} from "./schemas";
import {
  citationForReport,
  contractAnalysisSegments,
  PAYMENT_CITATION,
  TERM_CITATION,
} from "./source-citations";

const id = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const clause =
  "This Agreement starts on 1 March 2027 and continues for a minimum term of 24 months.";
// The emoji makes code point and UTF-16 offsets differ; "Agreement" appears twice.
const contract = {
  id,
  text: `1. Services 😀 are described in this Agreement.\n\n2. Term. ${clause}`,
};
const evidence = (quote: string, segment = "full") => ({ quote, segment });

const term = (extra: Record<string, unknown> = {}) => ({
  start: "1 March 2027",
  end: null,
  minimum_term: "24 months",
  ...extra,
});

const strict = (termed: Record<string, unknown> = term()) => ({
  risk_badge: "LOW",
  key_points: ["The term is two years."],
  summary: {
    what_it_is: "A services agreement",
    payments: { amount: null, frequency: null, fees: [] },
    term: termed,
    renewal: { auto_renew: null, renewal_period: null },
    cancellation: {
      how: "In writing",
      notice_period_days: null,
      notice_period_text: null,
      penalties: [],
    },
  },
  red_flags: [],
  normal_in_region: [],
  next_actions: { questions_to_ask: [], email_templates: [] },
  key_dates: [],
  obligations: [],
  parties: [],
  disclaimer: "This is an AI analysis, not legal advice.",
});

function parse(payload: Record<string, unknown>) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    return parseStrictJson<AnalysisResult>(JSON.stringify(payload));
  } finally {
    warn.mockRestore();
  }
}

function finalize(termed: Record<string, unknown>) {
  return finalizeAnalysisResult(parse(strict(termed)), contract);
}

describe("isTermStated", () => {
  it.each([
    [{ start: "1 March 2027", end: "28 February 2029", minimum_term: "24 months" }, true],
    [{ start: "1 March 2027", end: null, minimum_term: null }, true],
    [{ start: null, end: "28 February 2029", minimum_term: null }, true],
    [{ start: null, end: null, minimum_term: "24 months" }, true],
    [{ start: "Not specified", end: "Unknown", minimum_term: "N/A" }, false],
    [{ start: null, end: null, minimum_term: null }, false],
    [{ start: " ", end: 12, minimum_term: undefined }, false],
    [{}, false],
  ])("%j is stated: %s", (value, stated) => {
    expect(isTermStated(value)).toBe(stated);
  });
});

describe("term_evidence in analysis output", () => {
  it.each([
    ["strict", strict(term({ term_evidence: evidence(clause) }))],
    [
      "partial",
      {
        risk_badge: "LOW",
        key_points: ["The term is two years."],
        summary: {
          term: term({ term_evidence: evidence(clause) }),
          renewal: { auto_renew: null },
          cancellation: { how: "In writing", notice_period_days: null },
        },
      },
    ],
    [
      "normalized",
      {
        ...strict(),
        risk_badge: "low",
        summary: {
          ...strict().summary,
          term: {
            startDate: "1 March 2027",
            minimumTerm: "24 months",
            termEvidence: evidence(clause),
          },
        },
      },
    ],
  ])("survives %s parsing with the term values", (_path, payload) => {
    expect(parse(payload).summary.term).toMatchObject({
      start: "1 March 2027",
      end: null,
      minimum_term: "24 months",
      term_evidence: evidence(clause),
    });
  });

  it("drops malformed evidence or citations instead of rejecting the analysis", () => {
    for (const malformed of [
      "clause",
      { quote: "" },
      { quote: clause, segment: "tail" },
      7,
    ]) {
      const parsed = parse(
        strict(term({ term_evidence: malformed, term_citation: malformed })),
      );
      expect(parsed.summary.term.term_evidence ?? null).toBeNull();
      expect(parsed.summary.term.term_citation ?? null).toBeNull();
      expect(parsed.summary.term).toMatchObject({
        start: "1 March 2027",
        minimum_term: "24 months",
      });
    }
  });

  it("keeps reports stored before the fields valid", () => {
    expect(AnalysisResultSchema.safeParse(strict()).success).toBe(true);
    expect(
      PartialAnalysisResultSchema.safeParse({
        risk_badge: "LOW",
        key_points: ["Two years."],
        summary: {
          term: { minimum_term: "24 months" },
          renewal: { auto_renew: false },
          cancellation: { how: "Not specified", notice_period_days: null },
        },
      }).success,
    ).toBe(true);
  });

  it("asks for the clause stating the term", () => {
    const { prompt } = buildAnalysisPrompt("Contract body");
    expect(prompt).toContain(
      'When the contract states when it starts, when it ends or a minimum term, "summary.term.term_evidence" quotes the exact sentence or clause that states the term',
    );
    expect(prompt).toContain(
      "Use null when none of the start, end or minimum term is stated.",
    );
    expect(prompt).toContain('"term_evidence": { "quote":');
  });
});

describe("finalizing a term quotation", () => {
  it("stores a verified citation for an exact quotation, with offsets and revision", () => {
    const stored = finalize(term({ term_evidence: evidence(clause) }));
    const start = Array.from(contract.text).length - Array.from(clause).length;
    expect(stored.summary.term).toEqual({
      start: "1 March 2027",
      end: null,
      minimum_term: "24 months",
      term_citation: {
        contract_id: id,
        revision: contractSourceRevision(contract.text),
        index_unit: "unicode-code-points",
        status: "verified",
        quote: clause,
        start,
        end: start + Array.from(clause).length,
      },
    });
    expect(Array.from(contract.text).slice(start).join("")).toBe(clause);
    expect(citationForReport(stored, id, TERM_CITATION)).toEqual(
      stored.summary.term.term_citation,
    );
    // Other citations are looked up separately.
    expect(citationForReport(stored, id, PAYMENT_CITATION)).toBeNull();
    expect(citationForReport(stored, id, 0)).toBeNull();
    expect(
      citationForReport(
        stored,
        "22e3e947-f71f-4ecd-a901-adbf24edbb8a",
        TERM_CITATION,
      ),
    ).toBeNull();
  });

  it("cites a term stated only by its start, only by its end, or only by its minimum term", () => {
    for (const stated of [
      { start: "1 March 2027", end: null, minimum_term: null },
      { start: null, end: "28 February 2029", minimum_term: null },
      { start: null, end: null, minimum_term: "24 months" },
    ]) {
      expect(
        finalize(term({ ...stated, term_evidence: evidence(clause) })).summary
          .term.term_citation,
      ).toMatchObject({ status: "verified", quote: clause });
    }
  });

  it.each([
    ["a paraphrase", evidence("The Agreement lasts 24 months from 1 March 2027.")],
    ["a quotation from the wrong segment", evidence(clause, "section-2")],
    ["a duplicated quotation", evidence("Agreement")],
    ["no evidence", null],
  ])("stores null and keeps the term values for %s", (_label, proposed) => {
    const stored = finalize(term({ term_evidence: proposed }));
    expect(stored.summary.term).toEqual({
      start: "1 March 2027",
      end: null,
      minimum_term: "24 months",
      term_citation: null,
    });
    expect(citationForReport(stored, id, TERM_CITATION)).toBeNull();
  });

  it("never stores a model-supplied citation as-is", () => {
    const forged = {
      contract_id: id,
      revision: contractSourceRevision(contract.text),
      index_unit: "unicode-code-points",
      status: "verified",
      quote: "Services",
      start: 3,
      end: 11,
    };
    // The forged citation passes the schema, so parsing keeps it for the server to discard.
    expect(
      parse(strict(term({ term_citation: forged }))).summary.term.term_citation,
    ).toEqual(forged);
    // Without evidence the forged citation is discarded.
    expect(
      finalize(term({ term_citation: forged })).summary.term.term_citation,
    ).toBeNull();
    // With evidence the server's own match replaces it.
    const replaced = finalize(
      term({ term_citation: forged, term_evidence: evidence(clause) }),
    ).summary.term.term_citation;
    expect(replaced).toMatchObject({ quote: clause });
    expect(replaced).not.toMatchObject({ start: 3 });
  });

  it("never cites an unknown term, even when a quotation was sent", () => {
    for (const unknown of [
      { start: null, end: null, minimum_term: null },
      { start: "Not specified", end: "Unknown", minimum_term: "N/A" },
    ]) {
      const stored = finalize(
        term({ ...unknown, term_evidence: evidence(clause) }),
      );
      expect(stored.summary.term.term_citation).toBeNull();
      expect(stored.summary.term).toMatchObject(unknown);
    }
  });

  it("keeps a legacy report readable with no citation", () => {
    const legacy = {
      source: {
        contract_id: id,
        revision: contractSourceRevision(contract.text),
        index_unit: "unicode-code-points",
      },
      ...strict(),
    };
    expect(citationForReport(legacy, id, TERM_CITATION)).toBeNull();
  });
});

describe("the merge prompt", () => {
  it("does not show the merge model the sections' term quotations", () => {
    const text = `${"1. Records. Each party keeps accurate records of its own work under this agreement.\n".repeat(200)}${clause}\n`;
    const segments = contractAnalysisSegments(text);
    expect(segments.length).toBeGreaterThan(1);
    const sections = segments.map((segment) => ({
      segment,
      result: parse(
        strict(term({ term_evidence: evidence(clause, segment.label) })),
      ),
    }));
    const prompt = buildMergePrompt(sections, segments.length);
    expect(prompt).toContain('"minimum_term": "24 months"');
    expect(prompt).not.toContain("term_evidence");
    expect(prompt).not.toContain("continues for a minimum term");
  });
});
