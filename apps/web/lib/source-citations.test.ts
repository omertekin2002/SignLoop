import { describe, expect, it, vi } from "vitest";
import {
  attachAnalysisSources,
  contractSourceRevision,
} from "./analysis-sources";
import {
  citationForReport,
  CONTRACT_ANALYSIS_LIMIT,
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
    { quote: "fee", segment: "section-1" },
    { quote: "fee", segment: "section-0" },
    { quote: "fee", segment: "section-01" },
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
  it("accepts only a continuous span within one section and disambiguates across sections", () => {
    const text = "fee " + "x".repeat(CONTRACT_ANALYSIS_LIMIT * 2) + " fee";
    const segments = contractAnalysisSegments(text);
    expect(segments.map((part) => part.label)).toEqual([
      "section-1",
      "section-2",
      "section-3",
    ]);
    expect(verify(text, "fee", "section-1")?.start).toBe(0);
    expect(verify(text, "fee", "section-3")?.start).toBe(
      Array.from(text).length - 3,
    );
    expect(verify(text, "fee", "section-2")).toBeNull();
    expect(verify(text, "fee", "full")).toBeNull();
    // A quotation may not run from one section into the next.
    const boundary = segments[1]!.start;
    const across = Array.from(text)
      .slice(boundary - 3, boundary + 3)
      .join("");
    for (const label of ["section-1", "section-2"])
      expect(verify(text, across, label)).toBeNull();
  });
  it("preserves code point offsets when a section boundary falls among emoji", () => {
    const text = "😀".repeat(16000) + "TAIL";
    const parts = contractAnalysisSegments(text);
    expect(Array.from(parts[0]!.text)).toHaveLength(CONTRACT_ANALYSIS_LIMIT);
    expect(verify(text, "TAIL", "section-2")).toEqual({
      quote: "TAIL",
      start: 16000,
      end: 16004,
    });
    expect(contractAnalysisSegments("😀".repeat(15000))).toHaveLength(1);
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

// Numbered boilerplate clauses of about 100 code points. The emoji make code point and UTF-16
// offsets differ.
const boilerplate = (number: number) =>
  `${number}. Records. Each party will keep accurate records of its own work under this section 😀.\n`;
const RENEWAL_CLAUSE =
  "350.2 Renewal. This Agreement renews automatically for one (1) year unless either party gives sixty (60) days' written notice of non-renewal.\n";
const contractOf = (clauses: number) =>
  Array.from({ length: clauses }, (_, index) => boilerplate(index + 1));

function expectCoveringSections(text: string) {
  const chars = Array.from(text);
  const segments = contractAnalysisSegments(text);
  expect(segments.map((part) => part.label)).toEqual(
    segments.map((_, index) => `section-${index + 1}`),
  );
  expect(segments[0]!.start).toBe(0);
  expect(segments.at(-1)!.end).toBe(chars.length);
  for (const [index, part] of segments.entries()) {
    expect(part.end - part.start).toBeGreaterThan(0);
    expect(part.end - part.start).toBeLessThanOrEqual(CONTRACT_ANALYSIS_LIMIT);
    expect(chars.slice(part.start, part.end).join("")).toBe(part.text);
    if (index > 0) expect(part.start).toBe(segments[index - 1]!.end);
  }
  return segments;
}

describe("contract analysis segments", () => {
  it("sends a contract at or under the limit as one full segment", () => {
    const text = "😀".repeat(CONTRACT_ANALYSIS_LIMIT - 4) + "fee.";
    expect(contractAnalysisSegments(text)).toEqual([
      { label: "full", start: 0, end: CONTRACT_ANALYSIS_LIMIT, text },
    ]);
  });

  it("covers a longer contract with consecutive sections that split at numbered clauses", () => {
    const lines = contractOf(400);
    const text = lines.join("");
    expect(Array.from(text).length).toBeGreaterThan(
      CONTRACT_ANALYSIS_LIMIT * 2,
    );
    const segments = expectCoveringSections(text);

    expect(segments).toHaveLength(3);
    // Every section is made of whole clauses, so none starts or ends mid-clause.
    for (const part of segments) {
      expect(part.text).toMatch(/^\d+\. Records\./);
      expect(part.text.endsWith("😀.\n")).toBe(true);
    }
    expect(contractAnalysisSegments(text)).toEqual(segments);
  });

  it("starts sections after blank lines, including CRLF ones, and joins a heading to its clause", () => {
    const paragraph = (index: number) =>
      `Paragraph ${index}. Each party keeps its own records at its own offices, in good order and for seven years.\r\n\r\n`;
    const text = `9. TERM AND RENEWAL\n\n${Array.from({ length: 300 }, (_, index) => paragraph(index)).join("")}`;
    const segments = expectCoveringSections(text);

    expect(
      segments[0]!.text.startsWith("9. TERM AND RENEWAL\n\nParagraph 0."),
    ).toBe(true);
    for (const part of segments.slice(1))
      expect(part.text).toMatch(/^Paragraph \d+\./);
  });

  it("cuts unbroken prose at a space, never inside a word, and covers the 2,000,000-character extraction limit", () => {
    const text = "word ".repeat(400_000);
    const segments = expectCoveringSections(text);

    expect(segments).toHaveLength(
      Math.ceil(text.length / CONTRACT_ANALYSIS_LIMIT),
    );
    for (const part of segments) expect(part.text.endsWith(" ")).toBe(true);
  });

  it("verifies a quotation deep in a 60,000+ code point contract to whole-document offsets", () => {
    const lines = contractOf(700);
    lines.splice(349, 0, RENEWAL_CLAUSE);
    const text = lines.join("");
    expect(Array.from(text).length).toBeGreaterThan(60_000);
    const segments = expectCoveringSections(text);
    const quote = "sixty (60) days' written notice of non-renewal";
    const start = Array.from(text.slice(0, text.indexOf(quote))).length;
    const containing = segments.find(
      (part) => part.start <= start && start + quote.length <= part.end,
    )!;

    expect(containing.label).not.toBe("section-1");
    expect(verify(text, quote, containing.label)).toEqual({
      quote,
      start,
      end: start + quote.length,
    });
    expect(
      Array.from(text)
        .slice(start, start + quote.length)
        .join(""),
    ).toBe(quote);
    for (const part of segments.filter((part) => part !== containing))
      expect(verify(text, quote, part.label)).toBeNull();
    expect(verify(text, quote, `section-${segments.length + 1}`)).toBeNull();
  });
});
