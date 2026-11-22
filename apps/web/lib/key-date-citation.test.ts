import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  citeKeyDates,
  isKeyDateCitationRef,
  keyDateCitation,
  keyDateCitationIndex,
  keyDateCitationRef,
  namesKeyDate,
} from "./key-date-citations";
import { isListedCitationRef } from "./listed-citations";
import {
  AnalysisResultSchema,
  PartialAnalysisResultSchema,
  type AnalysisResult,
} from "./schemas";
import {
  citationForReport,
  contractAnalysisSegments,
} from "./source-citations";
import {
  completed,
  contractOf,
  failure,
  mergeOutput,
  provider,
  sectionOutput,
} from "./fixtures/analysis-provider";

const id = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const renewal = { type: "RENEWAL", date: "2027-01-01" } as const;
const renewalClause =
  "This agreement renews automatically on 1 January 2027 for another year.";
const review = { type: "PRICE_REVIEW", date: "1 April each year" } as const;
const reviewClause = "The Provider may review the fees once a year, on 1 April.";
const cutoff = { type: "NOTICE_CUTOFF", date: "2026-11-02" } as const;
const cutoffClause =
  "Either party may stop renewal by giving 60 days' notice before the renewal date.";
// The emoji makes code point and UTF-16 offsets differ; "the fees" appears more than once.
const contract = {
  id,
  text: `1. Term 😀. ${renewalClause}\n\n2. Fees. ${reviewClause} Invoices list the fees.\n3. Notice. ${cutoffClause}\n`,
};
const dated = (keyDate: { type: string; date: string }, derived_from: string | null = null) => ({
  ...keyDate,
  derived_from,
});
const proposal = (
  keyDate: { type: string; date: string },
  quote: string,
  segment = "full",
) => ({ ...keyDate, quote, segment });

const strict = (extra: Record<string, unknown> = {}) => ({
  risk_badge: "LOW",
  key_points: ["The agreement renews each January."],
  summary: {
    what_it_is: "A services agreement",
    payments: { amount: null, frequency: null, fees: [] },
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
  key_dates: [dated(renewal, "The renewal clause")],
  obligations: [],
  parties: [],
  disclaimer: "This is an AI analysis, not legal advice.",
  ...extra,
});

function parse(payload: Record<string, unknown>) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    return parseStrictJson<AnalysisResult>(JSON.stringify(payload));
  } finally {
    warn.mockRestore();
  }
}

function finalize(extra: Record<string, unknown>) {
  return finalizeAnalysisResult(parse(strict(extra)), contract);
}

const offsetsOf = (quote: string) => {
  const start = Array.from(
    contract.text.slice(0, contract.text.indexOf(quote)),
  ).length;
  return { start, end: start + Array.from(quote).length };
};

