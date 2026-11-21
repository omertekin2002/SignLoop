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
import { formatAutoRenew, isRenewalStated } from "./renewal";
import {
  AnalysisResultSchema,
  PartialAnalysisResultSchema,
  type AnalysisResult,
} from "./schemas";
import {
  citationForReport,
  contractAnalysisSegments,
  NOTICE_CITATION,
  RENEWAL_CITATION,
} from "./source-citations";

const id = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const clause =
  "This Agreement renews automatically for successive one-year terms unless either party cancels it in writing.";
// The emoji makes code point and UTF-16 offsets differ; "Agreement" appears twice.
const contract = {
  id,
  text: `1. Fees 😀 are due monthly under this Agreement.\n\n7. Renewal. ${clause}`,
};
const evidence = (quote: string, segment = "full") => ({ quote, segment });

const renewal = (extra: Record<string, unknown> = {}) => ({
  auto_renew: true,
  renewal_period: "1 year",
  ...extra,
});

const strict = (renewed: Record<string, unknown> = renewal()) => ({
  risk_badge: "LOW",
  key_points: ["Fees are due monthly."],
  summary: {
    what_it_is: "A services agreement",
    payments: { amount: null, frequency: "Monthly", fees: [] },
    term: { start: null, end: null, minimum_term: null },
    renewal: renewed,
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

function finalize(renewed: Record<string, unknown>) {
  return finalizeAnalysisResult(parse(strict(renewed)), contract);
}

describe("isRenewalStated and formatAutoRenew", () => {
  it.each([
    [{ auto_renew: true }, true],
    [{ auto_renew: false }, true],
    [{ auto_renew: null, renewal_period: "12 months" }, true],
    [{ auto_renew: null, renewal_period: null }, false],
    [{ auto_renew: null, renewal_period: "Not specified" }, false],
    [{ auto_renew: "true", renewal_period: " " }, false],
    [{}, false],
  ])("%j is stated: %s", (value, stated) => {
    expect(isRenewalStated(value)).toBe(stated);
  });

  it("words automatic renewal as the contract states it", () => {
    expect(formatAutoRenew(true, "Unknown")).toBe("Auto-renews");
    expect(formatAutoRenew(false, "Unknown")).toBe("Does not auto-renew");
    expect(formatAutoRenew(null, "Not specified")).toBe("Not specified");
  });
});

describe("renewal_evidence in analysis output", () => {
  it.each([
    ["strict", strict(renewal({ renewal_evidence: evidence(clause) }))],
    [
      "partial",
      {
        risk_badge: "LOW",
        key_points: ["Fees are due monthly."],
        summary: {
          renewal: renewal({ renewal_evidence: evidence(clause) }),
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
          renewal: {
            autoRenew: "yes",
            renewalPeriod: "1 year",
            renewalEvidence: evidence(clause),
          },
        },
      },
    ],
  ])("survives %s parsing with the renewal values", (_path, payload) => {
    expect(parse(payload).summary.renewal).toMatchObject({
      auto_renew: true,
      renewal_period: "1 year",
      renewal_evidence: evidence(clause),
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
          renewal({
            renewal_evidence: malformed,
            renewal_citation: malformed,
          }),
        ),
      );
      expect(parsed.summary.renewal.renewal_evidence ?? null).toBeNull();
      expect(parsed.summary.renewal.renewal_citation ?? null).toBeNull();
      expect(parsed.summary.renewal).toMatchObject({
        auto_renew: true,
        renewal_period: "1 year",
      });
    }
  });

  it("keeps reports stored before the fields valid", () => {
    const legacy = strict({ auto_renew: true, renewal_period: "1 year" });
    expect(AnalysisResultSchema.safeParse(legacy).success).toBe(true);
    expect(
      PartialAnalysisResultSchema.safeParse({
        risk_badge: "LOW",
        key_points: ["Fees."],
        summary: {
          renewal: { auto_renew: false },
          cancellation: { how: "Not specified", notice_period_days: null },
        },
      }).success,
    ).toBe(true);
  });

  it("asks for the clause stating whether and how the contract renews", () => {
    const { prompt } = buildAnalysisPrompt("Contract body");
    expect(prompt).toContain(
      '"summary.renewal.renewal_evidence" quotes the exact sentence or clause that says so',
    );
    expect(prompt).toContain("Use null when renewal is not stated.");
    expect(prompt).toContain('"renewal_evidence": { "quote":');
  });
});

describe("finalizing a renewal quotation", () => {
  it("stores a verified citation for an exact quotation, with offsets and revision", () => {
    const stored = finalize(renewal({ renewal_evidence: evidence(clause) }));
    const start = Array.from(contract.text).length - Array.from(clause).length;
    expect(stored.summary.renewal).toEqual({
      auto_renew: true,
      renewal_period: "1 year",
      renewal_citation: {
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
    expect(citationForReport(stored, id, RENEWAL_CITATION)).toEqual(
      stored.summary.renewal.renewal_citation,
    );
    // Other citations are looked up separately.
    expect(citationForReport(stored, id, NOTICE_CITATION)).toBeNull();
    expect(citationForReport(stored, id, 0)).toBeNull();
    expect(
      citationForReport(
        stored,
        "22e3e947-f71f-4ecd-a901-adbf24edbb8a",
        RENEWAL_CITATION,
      ),
    ).toBeNull();
  });

  it("cites renewal that is stated only as not renewing automatically, or only by its period", () => {
    for (const stated of [
      { auto_renew: false, renewal_period: null },
      { auto_renew: null, renewal_period: "1 year" },
    ]) {
      expect(
        finalize({ ...stated, renewal_evidence: evidence(clause) }).summary
          .renewal.renewal_citation,
      ).toMatchObject({ status: "verified", quote: clause });
    }
  });

  it.each([
    [
      "a paraphrase",
      evidence("The Agreement renews every year unless cancelled."),
    ],
    ["a quotation from the wrong segment", evidence(clause, "section-2")],
    ["a duplicated quotation", evidence("Agreement")],
    ["no evidence", null],
  ])("stores null and keeps the renewal values for %s", (_label, proposed) => {
    const stored = finalize(renewal({ renewal_evidence: proposed }));
    expect(stored.summary.renewal).toEqual({
      auto_renew: true,
      renewal_period: "1 year",
      renewal_citation: null,
    });
    expect(citationForReport(stored, id, RENEWAL_CITATION)).toBeNull();
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
      parse(strict(renewal({ renewal_citation: forged }))).summary.renewal
        .renewal_citation,
    ).toEqual(forged);
    // Without evidence the forged citation is discarded.
    expect(
      finalize(renewal({ renewal_citation: forged })).summary.renewal
        .renewal_citation,
    ).toBeNull();
    // With evidence the server's own match replaces it.
    const replaced = finalize(
      renewal({ renewal_citation: forged, renewal_evidence: evidence(clause) }),
    ).summary.renewal.renewal_citation;
    expect(replaced).toMatchObject({ quote: clause });
    expect(replaced).not.toMatchObject({ start: 3 });
  });

  it("never cites unknown renewal, even when a quotation was sent", () => {
    for (const unknown of [
      { auto_renew: null, renewal_period: null },
      { auto_renew: null, renewal_period: "Not specified" },
    ]) {
      const stored = finalize({
        ...unknown,
        renewal_evidence: evidence(clause),
      });
      expect(stored.summary.renewal.renewal_citation).toBeNull();
      expect(stored.summary.renewal.auto_renew).toBeNull();
    }
  });

  it("verifies the renewal and notice quotations independently, even when they are the same text", () => {
    const stored = finalizeAnalysisResult(
      parse({
        ...strict(renewal({ renewal_evidence: evidence(clause) })),
        summary: {
          ...strict().summary,
          renewal: renewal({ renewal_evidence: evidence(clause) }),
          cancellation: {
            how: "In writing",
            notice_period_days: null,
            notice_period_text: "before the end of the term",
            notice_evidence: evidence(clause),
            penalties: [],
          },
        },
      }),
      contract,
    );
    expect(stored.summary.renewal.renewal_citation?.quote).toBe(clause);
    expect(stored.summary.cancellation.notice_citation?.quote).toBe(clause);
  });

  it("keeps a legacy report readable with no citation", () => {
    const legacy = {
      source: {
        contract_id: id,
        revision: contractSourceRevision(contract.text),
        index_unit: "unicode-code-points",
      },
      ...strict({ auto_renew: true, renewal_period: "1 year" }),
    };
    expect(citationForReport(legacy, id, RENEWAL_CITATION)).toBeNull();
  });
});

describe("the merge prompt", () => {
  it("does not show the merge model the sections' renewal quotations", () => {
    const text = `${"1. Records. Each party keeps accurate records of its own work under this agreement.\n".repeat(200)}${clause}\n`;
    const segments = contractAnalysisSegments(text);
    expect(segments.length).toBeGreaterThan(1);
    const sections = segments.map((segment) => ({
      segment,
      result: parse(
        strict(renewal({ renewal_evidence: evidence(clause, segment.label) })),
      ),
    }));
    const prompt = buildMergePrompt(sections, segments.length);
    expect(prompt).toContain('"renewal_period": "1 year"');
    expect(prompt).not.toContain("renewal_evidence");
    expect(prompt).not.toContain("cancels it in writing");
    expect(prompt).toContain(
      "auto_renew and renewal_period together from the section that states them",
    );
  });
});
