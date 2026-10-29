import { describe, expect, it, vi } from "vitest";
import {
  attachAnalysisSources,
  contractSourceRevision,
} from "./analysis-sources";
import {
  citationForReport,
  CONTRACT_ANALYSIS_LIMIT,
  CONTRACT_HEAD_LENGTH,
  CONTRACT_TAIL_LENGTH,
  contractAnalysisSegments,
  MIDDLE_PASSAGE_MAX_LENGTH,
  MIDDLE_SEGMENT_LABELS,
  verifyQuote,
} from "./source-citations";
import { buildAnalysisPrompt, parseStrictJson } from "./analysis";
import type { AnalysisResult } from "./schemas";

const id = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const verify = (text: string, quote: unknown, segment = "full") =>
  verifyQuote({ quote, segment }, contractAnalysisSegments(text));
const report = (evidence: unknown, extra = {}) => ({
  red_flags: [{ type: "Fee", evidence, ...extra }],
});

describe("analysis source receipts", () => {
  it("derives identity, hash, and range on the server and discards forged receipts", () => {
    const result = attachAnalysisSources(
      {
        ...report(
          { quote: "fee", segment: "full" },
          { citation: { status: "verified", start: 999 } },
        ),
        source: { revision: "fake" },
      },
      id.toUpperCase(),
      "A fee applies.",
    );
    expect(result.source).toEqual({
      contract_id: id,
      revision: contractSourceRevision("A fee applies."),
      index_unit: "unicode-code-points",
    });
    expect(citationForReport(result, id, 0)).toEqual({
      ...result.source,
      status: "verified",
      quote: "fee",
      start: 2,
      end: 5,
    });
    expect(result.red_flags[0]).not.toHaveProperty("evidence");
    expect(
      citationForReport(result, "22e3e947-f71f-4ecd-a901-adbf24edbb8a", 0),
    ).toBeNull();
  });
  it("keeps legacy prose readable without backfilling where or trusting a claimed citation", () => {
    const legacy = {
      red_flags: [
        {
          where: "fee",
          explanation: "Fee risk",
          citation: { status: "verified" },
        },
      ],
    };
    expect(citationForReport(legacy, id, 0)).toBeNull();
    expect(attachAnalysisSources(legacy, id, "fee").red_flags[0]).toEqual({
      where: "fee",
      explanation: "Fee risk",
      citation: null,
    });
  });
  it("requires report and citation revision agreement", () => {
    const result = attachAnalysisSources(
      report({ quote: "fee", segment: "full" }),
      id,
      "fee",
    );
    expect(
      citationForReport(
        {
          ...result,
          source: {
            ...result.source,
            revision: contractSourceRevision("changed"),
          },
        },
        id,
        0,
      ),
    ).toBeNull();
  });
  it("hashes exact content, independent of status updates, and does not normalize Unicode or newlines", () => {
    expect(contractSourceRevision("fee")).toBe(contractSourceRevision("fee"));
    expect(contractSourceRevision("é\r\n")).not.toBe(
      contractSourceRevision("e\u0301\n"),
    );
  });
});