describe("key date citation references", () => {
  it("name a key date by its index, separately from the cited lists", () => {
    expect(keyDateCitationRef(2)).toBe("key-date-2");
    expect(keyDateCitationIndex("key-date-2")).toBe(2);
    expect(isKeyDateCitationRef("key-date-0")).toBe(true);
    expect(isListedCitationRef("key-date-0")).toBe(false);
    for (const other of [
      "key-date-",
      "key-date-1000",
      "key-date--1",
      "key-dates-0",
      "Key-date-0",
      "keydate-0",
      "obligation-0",
      "2",
      2,
      null,
    ]) {
      expect(keyDateCitationIndex(other)).toBeNull();
      expect(isKeyDateCitationRef(other)).toBe(false);
    }
  });

  it("match a key date by its exact type and date only", () => {
    expect(namesKeyDate(proposal(renewal, renewalClause), dated(renewal))).toBe(true);
    expect(namesKeyDate({ ...renewal, type: "renewal" }, renewal)).toBe(false);
    expect(namesKeyDate({ ...renewal, date: " 2027-01-01" }, renewal)).toBe(false);
    expect(namesKeyDate({ ...renewal, type: "OTHER" }, renewal)).toBe(false);
    expect(namesKeyDate({ type: "RENEWAL" }, renewal)).toBe(false);
    expect(namesKeyDate(renewal, null)).toBe(false);
    expect(namesKeyDate(null, renewal)).toBe(false);
  });

  it("look up a stored citation by the key date's exact type and date", () => {
    const stored = {
      key_date_citations: [{ ...renewal, citation: { quote: "x" } }],
    };
    expect(keyDateCitation(stored, dated(renewal))).toEqual({ quote: "x" });
    expect(keyDateCitation(stored, { ...renewal, type: "OTHER" })).toBeNull();
    expect(keyDateCitation(stored, { ...renewal, date: "2027-01-02" })).toBeNull();
    expect(keyDateCitation({}, renewal)).toBeNull();
    expect(keyDateCitation(null, renewal)).toBeNull();
    expect(keyDateCitation(stored, "2027-01-01")).toBeNull();
  });

  it("cite each distinct listed date once, with the first proposal that verifies", () => {
    const verify = (entry: Record<string, unknown>) =>
      entry.quote === "good" ? `verified ${String(entry.date)}` : null;
    expect(
      citeKeyDates(
        [dated(renewal), dated(renewal), dated(review), "2027", null],
        [
          proposal(renewal, "bad"),
          proposal(renewal, "good"),
          proposal(cutoff, "good"),
          "good",
        ],
        verify,
      ),
    ).toEqual([{ ...renewal, citation: "verified 2027-01-01" }]);
    expect(citeKeyDates(undefined, undefined, verify)).toEqual([]);
  });
});

describe("key_date_evidence in analysis output", () => {
  const offered = [proposal(renewal, renewalClause)];

  it.each([
    ["strict", strict({ key_date_evidence: offered })],
    [
      "partial",
      {
        risk_badge: "LOW",
        key_points: ["Renews each January."],
        summary: {
          renewal: { auto_renew: null },
          cancellation: { how: "In writing", notice_period_days: null },
        },
        key_dates: [renewal],
        key_date_evidence: offered,
      },
    ],
    [
      "normalized",
      {
        ...strict(),
        risk_badge: "low",
        key_dates: [{ kind: "Renewal", when: renewal.date }],
        keyDateEvidence: offered,
      },
    ],
  ])("survives %s parsing with the key dates", (_path, payload) => {
    expect(parse(payload)).toMatchObject({
      key_dates: [expect.objectContaining(renewal)],
      key_date_evidence: offered,
    });
  });

  it("drops malformed entries one by one instead of rejecting the analysis", () => {
    const parsed = parse(
      strict({
        key_date_evidence: [
          "clause",
          { quote: renewalClause, segment: "full" },
          proposal({ type: "RENEWAL", date: "" }, renewalClause),
          proposal({ type: "renewal", date: renewal.date }, renewalClause),
          proposal(renewal, ""),
          proposal(renewal, renewalClause, "tail"),
          { obligation: renewal.date, quote: renewalClause, segment: "full" },
          7,
          proposal(renewal, renewalClause),
        ],
        key_date_citations: [{ ...renewal, citation: "forged" }, null],
      }),
    );
    expect(parsed.key_date_evidence).toEqual([proposal(renewal, renewalClause)]);
    expect(parsed.key_date_citations).toEqual([]);
    expect(parsed.key_dates).toEqual([dated(renewal, "The renewal clause")]);
  });

  it("drops a malformed list whole", () => {
    for (const malformed of ["clause", renewal, 7]) {
      const parsed = parse(
        strict({ key_date_evidence: malformed, key_date_citations: malformed }),
      );
      expect(parsed.key_date_evidence ?? []).toEqual([]);
      expect(parsed.key_date_citations ?? []).toEqual([]);
      expect(parsed.key_dates).toEqual([dated(renewal, "The renewal clause")]);
    }
  });

  it("keeps reports stored before the fields valid", () => {
    expect(AnalysisResultSchema.safeParse(strict()).success).toBe(true);
    expect(
      PartialAnalysisResultSchema.safeParse({
        risk_badge: "LOW",
        key_points: ["Renews."],
        summary: {
          renewal: { auto_renew: true },
          cancellation: { how: "Not specified", notice_period_days: null },
        },
        key_dates: [renewal],
      }).success,
    ).toBe(true);
  });

  it("asks for one quotation per listed key date, repeating its type and date exactly", () => {
    const { prompt } = buildAnalysisPrompt("Contract body");
    expect(prompt).toContain(
      'For each entry in "key_dates", add one entry to "key_date_evidence": its "type" and "date" repeat that key date\'s "type" and "date" exactly',
    );
    expect(prompt).toContain(
      'When no key dates are listed, "key_date_evidence" is an empty array.',
    );
    expect(prompt).toContain('"key_date_evidence": [{ "type":');
  });
});

