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
  penaltyCitation,
  penaltyCitationIndex,
  penaltyCitationRef,
} from "./penalties";
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
const earlyExit = "Early termination fee equal to two months' fees";
const earlyExitClause =
  "If the Customer ends this agreement early, the Customer pays an early termination fee equal to two months' fees.";
const lateReturn = "Unreturned equipment is charged at cost";
const lateReturnClause =
  "Equipment not returned within 30 days of termination is charged at cost.";
// The emoji makes code point and UTF-16 offsets differ; "the Customer" appears more than once.
const contract = {
  id,
  text: `1. Services 😀 are described in the order form.\n\n7. Termination. ${earlyExitClause}\n${lateReturnClause}\n`,
};
const proposal = (penalty: string, quote: string, segment = "full") => ({
  penalty,
  quote,
  segment,
});

const cancellation = (extra: Record<string, unknown> = {}) => ({
  how: "In writing",
  notice_period_days: null,
  notice_period_text: null,
  penalties: [earlyExit],
  ...extra,
});

const strict = (cancelled: Record<string, unknown> = cancellation()) => ({
  risk_badge: "LOW",
  key_points: ["Leaving early costs two months' fees."],
  summary: {
    what_it_is: "A services agreement",
    payments: { amount: null, frequency: null, fees: [] },
    term: { start: null, end: null, minimum_term: null },
    renewal: { auto_renew: null, renewal_period: null },
    cancellation: cancelled,
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

const offsetsOf = (quote: string) => {
  const start = Array.from(
    contract.text.slice(0, contract.text.indexOf(quote)),
  ).length;
  return { start, end: start + Array.from(quote).length };
};

describe("penalty citation references", () => {
  it("name a penalty by its index", () => {
    expect(penaltyCitationRef(2)).toBe("penalty-2");
    expect(penaltyCitationIndex("penalty-2")).toBe(2);
    for (const other of ["penalty-", "penalty-1000", "penalty--1", "2", 2, "notice"]) {
      expect(penaltyCitationIndex(other)).toBeNull();
    }
  });

  it("look up a stored citation by the penalty's exact text only", () => {
    const stored = { penalty_citations: [{ penalty: earlyExit, citation: { quote: "x" } }] };
    expect(penaltyCitation(stored, earlyExit)).toEqual({ quote: "x" });
    expect(penaltyCitation(stored, earlyExit.toLowerCase())).toBeNull();
    expect(penaltyCitation(stored, ` ${earlyExit}`)).toBeNull();
    expect(penaltyCitation({}, earlyExit)).toBeNull();
    expect(penaltyCitation(null, earlyExit)).toBeNull();
    expect(penaltyCitation(stored, 0)).toBeNull();
  });
});

describe("penalty_evidence in analysis output", () => {
  const offered = [proposal(earlyExit, earlyExitClause)];

  it.each([
    ["strict", strict(cancellation({ penalty_evidence: offered }))],
    [
      "partial",
      {
        risk_badge: "LOW",
        key_points: ["Leaving early costs money."],
        summary: {
          renewal: { auto_renew: null },
          cancellation: cancellation({ penalty_evidence: offered }),
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
            how: "In writing",
            notice_period_days: null,
            penalties: `- ${earlyExit}`,
            penaltyEvidence: offered,
          },
        },
      },
    ],
  ])("survives %s parsing with the penalties", (_path, payload) => {
    expect(parse(payload).summary.cancellation).toMatchObject({
      penalties: [earlyExit],
      penalty_evidence: offered,
    });
  });

  it("drops malformed entries one by one instead of rejecting the analysis", () => {
    const parsed = parse(
      strict(
        cancellation({
          penalty_evidence: [
            "clause",
            { quote: earlyExitClause, segment: "full" },
            proposal("", earlyExitClause),
            proposal(earlyExit, "", "full"),
            proposal(earlyExit, earlyExitClause, "tail"),
            7,
            proposal(earlyExit, earlyExitClause),
          ],
          penalty_citations: [{ penalty: earlyExit, citation: "forged" }, null],
        }),
      ),
    );
    expect(parsed.summary.cancellation.penalty_evidence).toEqual([
      proposal(earlyExit, earlyExitClause),
    ]);
    expect(parsed.summary.cancellation.penalty_citations).toEqual([]);
    expect(parsed.summary.cancellation.penalties).toEqual([earlyExit]);
  });

  it("drops a malformed list whole", () => {
    for (const malformed of ["clause", { penalty: earlyExit }, 7]) {
      const parsed = parse(
        strict(cancellation({ penalty_evidence: malformed, penalty_citations: malformed })),
      );
      expect(parsed.summary.cancellation.penalty_evidence ?? []).toEqual([]);
      expect(parsed.summary.cancellation.penalty_citations ?? []).toEqual([]);
      expect(parsed.summary.cancellation.penalties).toEqual([earlyExit]);
    }
  });

  it("keeps reports stored before the fields valid", () => {
    expect(AnalysisResultSchema.safeParse(strict()).success).toBe(true);
    expect(
      PartialAnalysisResultSchema.safeParse({
        risk_badge: "LOW",
        key_points: ["Fees."],
        summary: {
          renewal: { auto_renew: false },
          cancellation: { how: "Not specified", notice_period_days: null, penalties: [earlyExit] },
        },
      }).success,
    ).toBe(true);
  });

  it("asks for one quotation per listed penalty, repeating its text exactly", () => {
    const { prompt } = buildAnalysisPrompt("Contract body");
    expect(prompt).toContain(
      'For each entry in "summary.cancellation.penalties", add one entry to "summary.cancellation.penalty_evidence": its "penalty" repeats that penalty\'s text exactly',
    );
    expect(prompt).toContain(
      'When no penalties are listed, "penalty_evidence" is an empty array.',
    );
    expect(prompt).toContain('"penalty_evidence": [{ "penalty":');
  });
});

describe("finalizing penalty quotations", () => {
  it("stores a verified citation keyed by the penalty, with offsets and revision", () => {
    const stored = finalize(
      cancellation({ penalty_evidence: [proposal(earlyExit, earlyExitClause)] }),
    );
    expect(stored.summary.cancellation).toEqual({
      ...cancellation(),
      penalty_citations: [
        {
          penalty: earlyExit,
          citation: {
            contract_id: id,
            revision: contractSourceRevision(contract.text),
            index_unit: "unicode-code-points",
            status: "verified",
            quote: earlyExitClause,
            ...offsetsOf(earlyExitClause),
          },
        },
      ],
      notice_citation: null,
    });
    const { start, end } = offsetsOf(earlyExitClause);
    expect(Array.from(contract.text).slice(start, end).join("")).toBe(earlyExitClause);
    expect(citationForReport(stored, id, "penalty-0")).toEqual(
      stored.summary.cancellation.penalty_citations![0]!.citation,
    );
    // Other citations are looked up separately.
    expect(citationForReport(stored, id, "penalty-1")).toBeNull();
    expect(citationForReport(stored, id, NOTICE_CITATION)).toBeNull();
    expect(citationForReport(stored, id, 0)).toBeNull();
    expect(
      citationForReport(stored, "22e3e947-f71f-4ecd-a901-adbf24edbb8a", "penalty-0"),
    ).toBeNull();
  });

  it.each([
    ["a paraphrase", [proposal(earlyExit, "Leaving early costs two months' fees.")]],
    ["a quotation from the wrong segment", [proposal(earlyExit, earlyExitClause, "section-2")]],
    ["a duplicated quotation", [proposal(earlyExit, "the Customer")]],
    ["no evidence", []],
  ])("stores no entry and keeps the penalty for %s", (_label, proposed) => {
    const stored = finalize(cancellation({ penalty_evidence: proposed }));
    expect(stored.summary.cancellation.penalties).toEqual([earlyExit]);
    expect(stored.summary.cancellation.penalty_citations).toEqual([]);
    expect(stored.summary.cancellation).not.toHaveProperty("penalty_evidence");
    expect(citationForReport(stored, id, "penalty-0")).toBeNull();
  });

  it("takes the first verifiable proposal for a penalty", () => {
    const stored = finalize(
      cancellation({
        penalty_evidence: [
          proposal(earlyExit, "the Customer"),
          proposal(earlyExit, earlyExitClause),
          proposal(earlyExit, lateReturnClause),
        ],
      }),
    );
    expect(citationForReport(stored, id, "penalty-0")?.quote).toBe(earlyExitClause);
  });

  it("discards a proposal whose penalty does not exactly match a listed one", () => {
    for (const named of [earlyExit.toLowerCase(), `${earlyExit}.`, lateReturn]) {
      const stored = finalize(
        cancellation({ penalty_evidence: [proposal(named, earlyExitClause)] }),
      );
      expect(stored.summary.cancellation.penalty_citations).toEqual([]);
      expect(stored.summary.cancellation.penalties).toEqual([earlyExit]);
    }
  });

  it("stores nothing when no penalties are listed, even with proposals", () => {
    const stored = finalize(
      cancellation({
        penalties: [],
        penalty_evidence: [proposal(earlyExit, earlyExitClause)],
      }),
    );
    expect(stored.summary.cancellation.penalty_citations).toEqual([]);
    expect(citationForReport(stored, id, "penalty-0")).toBeNull();
  });

  it("gives each of two penalties its own quotation, never the other's", () => {
    const stored = finalize(
      cancellation({
        penalties: [earlyExit, lateReturn],
        // Listed in the other order, so nothing depends on position.
        penalty_evidence: [
          proposal(lateReturn, lateReturnClause),
          proposal(earlyExit, earlyExitClause),
        ],
      }),
    );
    expect(citationForReport(stored, id, "penalty-0")).toMatchObject({
      quote: earlyExitClause,
      ...offsetsOf(earlyExitClause),
    });
    expect(citationForReport(stored, id, "penalty-1")).toMatchObject({
      quote: lateReturnClause,
      ...offsetsOf(lateReturnClause),
    });

    // With only the second penalty quoted, the first has none rather than the second's.
    const one = finalize(
      cancellation({
        penalties: [earlyExit, lateReturn],
        penalty_evidence: [proposal(lateReturn, lateReturnClause)],
      }),
    );
    expect(citationForReport(one, id, "penalty-0")).toBeNull();
    expect(citationForReport(one, id, "penalty-1")?.quote).toBe(lateReturnClause);
  });

  it("never stores a model-supplied citation as-is", () => {
    const forged = {
      penalty: earlyExit,
      citation: {
        contract_id: id,
        revision: contractSourceRevision(contract.text),
        index_unit: "unicode-code-points",
        status: "verified",
        quote: "Services",
        start: 3,
        end: 11,
      },
    };
    // The forged citation passes the schema, so parsing keeps it for the server to discard.
    expect(
      parse(strict(cancellation({ penalty_citations: [forged] }))).summary
        .cancellation.penalty_citations,
    ).toEqual([forged]);
    // Without evidence the forged citation is discarded.
    expect(
      finalize(cancellation({ penalty_citations: [forged] })).summary.cancellation
        .penalty_citations,
    ).toEqual([]);
    // With evidence the server's own match replaces it.
    const replaced = finalize(
      cancellation({
        penalty_citations: [forged],
        penalty_evidence: [proposal(earlyExit, earlyExitClause)],
      }),
    ).summary.cancellation.penalty_citations;
    expect(replaced).toHaveLength(1);
    expect(replaced![0]!.citation).toMatchObject({ quote: earlyExitClause });
    expect(replaced![0]!.citation).not.toMatchObject({ start: 3 });
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
    expect(citationForReport(legacy, id, "penalty-0")).toBeNull();
  });
});

describe("the merge prompt", () => {
  it("does not show the merge model the sections' penalty quotations", () => {
    const text = `${"1. Records. Each party keeps accurate records of its own work under this agreement.\n".repeat(200)}${earlyExitClause}\n`;
    const segments = contractAnalysisSegments(text);
    expect(segments.length).toBeGreaterThan(1);
    const sections = segments.map((segment) => ({
      segment,
      result: parse(
        strict(
          cancellation({
            penalty_evidence: [proposal(earlyExit, earlyExitClause, segment.label)],
          }),
        ),
      ),
    }));
    const prompt = buildMergePrompt(sections, segments.length);
    expect(prompt).toContain(earlyExit);
    expect(prompt).not.toContain("penalty_evidence");
    expect(prompt).not.toContain("penalty_citations");
    expect(prompt).not.toContain("If the Customer ends this agreement early");
  });
});