describe("exact contract quote matching", () => {
  it.each([
    null,
    {},
    [],
    { quote: 3 },
    { quote: "fee", segment: "project" },
    { quote: "fee", segment: "head" },
    { quote: " ", segment: "full" },
    { quote: "x".repeat(2001), segment: "full" },
  ])("rejects unsupported evidence %j", (proposal) => {
    expect(verifyQuote(proposal, contractAnalysisSegments("fee"))).toBeNull();
  });
  it("uses Unicode code points for emoji, combining marks, and non-Latin text", () => {
    const text = "😀e\u0301 東京 — fee 💸\r\n<script>text</script>";
    const match = verify(text, "fee 💸\r\n<script>text</script>");
    expect(match).toEqual({
      quote: "fee 💸\r\n<script>text</script>",
      start: 9,
      end: Array.from(text).length,
    });
    expect(verify(text, "fee 💸\n<script>text</script>")).toBeNull();
    expect(verify("😀", "\ud83d")).toBeNull();
    expect(verify("😀", "\ude00")).toBeNull();
    expect(verify("e\u0301", "é")).toBeNull();
  });
  it("rejects duplicates including overlapping occurrences; longer context disambiguates", () => {
    expect(verify("fee then fee", "fee")).toBeNull();
    expect(verify("aaa", "aa")).toBeNull();
    expect(verify("fee then fee", "then fee")).toEqual({
      quote: "then fee",
      start: 4,
      end: 12,
    });
  });
  it("accepts only a continuous span within the supplied head or tail and disambiguates across segments", () => {
    const text =
      "fee " +
      "h".repeat(CONTRACT_HEAD_LENGTH - 4) +
      "OMITTED ONLY" +
      "m".repeat(6000) +
      "t".repeat(CONTRACT_TAIL_LENGTH - 4) +
      " fee";
    const segments = contractAnalysisSegments(text);
    expect(segments.map((p) => p.end - p.start)).toEqual([
      CONTRACT_HEAD_LENGTH,
      CONTRACT_TAIL_LENGTH,
    ]);
    expect(verify(text, "fee", "head")?.start).toBe(0);
    expect(verify(text, "fee", "tail")?.start).toBe(
      Array.from(text).length - 3,
    );
    expect(verify(text, "OMITTED ONLY", "head")).toBeNull();
    expect(verify(text, "OMITTED ONLY", "tail")).toBeNull();
    expect(verify(text, "hhhttt", "head")).toBeNull();
    expect(
      verify(text, "characters omitted from the middle", "tail"),
    ).toBeNull();
    expect(verify(text, "fee", "full")).toBeNull();
  });
  it("rejects quotes crossing an omitted gap even when only one code point was omitted", () => {
    // The capped renewal passage ends at "A"; its one-code-point remainder "G" scores nothing.
    const text =
      "h".repeat(CONTRACT_HEAD_LENGTH) +
      "x".repeat(3000) +
      "\n\nrenewal " +
      "m".repeat(MIDDLE_PASSAGE_MAX_LENGTH - 9) +
      "A" +
      "G" +
      "B" +
      "t".repeat(CONTRACT_TAIL_LENGTH - 1);
    const segments = contractAnalysisSegments(text);
    expect(segments.map((part) => part.label)).toEqual([
      "head",
      "middle-1",
      "tail",
    ]);
    expect(segments[2]!.start - segments[1]!.end).toBe(1);
    expect(verify(text, "A", "middle-1")?.end).toBe(segments[1]!.end);
    for (const label of ["head", "middle-1", "tail"])
      expect(verify(text, "AGB", label)).toBeNull();
    expect(contractAnalysisSegments("😀".repeat(15000))).toHaveLength(1);
  });
  it("preserves code point offsets when truncation straddles emoji", () => {
    const text = "😀".repeat(16000) + "TAIL";
    const parts = contractAnalysisSegments(text);
    expect(Array.from(parts[0]!.text)).toHaveLength(CONTRACT_HEAD_LENGTH);
    expect(verify(text, "TAIL", "tail")).toEqual({
      quote: "TAIL",
      start: 16000,
      end: 16004,
    });
  });
  it("never searches project context for a contract quotation", () => {
    const { prompt } = buildAnalysisPrompt("contract only", undefined, [
      { title: "policy", text: "context only" },
    ]);
    expect(prompt).toContain('"evidence":');
    expect(prompt).toContain("Contract segment: full");
    expect(verify("contract only", "context only")).toBeNull();
  });
  it.each(["strict", "partial", "normalized"])(
    "keeps usable reports and evidence through %s parsing",
    (mode) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const base = {
          risk_badge: mode === "normalized" ? "low" : "LOW",
          key_points: ["Fee applies"],
          summary: {
            renewal: { auto_renew: null },
            cancellation: { how: "Email", notice_period_days: null },
          },
          red_flags: [
            {
              type: "Fee",
              explanation: "Fee risk",
              where: null,
              confidence: null,
              severity: null,
              evidence: { quote: "fee", segment: "full" },
            },
          ],
        };
        const payload =
          mode === "strict"
            ? {
                ...base,
                summary: {
                  ...base.summary,
                  what_it_is: "Contract",
                  payments: { amount: null, frequency: null, fees: [] },
                  term: { start: null, end: null, minimum_term: null },
                  renewal: { auto_renew: null, renewal_period: null },
                  cancellation: { ...base.summary.cancellation, penalties: [] },
                },
                normal_in_region: [],
                next_actions: { questions_to_ask: [], email_templates: [] },
                key_dates: [],
                obligations: [],
                parties: [],
                disclaimer: "Not legal advice",
              }
            : base;
        const result = parseStrictJson<AnalysisResult>(JSON.stringify(payload));
        expect(result.red_flags[0]?.evidence?.quote).toBe("fee");
        payload.red_flags[0]!.evidence = {
          quote: 3,
          segment: "project",
        } as never;
        expect(
          parseStrictJson<AnalysisResult>(JSON.stringify(payload)).red_flags[0]
            ?.evidence,
        ).toBeNull();
      } finally {
        warn.mockRestore();
      }
    },
  );
});

