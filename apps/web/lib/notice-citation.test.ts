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
import {
  AnalysisResultSchema,
  PartialAnalysisResultSchema,
  type AnalysisResult,
} from "./schemas";
import {
  citationForReport,
  contractAnalysisSegments,
  NOTICE_CITATION,
} from "./source-citations";

const id = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const clause =
  "Either party may terminate this Agreement on ten (10) business days' written notice to the other party, counted from receipt.";
// The emoji makes code point and UTF-16 offsets differ.
const contract = {
  id,
  text: `1. Fees 😀 are due monthly.\n\n9. Termination. ${clause}`,
};
const evidence = (quote: string, segment = "full") => ({ quote, segment });

const cancellation = (extra: Record<string, unknown> = {}) => ({
  how: "Written notice",
  notice_period_days: null,
  notice_period_text: "10 business days",
  ...extra,
});

const strict = (cancelled: Record<string, unknown> = cancellation()) => ({
  risk_badge: "LOW",
  key_points: ["Fees are due monthly."],
  summary: {
    what_it_is: "A services agreement",
    payments: { amount: null, frequency: "Monthly", fees: [] },
    term: { start: null, end: null, minimum_term: null },
    renewal: { auto_renew: null, renewal_period: null },
    cancellation: { penalties: [], ...cancelled },
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

function finalize(cancelled: Record<string, unknown>) {
  return finalizeAnalysisResult(parse(strict(cancelled)), contract);
}

describe("notice_evidence in analysis output", () => {
  it.each([
    ["strict", strict(cancellation({ notice_evidence: evidence(clause) }))],
    [
      "partial",
      {
        risk_badge: "LOW",
        key_points: ["Fees are due monthly."],
        summary: {
          renewal: { auto_renew: null },
          cancellation: cancellation({ notice_evidence: evidence(clause) }),
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
          cancellation: {
            how: "Written notice",
            notice_period: "10 business days",
            noticeEvidence: evidence(clause),
          },
        },
      },
    ],
  ])("survives %s parsing with the duration", (_path, payload) => {
    expect(parse(payload).summary.cancellation).toMatchObject({
      notice_period_days: null,
      notice_period_text: "10 business days",
      notice_evidence: evidence(clause),
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
        strict(
          cancellation({
            notice_evidence: malformed,
            notice_citation: malformed,
          }),
        ),
      );
      expect(parsed.summary.cancellation.notice_evidence ?? null).toBeNull();
      expect(parsed.summary.cancellation.notice_citation ?? null).toBeNull();
      expect(parsed.summary.cancellation.notice_period_text).toBe(
        "10 business days",
      );
    }
  });

  it("keeps reports stored before the fields valid", () => {
    const legacy = strict({ how: "Not specified", notice_period_days: 60 });
    expect(AnalysisResultSchema.safeParse(legacy).success).toBe(true);
    expect(
      PartialAnalysisResultSchema.safeParse({
        risk_badge: "LOW",
        key_points: ["Fees."],
        summary: {
          renewal: { auto_renew: null },
          cancellation: { how: "Not specified", notice_period_days: 60 },
        },
      }).success,
    ).toBe(true);
  });

  it("asks for the clause stating the notice period, with its qualifying language", () => {
    const { prompt } = buildAnalysisPrompt("Contract body");
    expect(prompt).toContain(
      '"summary.cancellation.notice_evidence" quotes the exact sentence or clause stating it',
    );
    expect(prompt).toContain(
      "business or calendar days, the event that starts the clock, and which party gives notice",
    );
    expect(prompt).toContain("Use null when no notice period is stated.");
    expect(prompt).toContain('"notice_evidence": { "quote":');
  });
});

describe("finalizing a notice-period quotation", () => {
  it("stores a verified citation for an exact business-day quotation, with offsets and revision", () => {
    const stored = finalize(
      cancellation({ notice_evidence: evidence(clause) }),
    );
    const start = Array.from(contract.text).length - Array.from(clause).length;
    expect(stored.summary.cancellation).toEqual({
      how: "Written notice",
      notice_period_days: null,
      notice_period_text: "10 business days",
      penalties: [],
      // Server-owned, like notice_citation: no penalties are listed, so none is quoted.
      penalty_citations: [],
      notice_citation: {
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
    expect(citationForReport(stored, id, NOTICE_CITATION)).toEqual(
      stored.summary.cancellation.notice_citation,
    );
    // Other citations are looked up separately.
    expect(citationForReport(stored, id, 0)).toBeNull();
    expect(
      citationForReport(
        stored,
        "22e3e947-f71f-4ecd-a901-adbf24edbb8a",
        NOTICE_CITATION,
      ),
    ).toBeNull();
  });

  it.each([
    [
      "a paraphrase",
      evidence("Either party may terminate on 10 business days' notice."),
    ],
    ["a quotation from the wrong segment", evidence(clause, "section-2")],
    ["a duplicated quotation", evidence("party")],
    ["no evidence", null],
  ])("stores null and keeps the duration for %s", (_label, proposed) => {
    const stored = finalize(cancellation({ notice_evidence: proposed }));
    expect(stored.summary.cancellation.notice_citation).toBeNull();
    expect(stored.summary.cancellation).not.toHaveProperty("notice_evidence");
    expect(stored.summary.cancellation.notice_period_text).toBe(
      "10 business days",
    );
    expect(citationForReport(stored, id, NOTICE_CITATION)).toBeNull();
  });

  it("never stores a model-supplied citation as-is", () => {
    const forged = {
      contract_id: id,
      revision: contractSourceRevision(contract.text),
      index_unit: "unicode-code-points",
      status: "verified",
      quote: "Fees",
      start: 3,
      end: 7,
    };
    // The forged citation passes the schema, so parsing keeps it for the server to discard.
    expect(
      parse(strict(cancellation({ notice_citation: forged }))).summary
        .cancellation.notice_citation,
    ).toEqual(forged);
    // Without evidence the forged citation is discarded.
    expect(
      finalize(cancellation({ notice_citation: forged })).summary.cancellation
        .notice_citation,
    ).toBeNull();
    // With evidence the server's own match replaces it.
    const replaced = finalize(
      cancellation({
        notice_citation: forged,
        notice_evidence: evidence(clause),
      }),
    ).summary.cancellation.notice_citation;
    expect(replaced).toMatchObject({ quote: clause });
    expect(replaced).not.toMatchObject({ start: 3 });
  });

  it("never cites an unknown notice period", () => {
    const stored = finalize({
      how: "Not specified",
      notice_period_days: null,
      notice_period_text: null,
      notice_evidence: evidence(clause),
    });
    expect(stored.summary.cancellation.notice_citation).toBeNull();
  });

  it("keeps a legacy report readable with no citation", () => {
    const legacy = {
      source: {
        contract_id: id,
        revision: contractSourceRevision(contract.text),
        index_unit: "unicode-code-points",
      },
      ...strict({ how: "Not specified", notice_period_days: 60 }),
    };
    expect(citationForReport(legacy, id, NOTICE_CITATION)).toBeNull();
  });
});

describe("the merge prompt", () => {
  it("does not show the merge model the sections' notice quotations", () => {
    const text = `${"1. Records. Each party keeps accurate records of its own work under this agreement.\n".repeat(200)}${clause}\n`;
    const segments = contractAnalysisSegments(text);
    expect(segments.length).toBeGreaterThan(1);
    const sections = segments.map((segment) => ({
      segment,
      result: parse(
        strict(
          cancellation({ notice_evidence: evidence(clause, segment.label) }),
        ),
      ),
    }));
    const prompt = buildMergePrompt(sections, segments.length);
    expect(prompt).toContain('"notice_period_text": "10 business days"');
    expect(prompt).not.toContain("notice_evidence");
    expect(prompt).not.toContain("counted from receipt");
  });
});