describe("finalizing key date quotations", () => {
  it("stores a verified citation keyed by the date's type and date, with offsets and revision", () => {
    const stored = finalize({ key_date_evidence: [proposal(renewal, renewalClause)] });
    expect(stored.key_dates).toEqual([dated(renewal, "The renewal clause")]);
    expect(stored.key_date_citations).toEqual([
      {
        ...renewal,
        citation: {
          contract_id: id,
          revision: contractSourceRevision(contract.text),
          index_unit: "unicode-code-points",
          status: "verified",
          quote: renewalClause,
          ...offsetsOf(renewalClause),
        },
      },
    ]);
    expect(stored).not.toHaveProperty("key_date_evidence");
    const { start, end } = offsetsOf(renewalClause);
    expect(Array.from(contract.text).slice(start, end).join("")).toBe(renewalClause);
    expect(citationForReport(stored, id, "key-date-0")).toEqual(
      stored.key_date_citations![0]!.citation,
    );
    // Other citations are looked up separately.
    expect(citationForReport(stored, id, "key-date-1")).toBeNull();
    expect(citationForReport(stored, id, "obligation-0")).toBeNull();
    expect(citationForReport(stored, id, "renewal")).toBeNull();
    expect(citationForReport(stored, id, 0)).toBeNull();
    expect(
      citationForReport(stored, "22e3e947-f71f-4ecd-a901-adbf24edbb8a", "key-date-0"),
    ).toBeNull();
  });

  it.each([
    ["a paraphrase", [proposal(renewal, "The agreement renews on 1 January 2027.")]],
    ["a quotation from the wrong segment", [proposal(renewal, renewalClause, "section-2")]],
    ["a duplicated quotation", [proposal(renewal, "the fees")]],
    ["no evidence", []],
  ])("stores no entry and keeps the key date for %s", (_label, proposed) => {
    const stored = finalize({ key_date_evidence: proposed });
    expect(stored.key_dates).toEqual([dated(renewal, "The renewal clause")]);
    expect(stored.key_date_citations).toEqual([]);
    expect(stored).not.toHaveProperty("key_date_evidence");
    expect(citationForReport(stored, id, "key-date-0")).toBeNull();
  });

  it("takes the first verifiable proposal for a key date", () => {
    const stored = finalize({
      key_date_evidence: [
        proposal(renewal, "the fees"),
        proposal(renewal, renewalClause),
        proposal(renewal, reviewClause),
      ],
    });
    expect(citationForReport(stored, id, "key-date-0")?.quote).toBe(renewalClause);
  });

  it("discards a proposal whose type or date does not exactly match a listed key date", () => {
    for (const named of [
      { ...renewal, type: "OTHER" },
      { ...renewal, date: "1 January 2027" },
      { ...renewal, date: "2027-01-01 " },
      review,
    ]) {
      const stored = finalize({ key_date_evidence: [proposal(named, renewalClause)] });
      expect(stored.key_date_citations).toEqual([]);
      expect(stored.key_dates).toEqual([dated(renewal, "The renewal clause")]);
    }
  });

  it("stores nothing when no key dates are listed, even with proposals", () => {
    const stored = finalize({
      key_dates: [],
      key_date_evidence: [proposal(renewal, renewalClause)],
    });
    expect(stored.key_date_citations).toEqual([]);
    expect(citationForReport(stored, id, "key-date-0")).toBeNull();
  });

  it("never shows one date's quotation beside another of the same type", () => {
    const later = { type: "RENEWAL", date: "2028-01-01" } as const;
    const stored = finalize({
      key_dates: [dated(renewal), dated(later)],
      key_date_evidence: [proposal(renewal, renewalClause)],
    });
    expect(citationForReport(stored, id, "key-date-0")?.quote).toBe(renewalClause);
    expect(citationForReport(stored, id, "key-date-1")).toBeNull();

    // Listed in the other order, so nothing depends on position.
    const swapped = finalize({
      key_dates: [dated(later), dated(renewal)],
      key_date_evidence: [proposal(renewal, renewalClause)],
    });
    expect(citationForReport(swapped, id, "key-date-0")).toBeNull();
    expect(citationForReport(swapped, id, "key-date-1")?.quote).toBe(renewalClause);
  });

  it("never shows one date's quotation beside the same date of another type", () => {
    const sameDay = { type: "NOTICE_CUTOFF", date: renewal.date } as const;
    const stored = finalize({
      key_dates: [dated(sameDay), dated(renewal)],
      key_date_evidence: [proposal(renewal, renewalClause)],
    });
    expect(citationForReport(stored, id, "key-date-0")).toBeNull();
    expect(citationForReport(stored, id, "key-date-1")?.quote).toBe(renewalClause);

    const both = finalize({
      key_dates: [dated(sameDay), dated(renewal)],
      key_date_evidence: [
        proposal(renewal, renewalClause),
        proposal(sameDay, cutoffClause),
      ],
    });
    expect(citationForReport(both, id, "key-date-0")).toMatchObject({
      quote: cutoffClause,
      ...offsetsOf(cutoffClause),
    });
    expect(citationForReport(both, id, "key-date-1")).toMatchObject({
      quote: renewalClause,
      ...offsetsOf(renewalClause),
    });
  });

  it("cites a date listed twice once, and shows it beside both", () => {
    const stored = finalize({
      key_dates: [dated(renewal), dated(renewal, "Again")],
      key_date_evidence: [proposal(renewal, renewalClause)],
    });
    expect(stored.key_date_citations).toHaveLength(1);
    expect(citationForReport(stored, id, "key-date-0")?.quote).toBe(renewalClause);
    expect(citationForReport(stored, id, "key-date-1")?.quote).toBe(renewalClause);
  });

  it("never stores a model-supplied citation as-is", () => {
    const forged = {
      ...renewal,
      citation: {
        contract_id: id,
        revision: contractSourceRevision(contract.text),
        index_unit: "unicode-code-points",
        status: "verified",
        quote: "Term",
        start: 3,
        end: 7,
      },
    };
    // The forged citation passes the schema, so parsing keeps it for the server to discard.
    expect(parse(strict({ key_date_citations: [forged] })).key_date_citations).toEqual([
      forged,
    ]);
    // Without evidence the forged citation is discarded.
    expect(finalize({ key_date_citations: [forged] }).key_date_citations).toEqual([]);
    // With evidence the server's own match replaces it.
    const replaced = finalize({
      key_date_citations: [forged],
      key_date_evidence: [proposal(renewal, renewalClause)],
    }).key_date_citations;
    expect(replaced).toHaveLength(1);
    expect(replaced![0]!.citation).toMatchObject({ quote: renewalClause });
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
    expect(citationForReport(legacy, id, "key-date-0")).toBeNull();
  });

  it("leaves the cited lists' citations as they were", () => {
    const stored = finalize({
      obligations: ["Review the fees yearly"],
      obligation_evidence: [
        { obligation: "Review the fees yearly", quote: reviewClause, segment: "full" },
      ],
      key_dates: [dated(review)],
      key_date_evidence: [proposal(review, reviewClause)],
    });
    expect(citationForReport(stored, id, "obligation-0")?.quote).toBe(reviewClause);
    expect(citationForReport(stored, id, "key-date-0")?.quote).toBe(reviewClause);
    expect(stored.obligation_citations).toHaveLength(1);
    expect(stored.key_date_citations).toEqual([
      { ...review, citation: expect.objectContaining({ quote: reviewClause }) },
    ]);
  });

  it("creates nothing but citations from key dates: no deadlines, reminders or calendar entries", () => {
    const stored = finalize({ key_date_evidence: [proposal(renewal, renewalClause)] });
    expect(stored.key_dates).toEqual([dated(renewal, "The renewal clause")]);
    expect(
      Object.keys(stored).filter((key) => key.startsWith("key_date")),
    ).toEqual(["key_dates", "key_date_citations"]);
    expect(JSON.stringify(stored)).not.toMatch(/deadline|reminder|calendar|\.ics/i);
  });
});

