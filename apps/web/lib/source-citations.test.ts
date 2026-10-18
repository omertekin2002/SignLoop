import { describe, expect, it, vi } from "vitest";
import {
  attachAnalysisSources,
  contractSourceRevision,
} from "./analysis-sources";
import {
  citationForReport,
  contractAnalysisSegments,
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
      "h".repeat(9746) +
      "OMITTED ONLY" +
      "m".repeat(6000) +
      "t".repeat(5246) +
      " fee";
    const segments = contractAnalysisSegments(text);
    expect(segments.map((p) => p.end - p.start)).toEqual([9750, 5250]);
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
    const text = "h".repeat(9749) + "A" + "G" + "B" + "t".repeat(5249);
    expect(contractAnalysisSegments(text)).toHaveLength(2);
    expect(verify(text, "AGB", "head")).toBeNull();
    expect(verify(text, "AGB", "tail")).toBeNull();
    expect(contractAnalysisSegments("😀".repeat(15000))).toHaveLength(1);
  });
  it("preserves code point offsets when truncation straddles emoji", () => {
    const text = "😀".repeat(16000) + "TAIL";
    const parts = contractAnalysisSegments(text);
    expect(Array.from(parts[0]!.text)).toHaveLength(9750);
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