// Numbered boilerplate clauses of about 100 code points, without any selection keyword. The emoji
// make code point and UTF-16 offsets differ.
const boilerplate = (number: number) =>
  `${number}. Records. Each party will keep accurate records of its own work under this section 😀.\n`;
const RENEWAL_CLAUSE =
  "9.2 Renewal. This Agreement renews automatically for one (1) year unless either party gives sixty (60) days' written notice of non-renewal.\n";
const longContract = (middle: string) =>
  [
    ...Array.from({ length: 100 }, (_, index) => boilerplate(index + 1)),
    middle,
    ...Array.from({ length: 100 }, (_, index) => boilerplate(index + 400)),
  ].join("");

describe("contract analysis segments", () => {
  it("sends a contract at or under the limit as one full segment", () => {
    const text = "😀".repeat(CONTRACT_ANALYSIS_LIMIT - 4) + "fee.";
    expect(contractAnalysisSegments(text)).toEqual([
      { label: "full", start: 0, end: CONTRACT_ANALYSIS_LIMIT, text },
    ]);
  });

  it("sends disjoint, ordered segments within the budget, at exact code point offsets", () => {
    const text = longContract(
      [
        boilerplate(300),
        RENEWAL_CLAUSE,
        boilerplate(301),
        "12.3 Liability. Each party's liability for late payment interest is capped at the fees paid.\n",
        boilerplate(302),
      ].join(""),
    );
    const chars = Array.from(text);
    expect(chars.length).toBeGreaterThan(CONTRACT_ANALYSIS_LIMIT);
    const segments = contractAnalysisSegments(text);

    expect(segments.map((part) => part.label)).toEqual([
      "head",
      "middle-1",
      "middle-2",
      "tail",
    ]);
    expect(segments[0]!.start).toBe(0);
    expect(segments.at(-1)!.end).toBe(chars.length);
    for (const [index, part] of segments.entries()) {
      expect(chars.slice(part.start, part.end).join("")).toBe(part.text);
      if (index > 0)
        expect(part.start).toBeGreaterThanOrEqual(segments[index - 1]!.end);
    }
    expect(
      segments.reduce((sum, part) => sum + part.end - part.start, 0),
    ).toBeLessThanOrEqual(CONTRACT_ANALYSIS_LIMIT);
    expect(segments[1]!.text).toBe(RENEWAL_CLAUSE);
    expect(contractAnalysisSegments(text)).toEqual(segments);
  });

  it("selects a renewal or notice clause ahead of keyword-free boilerplate", () => {
    const text = longContract(
      [
        ...Array.from({ length: 30 }, (_, index) => boilerplate(index + 200)),
        RENEWAL_CLAUSE,
        ...Array.from({ length: 30 }, (_, index) => boilerplate(index + 230)),
      ].join(""),
    );
    const middle = contractAnalysisSegments(text).filter((part) =>
      part.label.startsWith("middle-"),
    );
    expect(middle.map((part) => part.text)).toEqual([RENEWAL_CLAUSE]);
    expect(verify(text, "renews automatically", "middle-1")).toEqual({
      quote: "renews automatically",
      start: Array.from(text.slice(0, text.indexOf("renews automatically")))
        .length,
      end:
        Array.from(text.slice(0, text.indexOf("renews automatically"))).length +
        "renews automatically".length,
    });
  });

  it("joins a section heading to its first clause and caps long passages", () => {
    const longClause = `9.3 Notice. ${"Notices go to the addresses above. ".repeat(60)}\n`;
    const text = longContract(
      `\n9. TERM AND RENEWAL\n\n${RENEWAL_CLAUSE}${boilerplate(300)}${longClause}${boilerplate(301)}`,
    );
    const middle = contractAnalysisSegments(text).filter((part) =>
      part.label.startsWith("middle-"),
    );
    expect(middle[0]!.text).toBe(`9. TERM AND RENEWAL\n\n${RENEWAL_CLAUSE}`);
    for (const part of middle)
      expect(part.end - part.start).toBeLessThanOrEqual(
        MIDDLE_PASSAGE_MAX_LENGTH,
      );
    expect(middle[1]!.text.startsWith("9.3 Notice. ")).toBe(true);
    // Cut after a space, never inside a word.
    expect(middle[1]!.text.endsWith(" ")).toBe(true);
  });

  it("starts unnumbered passages after blank lines, including CRLF ones", () => {
    const paragraph =
      "Renewal. This agreement renews automatically each year, unless notice is given in writing.\r\n";
    const text = longContract(
      `\r\n${paragraph}\r\nRecords are kept for seven years by each party at its own offices, in good order.\r\n`,
    );
    const middle = contractAnalysisSegments(text).filter((part) =>
      part.label.startsWith("middle-"),
    );
    expect(middle.map((part) => part.text)).toEqual([`${paragraph}\r\n`]);
  });

  it("breaks score ties in favour of the earlier passage and caps the passage count", () => {
    const clause = (number: number) =>
      `${number}.1 Fees. ${"Fees are payable as stated. ".repeat(30)}\n`;
    const text = longContract(
      Array.from({ length: 4 }, (_, index) => clause(index + 100)).join(""),
    );
    const middle = contractAnalysisSegments(text).filter((part) =>
      part.label.startsWith("middle-"),
    );
    // Each clause is about 870 code points, so only the first two fit the middle budget.
    expect(middle.map((part) => part.text)).toEqual([clause(100), clause(101)]);

    const short = (number: number) =>
      `${number}.1 Fees. The fees are listed in the order form for this site, as agreed by both parties.\n`;
    const many = longContract(
      Array.from({ length: 10 }, (_, index) => short(index + 100)).join(""),
    );
    const selected = contractAnalysisSegments(many).filter((part) =>
      part.label.startsWith("middle-"),
    );
    expect(selected.map((part) => part.label)).toEqual([
      ...MIDDLE_SEGMENT_LABELS,
    ]);
    expect(selected.map((part) => part.text)).toEqual(
      [100, 101, 102, 103].map(short),
    );
  });

  it("verifies middle quotes to whole-document offsets and keeps matching exact", () => {
    const notice =
      "9.3 Notice. Notice of non-renewal is due sixty (60) days before renewal, and the notice must be signed.\n";
    const text = longContract(`${RENEWAL_CLAUSE}${notice}`);
    const segments = contractAnalysisSegments(text);
    expect(segments.map((part) => part.label)).toEqual([
      "head",
      "middle-1",
      "middle-2",
      "tail",
    ]);
    expect(segments[1]!.end).toBe(segments[2]!.start);
    const quote = "sixty (60) days before renewal";
    const start = Array.from(text.slice(0, text.indexOf(quote))).length;
    expect(verify(text, quote, "middle-2")).toEqual({
      quote,
      start,
      end: start + quote.length,
    });
    expect(
      Array.from(text)
        .slice(start, start + quote.length)
        .join(""),
    ).toBe(quote);
    expect(verify(text, quote, "middle-1")).toBeNull();
    expect(verify(text, quote, "middle-99")).toBeNull();
    expect(verify(text, quote, "middle-3")).toBeNull();
    // Adjacent segments are still separate: a quote may not run from one into the next.
    expect(verify(text, "non-renewal.\n9.3 Notice.", "middle-1")).toBeNull();
    expect(verify(text, "non-renewal.\n9.3 Notice.", "middle-2")).toBeNull();
    expect(verify(text, "Notice", "middle-2")).toBeNull();
  });
});