describe("key date quotations in long contracts", () => {
  const CONTRACT_ID = id;
  const quote = renewalClause;
  const otherQuote = reviewClause;
  const text = contractOf(400, {
    200: `200.1 Term. ${quote}\n`,
    380: `380.1 Fees. ${otherQuote}\n`,
  });
  const segments = contractAnalysisSegments(text);
  const sectionOf = (wanted: string) =>
    Number(
      segments
        .find((part) => part.text.includes(wanted))!
        .label.slice("section-".length),
    );
  const renewalSection = sectionOf(quote);
  const reviewSection = sectionOf(otherQuote);
  type Dates = {
    keyDates?: { type: string; date: string }[];
    keyDateQuotes?: { type: string; date: string; quote: string }[];
  };
  const quoting: Record<number, Dates> = {
    [renewalSection]: {
      keyDates: [renewal],
      keyDateQuotes: [{ ...renewal, quote }],
    },
    [reviewSection]: {
      keyDates: [review],
      keyDateQuotes: [{ ...review, quote: otherQuote }],
    },
  };

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

  // Each section's key dates come from `bySection`, falling back to the two quoting sections.
  async function analyse(
    merge: "fails" | Record<string, unknown>,
    bySection: Record<number, Dates> = {},
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
      double,
      stored: finalizeAnalysisResult(answer.result, { id: CONTRACT_ID, text }),
    };
  }

  const citedQuotes = (stored: { key_date_citations?: unknown }) =>
    (
      stored.key_date_citations as {
        type: string;
        date: string;
        citation: { quote: string };
      }[]
    ).map(({ type, date, citation }) => [type, date, citation.quote]);

  it("quotes each key date from the section listing it when the merge call fails", async () => {
    expect(renewalSection).toBeGreaterThan(1);
    expect(reviewSection).toBeGreaterThan(renewalSection);
    const { answer, stored } = await analyse("fails");
    expect(answer.result.key_dates).toEqual([dated(renewal), dated(review)]);
    expect(answer.result.key_date_evidence).toEqual([
      { ...renewal, quote, segment: `section-${renewalSection}` },
      { ...review, quote: otherQuote, segment: `section-${reviewSection}` },
    ]);
    expect(citedQuotes(stored)).toEqual([
      [renewal.type, renewal.date, quote],
      [review.type, review.date, otherQuote],
    ]);
    const start = text.indexOf(otherQuote);
    expect(citationForReport(stored, CONTRACT_ID, "key-date-1")).toMatchObject({
      status: "verified",
      quote: otherQuote,
      start: Array.from(text.slice(0, start)).length,
    });
    expect(citationForReport(stored, CONTRACT_ID, "key-date-0")?.quote).toBe(quote);
  });

  it("skips a section whose quotation is not in its own segment and uses a later one listing the same date", async () => {
    const { answer } = await analyse("fails", {
      1: { keyDates: [renewal], keyDateQuotes: [{ ...renewal, quote }] },
    });
    expect(answer.result.key_date_evidence).toContainEqual({
      ...renewal,
      quote,
      segment: `section-${renewalSection}`,
    });
  });

  it("never borrows a quotation from a section that does not list exactly that date", async () => {
    const { answer, stored } = await analyse("fails", {
      1: { keyDates: [review] },
      // This section quotes the review date but lists another date of the same type.
      [reviewSection]: {
        keyDates: [{ ...review, date: "1 May each year" }],
        keyDateQuotes: [{ ...review, quote: otherQuote }],
      },
    });
    expect(answer.result.key_dates).toEqual([
      dated(review),
      dated(renewal),
      dated({ ...review, date: "1 May each year" }),
    ]);
    expect(citedQuotes(stored)).toEqual([[renewal.type, renewal.date, quote]]);
    expect(citationForReport(stored, CONTRACT_ID, "key-date-0")).toBeNull();
    expect(citationForReport(stored, CONTRACT_ID, "key-date-2")).toBeNull();
  });

  it("has no quotation for a date an earlier section listed as another type", async () => {
    const other = { ...renewal, type: "OTHER" } as const;
    const { answer, stored } = await analyse("fails", {
      1: { keyDates: [other] },
    });
    expect(answer.result.key_dates).toEqual([
      dated(other),
      dated(renewal),
      dated(review),
    ]);
    expect(citationForReport(stored, CONTRACT_ID, "key-date-0")).toBeNull();
    expect(citationForReport(stored, CONTRACT_ID, "key-date-1")?.quote).toBe(quote);
    expect(citationForReport(stored, CONTRACT_ID, "key-date-2")?.quote).toBe(otherQuote);
  });

  it("keeps the sections' quotations for the merge model's key dates, never its own", async () => {
    const { answer, stored, double } = await analyse({
      key_dates: [dated(review, "Fees clause"), dated(renewal)],
      key_date_evidence: [{ ...review, quote: "Records. Each party", segment: "section-1" }],
      key_date_citations: [
        { ...review, citation: { status: "verified", quote: "Records", start: 0, end: 7 } },
      ],
    });
    expect(answer.result.key_date_evidence).toEqual([
      { ...review, quote: otherQuote, segment: `section-${reviewSection}` },
      { ...renewal, quote, segment: `section-${renewalSection}` },
    ]);
    expect(answer.result).not.toHaveProperty("key_date_citations");
    expect(citedQuotes(stored)).toEqual([
      [review.type, review.date, otherQuote],
      [renewal.type, renewal.date, quote],
    ]);
    // The merge model never sees the sections' quotations.
    const mergeInput = double.mergeCalls()[0]!.input;
    expect(mergeInput).toContain(renewal.date);
    expect(mergeInput).not.toContain("key_date_evidence");
    expect(mergeInput).not.toContain("renews automatically on 1 January 2027");
  });

  it("has no quotation for a key date the merge model reworded or recalculated", async () => {
    const recalculated = { type: "NOTICE_CUTOFF", date: "2026-11-02" } as const;
    const reworded = { ...renewal, date: "1 January 2027" } as const;
    const { answer, stored } = await analyse({
      key_dates: [dated(recalculated), dated(reworded), dated(review)],
    });
    expect(answer.result.key_dates).toEqual([
      dated(recalculated),
      dated(reworded),
      dated(review),
    ]);
    expect(citedQuotes(stored)).toEqual([[review.type, review.date, otherQuote]]);
    expect(citationForReport(stored, CONTRACT_ID, "key-date-0")).toBeNull();
    expect(citationForReport(stored, CONTRACT_ID, "key-date-1")).toBeNull();
    expect(citationForReport(stored, CONTRACT_ID, "key-date-2")?.quote).toBe(otherQuote);
  });

  it("stores no key date quotations when no key dates are merged", async () => {
    const { answer, stored } = await analyse({ key_dates: [] });
    expect(answer.result.key_date_evidence).toEqual([]);
    expect(stored.key_date_citations).toEqual([]);
  });
});

describe("the merge prompt", () => {
  it("does not show the merge model the sections' key date quotations", () => {
    const text = `${"1. Records. Each party keeps accurate records of its own work under this agreement.\n".repeat(200)}${renewalClause}\n`;
    const segments = contractAnalysisSegments(text);
    expect(segments.length).toBeGreaterThan(1);
    const sections = segments.map((segment) => ({
      segment,
      result: parse(
        strict({ key_date_evidence: [proposal(renewal, renewalClause, segment.label)] }),
      ),
    }));
    const prompt = buildMergePrompt(sections, segments.length);
    expect(prompt).toContain(renewal.date);
    expect(prompt).not.toContain("key_date_evidence");
    expect(prompt).not.toContain("key_date_citations");
    expect(prompt).not.toContain("renews automatically on 1 January 2027");
  });
});
