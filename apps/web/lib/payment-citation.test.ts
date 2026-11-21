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
import { isPaymentStated } from "./payment";
import {
  AnalysisResultSchema,
  PartialAnalysisResultSchema,
  type AnalysisResult,
} from "./schemas";
import {
  citationForReport,
  contractAnalysisSegments,
  PAYMENT_CITATION,
  RENEWAL_CITATION,
} from "./source-citations";

const id = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const clause =
  "The Customer pays a fee of 500 EUR each month, in advance, for the Services.";
// The emoji makes code point and UTF-16 offsets differ; "Services" appears twice.
const contract = {
  id,
  text: `1. Services 😀 are described in the order form.\n\n4. Fees. ${clause}`,
};
const evidence = (quote: string, segment = "full") => ({ quote, segment });

const payments = (extra: Record<string, unknown> = {}) => ({
  amount: "500 EUR",
  frequency: "Monthly",
  fees: [],
  ...extra,
});

const strict = (paid: Record<string, unknown> = payments()) => ({
  risk_badge: "LOW",
  key_points: ["Fees are due monthly."],
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

describe("isPaymentStated", () => {
  it.each([
    [{ amount: "500 EUR", frequency: "Monthly" }, true],
    [{ amount: "500 EUR", frequency: null }, true],
    [{ amount: null, frequency: "Monthly" }, true],
    [{ amount: "Not specified", frequency: "Unknown" }, false],
    [{ amount: null, frequency: null }, false],
    [{ amount: " ", frequency: 12 }, false],
    [{}, false],
  ])("%j is stated: %s", (value, stated) => {
    expect(isPaymentStated(value)).toBe(stated);
  });
});

describe("payment_evidence in analysis output", () => {
  it.each([
    ["strict", strict(payments({ payment_evidence: evidence(clause) }))],
    [
      "partial",
      {
        risk_badge: "LOW",
        key_points: ["Fees are due monthly."],
        summary: {
          payments: payments({ payment_evidence: evidence(clause) }),
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
          payments: undefined,
          payment: {
            price: "500 EUR",
            cadence: "Monthly",
            paymentEvidence: evidence(clause),
          },
        },
      },
    ],
  ])("survives %s parsing with the payment values", (_path, payload) => {
    expect(parse(payload).summary.payments).toMatchObject({
      amount: "500 EUR",
      frequency: "Monthly",
      payment_evidence: evidence(clause),
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
          payments({
            payment_evidence: malformed,
            payment_citation: malformed,
          }),
        ),
      );
      expect(parsed.summary.payments.payment_evidence ?? null).toBeNull();
      expect(parsed.summary.payments.payment_citation ?? null).toBeNull();
      expect(parsed.summary.payments).toMatchObject({
        amount: "500 EUR",
        frequency: "Monthly",
      });
    }
  });

  it("keeps reports stored before the fields valid", () => {
    expect(AnalysisResultSchema.safeParse(strict()).success).toBe(true);
    expect(
      PartialAnalysisResultSchema.safeParse({
        risk_badge: "LOW",
        key_points: ["Fees."],
        summary: {
          payments: { amount: "500 EUR" },
          renewal: { auto_renew: false },
          cancellation: { how: "Not specified", notice_period_days: null },
        },
      }).success,
    ).toBe(true);
  });

  it("asks for the clause stating the payment amount or frequency", () => {
    const { prompt } = buildAnalysisPrompt("Contract body");
    expect(prompt).toContain(
      'When the contract states a payment amount or frequency, "summary.payments.payment_evidence" quotes the exact sentence or clause that says so',
    );
    expect(prompt).toContain(
      "Use null when neither a payment amount nor a frequency is stated.",
    );
    expect(prompt).toContain('"payment_evidence": { "quote":');
  });
});

describe("finalizing a payment quotation", () => {
  it("stores a verified citation for an exact quotation, with offsets and revision", () => {
    const stored = finalize(payments({ payment_evidence: evidence(clause) }));
    const start = Array.from(contract.text).length - Array.from(clause).length;
    expect(stored.summary.payments).toEqual({
      amount: "500 EUR",
      frequency: "Monthly",
      fees: [],
      payment_citation: {
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
    expect(citationForReport(stored, id, PAYMENT_CITATION)).toEqual(
      stored.summary.payments.payment_citation,
    );
    // Other citations are looked up separately.
    expect(citationForReport(stored, id, RENEWAL_CITATION)).toBeNull();
    expect(citationForReport(stored, id, 0)).toBeNull();
    expect(
      citationForReport(
        stored,
        "22e3e947-f71f-4ecd-a901-adbf24edbb8a",
        PAYMENT_CITATION,
      ),
    ).toBeNull();
  });

  it("cites payment stated only by its amount, or only by its frequency", () => {
    for (const stated of [
      { amount: "500 EUR", frequency: null },
      { amount: null, frequency: "Monthly" },
    ]) {
      expect(
        finalize(payments({ ...stated, payment_evidence: evidence(clause) }))
          .summary.payments.payment_citation,
      ).toMatchObject({ status: "verified", quote: clause });
    }
  });

  it.each([
    ["a paraphrase", evidence("The Customer pays 500 EUR monthly.")],
    ["a quotation from the wrong segment", evidence(clause, "section-2")],
    ["a duplicated quotation", evidence("Services")],
    ["no evidence", null],
  ])("stores null and keeps the payment values for %s", (_label, proposed) => {
    const stored = finalize(payments({ payment_evidence: proposed }));
    expect(stored.summary.payments).toEqual({
      amount: "500 EUR",
      frequency: "Monthly",
      fees: [],
      payment_citation: null,
    });
    expect(citationForReport(stored, id, PAYMENT_CITATION)).toBeNull();
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
      parse(strict(payments({ payment_citation: forged }))).summary.payments
        .payment_citation,
    ).toEqual(forged);
    // Without evidence the forged citation is discarded.
    expect(
      finalize(payments({ payment_citation: forged })).summary.payments
        .payment_citation,
    ).toBeNull();
    // With evidence the server's own match replaces it.
    const replaced = finalize(
      payments({ payment_citation: forged, payment_evidence: evidence(clause) }),
    ).summary.payments.payment_citation;
    expect(replaced).toMatchObject({ quote: clause });
    expect(replaced).not.toMatchObject({ start: 3 });
  });

  it("never cites unknown payment, even when a quotation was sent", () => {
    for (const unknown of [
      { amount: null, frequency: null },
      { amount: "Not specified", frequency: "Unknown" },
    ]) {
      const stored = finalize(
        payments({ ...unknown, payment_evidence: evidence(clause) }),
      );
      expect(stored.summary.payments.payment_citation).toBeNull();
      expect(stored.summary.payments).toMatchObject(unknown);
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
    expect(citationForReport(legacy, id, PAYMENT_CITATION)).toBeNull();
  });
});

describe("the merge prompt", () => {
  it("does not show the merge model the sections' payment quotations", () => {
    const text = `${"1. Records. Each party keeps accurate records of its own work under this agreement.\n".repeat(200)}${clause}\n`;
    const segments = contractAnalysisSegments(text);
    expect(segments.length).toBeGreaterThan(1);
    const sections = segments.map((segment) => ({
      segment,
      result: parse(
        strict(
          payments({ payment_evidence: evidence(clause, segment.label) }),
        ),
      ),
    }));
    const prompt = buildMergePrompt(sections, segments.length);
    expect(prompt).toContain('"amount": "500 EUR"');
    expect(prompt).not.toContain("payment_evidence");
    expect(prompt).not.toContain("in advance, for the Services");
  });
});
