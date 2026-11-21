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
  isListedCitationRef,
  LISTED_FEES,
  LISTED_PENALTIES,
  listedCitation,
  listedCitationIndex,
  listedCitationRef,
} from "./listed-citations";
import {
  AnalysisResultSchema,
  PartialAnalysisResultSchema,
  type AnalysisResult,
} from "./schemas";
import {
  citationForReport,
  contractAnalysisSegments,
  PAYMENT_CITATION,
} from "./source-citations";

const id = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const late = "Late payment fee of 50 GBP";
const lateClause =
  "A late payment fee of 50 GBP applies to any invoice paid more than 14 days after its due date.";
const setup = "One-off set-up fee of 300 GBP";
const setupClause = "The Customer pays a one-off set-up fee of 300 GBP.";
const paymentClause = "The Customer pays 500 EUR each month.";
// The emoji makes code point and UTF-16 offsets differ; "the Customer" appears more than once.
const contract = {
  id,
  text: `1. Services 😀 are described in the order form.\n\n2. Fees. ${paymentClause}\n${setupClause}\n${lateClause}\n`,
};
const proposal = (fee: string, quote: string, segment = "full") => ({
  fee,
  quote,
  segment,
});

const payments = (extra: Record<string, unknown> = {}) => ({
  amount: null,
  frequency: null,
  fees: [late],
  ...extra,
});

const strict = (paid: Record<string, unknown> = payments()) => ({
  risk_badge: "LOW",
  key_points: ["Late payment costs 50 GBP."],
  summary: {
    what_it_is: "A services agreement",
    payments: paid,
    term: { start: null, end: null, minimum_term: null },
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

function finalize(paid: Record<string, unknown>) {
  return finalizeAnalysisResult(parse(strict(paid)), contract);
}

const offsetsOf = (quote: string) => {
  const start = Array.from(
    contract.text.slice(0, contract.text.indexOf(quote)),
  ).length;
  return { start, end: start + Array.from(quote).length };
};

describe("fee citation references", () => {
  it("name a fee by its index, separately from penalties", () => {
    expect(listedCitationRef(LISTED_FEES, 2)).toBe("fee-2");
    expect(listedCitationIndex(LISTED_FEES, "fee-2")).toBe(2);
    expect(listedCitationIndex(LISTED_PENALTIES, "fee-2")).toBeNull();
    expect(listedCitationIndex(LISTED_FEES, "penalty-2")).toBeNull();
    for (const other of ["fee-", "fee-1000", "fee--1", "fee-0x1", "fees-0", "2", 2, "payment"]) {
      expect(listedCitationIndex(LISTED_FEES, other)).toBeNull();
      expect(isListedCitationRef(other)).toBe(false);
    }
    expect(isListedCitationRef("fee-0")).toBe(true);
    expect(isListedCitationRef("penalty-0")).toBe(true);
  });

  it("look up a stored citation by the fee's exact text only", () => {
    const stored = { fee_citations: [{ fee: late, citation: { quote: "x" } }] };
    expect(listedCitation(LISTED_FEES, stored, late)).toEqual({ quote: "x" });
    expect(listedCitation(LISTED_FEES, stored, late.toLowerCase())).toBeNull();
    expect(listedCitation(LISTED_FEES, stored, ` ${late}`)).toBeNull();
    expect(listedCitation(LISTED_FEES, {}, late)).toBeNull();
    expect(listedCitation(LISTED_FEES, null, late)).toBeNull();
    expect(listedCitation(LISTED_FEES, stored, 0)).toBeNull();
    // Penalty citations are a different list, even for the same text.
    expect(listedCitation(LISTED_PENALTIES, stored, late)).toBeNull();
    expect(
      listedCitation(LISTED_FEES, { penalty_citations: [{ penalty: late, citation: {} }] }, late),
    ).toBeNull();
  });
});

describe("fee_evidence in analysis output", () => {
  const offered = [proposal(late, lateClause)];

  it.each([
    ["strict", strict(payments({ fee_evidence: offered }))],
    [
      "partial",
      {
        risk_badge: "LOW",
        key_points: ["Late payment costs money."],
        summary: {
          payments: payments({ fee_evidence: offered }),
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
          payments: { amount: null, frequency: null, fees: `- ${late}`, feeEvidence: offered },
        },
      },
    ],
  ])("survives %s parsing with the fees", (_path, payload) => {
    expect(parse(payload).summary.payments).toMatchObject({
      fees: [late],
      fee_evidence: offered,
    });
  });

  it("drops malformed entries one by one instead of rejecting the analysis", () => {
    const parsed = parse(
      strict(
        payments({
          fee_evidence: [
            "clause",
            { quote: lateClause, segment: "full" },
            proposal("", lateClause),
            proposal(late, "", "full"),
            proposal(late, lateClause, "tail"),
            { penalty: late, quote: lateClause, segment: "full" },
            7,
            proposal(late, lateClause),
          ],
          fee_citations: [{ fee: late, citation: "forged" }, null],
        }),
      ),
    );
    expect(parsed.summary.payments.fee_evidence).toEqual([proposal(late, lateClause)]);
    expect(parsed.summary.payments.fee_citations).toEqual([]);
    expect(parsed.summary.payments.fees).toEqual([late]);
  });

  it("drops a malformed list whole", () => {
    for (const malformed of ["clause", { fee: late }, 7]) {
      const parsed = parse(
        strict(payments({ fee_evidence: malformed, fee_citations: malformed })),
      );
      expect(parsed.summary.payments.fee_evidence ?? []).toEqual([]);
      expect(parsed.summary.payments.fee_citations ?? []).toEqual([]);
      expect(parsed.summary.payments.fees).toEqual([late]);
    }
  });

  it("keeps reports stored before the fields valid", () => {
    expect(AnalysisResultSchema.safeParse(strict()).success).toBe(true);
    expect(
      PartialAnalysisResultSchema.safeParse({
        risk_badge: "LOW",
        key_points: ["Fees."],
        summary: {
          payments: { fees: [late] },
          renewal: { auto_renew: false },
          cancellation: { how: "Not specified", notice_period_days: null },
        },
      }).success,
    ).toBe(true);
  });

  it("asks for one quotation per listed fee, repeating its text exactly", () => {
    const { prompt } = buildAnalysisPrompt("Contract body");
    expect(prompt).toContain(
      'For each entry in "summary.payments.fees", add one entry to "summary.payments.fee_evidence": its "fee" repeats that fee\'s text exactly',
    );
    expect(prompt).toContain('When no fees are listed, "fee_evidence" is an empty array.');
    expect(prompt).toContain('"fee_evidence": [{ "fee":');
  });
});

describe("finalizing fee quotations", () => {
  it("stores a verified citation keyed by the fee, with offsets and revision", () => {
    const stored = finalize(payments({ fee_evidence: [proposal(late, lateClause)] }));
    expect(stored.summary.payments).toEqual({
      ...payments(),
      fee_citations: [
        {
          fee: late,
          citation: {
            contract_id: id,
            revision: contractSourceRevision(contract.text),
            index_unit: "unicode-code-points",
            status: "verified",
            quote: lateClause,
            ...offsetsOf(lateClause),
          },
        },
      ],
      payment_citation: null,
    });
    const { start, end } = offsetsOf(lateClause);
    expect(Array.from(contract.text).slice(start, end).join("")).toBe(lateClause);
    expect(citationForReport(stored, id, "fee-0")).toEqual(
      stored.summary.payments.fee_citations![0]!.citation,
    );
    // Other citations are looked up separately.
    expect(citationForReport(stored, id, "fee-1")).toBeNull();
    expect(citationForReport(stored, id, "penalty-0")).toBeNull();
    expect(citationForReport(stored, id, PAYMENT_CITATION)).toBeNull();
    expect(citationForReport(stored, id, 0)).toBeNull();
    expect(
      citationForReport(stored, "22e3e947-f71f-4ecd-a901-adbf24edbb8a", "fee-0"),
    ).toBeNull();
  });

  it.each([
    ["a paraphrase", [proposal(late, "Paying more than 14 days late costs 50 GBP.")]],
    ["a quotation from the wrong segment", [proposal(late, lateClause, "section-2")]],
    ["a duplicated quotation", [proposal(late, "the Customer")]],
    ["no evidence", []],
  ])("stores no entry and keeps the fee for %s", (_label, proposed) => {
    const stored = finalize(payments({ fee_evidence: proposed }));
    expect(stored.summary.payments.fees).toEqual([late]);
    expect(stored.summary.payments.fee_citations).toEqual([]);
    expect(stored.summary.payments).not.toHaveProperty("fee_evidence");
    expect(citationForReport(stored, id, "fee-0")).toBeNull();
  });

  it("takes the first verifiable proposal for a fee", () => {
    const stored = finalize(
      payments({
        fee_evidence: [
          proposal(late, "the Customer"),
          proposal(late, lateClause),
          proposal(late, setupClause),
        ],
      }),
    );
    expect(citationForReport(stored, id, "fee-0")?.quote).toBe(lateClause);
  });

  it("discards a proposal whose fee does not exactly match a listed one", () => {
    for (const named of [late.toLowerCase(), `${late}.`, setup]) {
      const stored = finalize(payments({ fee_evidence: [proposal(named, lateClause)] }));
      expect(stored.summary.payments.fee_citations).toEqual([]);
      expect(stored.summary.payments.fees).toEqual([late]);
    }
  });

  it("stores nothing when no fees are listed, even with proposals", () => {
    const stored = finalize(
      payments({ fees: [], fee_evidence: [proposal(late, lateClause)] }),
    );
    expect(stored.summary.payments.fee_citations).toEqual([]);
    expect(citationForReport(stored, id, "fee-0")).toBeNull();
  });

  it("gives each of two fees its own quotation, never the other's", () => {
    const stored = finalize(
      payments({
        fees: [late, setup],
        // Listed in the other order, so nothing depends on position.
        fee_evidence: [proposal(setup, setupClause), proposal(late, lateClause)],
      }),
    );
    expect(citationForReport(stored, id, "fee-0")).toMatchObject({
      quote: lateClause,
      ...offsetsOf(lateClause),
    });
    expect(citationForReport(stored, id, "fee-1")).toMatchObject({
      quote: setupClause,
      ...offsetsOf(setupClause),
    });

    // With only the second fee quoted, the first has none rather than the second's.
    const one = finalize(
      payments({ fees: [late, setup], fee_evidence: [proposal(setup, setupClause)] }),
    );
    expect(citationForReport(one, id, "fee-0")).toBeNull();
    expect(citationForReport(one, id, "fee-1")?.quote).toBe(setupClause);
  });

  it("cites a fee beside the payment amount's own quotation on the same payments", () => {
    const stored = finalize(
      payments({
        amount: "500 EUR",
        frequency: "Monthly",
        payment_evidence: { quote: paymentClause, segment: "full" },
        fees: [late],
        fee_evidence: [proposal(late, lateClause)],
      }),
    );
    expect(stored.summary.payments).toMatchObject({
      amount: "500 EUR",
      frequency: "Monthly",
      fees: [late],
      payment_citation: { status: "verified", quote: paymentClause, ...offsetsOf(paymentClause) },
      fee_citations: [
        { fee: late, citation: { status: "verified", quote: lateClause, ...offsetsOf(lateClause) } },
      ],
    });
    expect(citationForReport(stored, id, PAYMENT_CITATION)?.quote).toBe(paymentClause);
    expect(citationForReport(stored, id, "fee-0")?.quote).toBe(lateClause);
    expect(stored.summary.payments).not.toHaveProperty("payment_evidence");
    expect(stored.summary.payments).not.toHaveProperty("fee_evidence");
  });

  it("verifies a charge listed as both a fee and a penalty in each list on its own", () => {
    const parsed = parse({
      ...strict(payments({ fee_evidence: [proposal(late, lateClause)] })),
    });
    parsed.summary.cancellation.penalties = [late];
    parsed.summary.cancellation.penalty_evidence = [];
    const stored = finalizeAnalysisResult(parsed, contract);
    expect(citationForReport(stored, id, "fee-0")?.quote).toBe(lateClause);
    expect(citationForReport(stored, id, "penalty-0")).toBeNull();
  });

  it("never stores a model-supplied citation as-is", () => {
    const forged = {
      fee: late,
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
      parse(strict(payments({ fee_citations: [forged] }))).summary.payments.fee_citations,
    ).toEqual([forged]);
    // Without evidence the forged citation is discarded.
    expect(
      finalize(payments({ fee_citations: [forged] })).summary.payments.fee_citations,
    ).toEqual([]);
    // With evidence the server's own match replaces it.
    const replaced = finalize(
      payments({ fee_citations: [forged], fee_evidence: [proposal(late, lateClause)] }),
    ).summary.payments.fee_citations;
    expect(replaced).toHaveLength(1);
    expect(replaced![0]!.citation).toMatchObject({ quote: lateClause });
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
    expect(citationForReport(legacy, id, "fee-0")).toBeNull();
  });
});

describe("the merge prompt", () => {
  it("does not show the merge model the sections' fee quotations", () => {
    const text = `${"1. Records. Each party keeps accurate records of its own work under this agreement.\n".repeat(200)}${lateClause}\n`;
    const segments = contractAnalysisSegments(text);
    expect(segments.length).toBeGreaterThan(1);
    const sections = segments.map((segment) => ({
      segment,
      result: parse(
        strict(payments({ fee_evidence: [proposal(late, lateClause, segment.label)] })),
      ),
    }));
    const prompt = buildMergePrompt(sections, segments.length);
    expect(prompt).toContain(late);
    expect(prompt).not.toContain("fee_evidence");
    expect(prompt).not.toContain("fee_citations");
    expect(prompt).not.toContain("applies to any invoice paid");
  });
});
