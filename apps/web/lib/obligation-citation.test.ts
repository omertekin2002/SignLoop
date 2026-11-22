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
  isListedCitationRef,
  LISTED_FEES,
  LISTED_OBLIGATIONS,
  LISTED_PENALTIES,
  listedCitation,
  listedCitationIndex,
  listedCitationRef,
  listedContainer,
} from "./listed-citations";
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
const build = "Design, host and maintain the Client's website";
const buildClause =
  "The Provider will design, host and maintain the Client's website as described in the order form.";
const secret = "Keep the Client's data confidential";
const secretClause =
  "Each party keeps the other party's confidential information secret for five years.";
// The emoji makes code point and UTF-16 offsets differ; "the Client" appears more than once.
const contract = {
  id,
  text: `1. Services 😀. ${buildClause}\n\n2. Confidentiality. ${secretClause}\n3. Access. The Client gives the Provider access to its hosting account.\n`,
};
const proposal = (obligation: string, quote: string, segment = "full") => ({
  obligation,
  quote,
  segment,
});

const strict = (extra: Record<string, unknown> = {}) => ({
  risk_badge: "LOW",
  key_points: ["The Provider builds and runs the website."],
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
  key_dates: [],
  obligations: [build],
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

describe("obligation citation references", () => {
  it("name an obligation by its index, separately from penalties and fees", () => {
    expect(listedCitationRef(LISTED_OBLIGATIONS, 2)).toBe("obligation-2");
    expect(listedCitationIndex(LISTED_OBLIGATIONS, "obligation-2")).toBe(2);
    expect(listedCitationIndex(LISTED_FEES, "obligation-2")).toBeNull();
    expect(listedCitationIndex(LISTED_OBLIGATIONS, "fee-2")).toBeNull();
    for (const other of [
      "obligation-",
      "obligation-1000",
      "obligation--1",
      "obligations-0",
      "Obligation-0",
      "2",
      2,
    ]) {
      expect(listedCitationIndex(LISTED_OBLIGATIONS, other)).toBeNull();
      expect(isListedCitationRef(other)).toBe(false);
    }
    expect(isListedCitationRef("obligation-0")).toBe(true);
    expect(isListedCitationRef("fee-0")).toBe(true);
    expect(isListedCitationRef("penalty-0")).toBe(true);
  });

  it("find the list at the report's root, and penalties and fees in their summary groups", () => {
    const report = {
      obligations: [build],
      summary: { payments: { fees: [] }, cancellation: { penalties: [] } },
    };
    expect(listedContainer(LISTED_OBLIGATIONS, report)).toBe(report);
    expect(listedContainer(LISTED_FEES, report)).toBe(report.summary.payments);
    expect(listedContainer(LISTED_PENALTIES, report)).toBe(
      report.summary.cancellation,
    );
    expect(listedContainer(LISTED_FEES, { summary: null })).toBeNull();
    expect(listedContainer(LISTED_OBLIGATIONS, null)).toBeNull();
    expect(listedContainer(LISTED_OBLIGATIONS, [])).toBeNull();
  });

  it("look up a stored citation by the obligation's exact text only", () => {
    const stored = {
      obligation_citations: [{ obligation: build, citation: { quote: "x" } }],
    };
    expect(listedCitation(LISTED_OBLIGATIONS, stored, build)).toEqual({ quote: "x" });
    expect(listedCitation(LISTED_OBLIGATIONS, stored, build.toLowerCase())).toBeNull();
    expect(listedCitation(LISTED_OBLIGATIONS, stored, ` ${build}`)).toBeNull();
    expect(listedCitation(LISTED_OBLIGATIONS, {}, build)).toBeNull();
    expect(listedCitation(LISTED_OBLIGATIONS, null, build)).toBeNull();
    // Fee citations are a different list, even for the same text.
    expect(listedCitation(LISTED_FEES, stored, build)).toBeNull();
  });
});

describe("obligation_evidence in analysis output", () => {
  const offered = [proposal(build, buildClause)];

  it.each([
    ["strict", strict({ obligation_evidence: offered })],
    [
      "partial",
      {
        risk_badge: "LOW",
        key_points: ["The Provider builds the website."],
        summary: {
          renewal: { auto_renew: null },
          cancellation: { how: "In writing", notice_period_days: null },
        },
        obligations: [build],
        obligation_evidence: offered,
      },
    ],
    [
      "normalized",
      {
        ...strict(),
        risk_badge: "low",
        obligations: `- ${build}`,
        obligationEvidence: offered,
      },
    ],
  ])("survives %s parsing with the obligations", (_path, payload) => {
    expect(parse(payload)).toMatchObject({
      obligations: [build],
      obligation_evidence: offered,
    });
  });

  it("drops malformed entries one by one instead of rejecting the analysis", () => {
    const parsed = parse(
      strict({
        obligation_evidence: [
          "clause",
          { quote: buildClause, segment: "full" },
          proposal("", buildClause),
          proposal(build, "", "full"),
          proposal(build, buildClause, "tail"),
          { fee: build, quote: buildClause, segment: "full" },
          7,
          proposal(build, buildClause),
        ],
        obligation_citations: [{ obligation: build, citation: "forged" }, null],
      }),
    );
    expect(parsed.obligation_evidence).toEqual([proposal(build, buildClause)]);
    expect(parsed.obligation_citations).toEqual([]);
    expect(parsed.obligations).toEqual([build]);
  });

  it("drops a malformed list whole", () => {
    for (const malformed of ["clause", { obligation: build }, 7]) {
      const parsed = parse(
        strict({ obligation_evidence: malformed, obligation_citations: malformed }),
      );
      expect(parsed.obligation_evidence ?? []).toEqual([]);
      expect(parsed.obligation_citations ?? []).toEqual([]);
      expect(parsed.obligations).toEqual([build]);
    }
  });

  it("keeps reports stored before the fields valid", () => {
    expect(AnalysisResultSchema.safeParse(strict()).success).toBe(true);
    expect(
      PartialAnalysisResultSchema.safeParse({
        risk_badge: "LOW",
        key_points: ["Duties."],
        summary: {
          renewal: { auto_renew: false },
          cancellation: { how: "Not specified", notice_period_days: null },
        },
        obligations: [build],
      }).success,
    ).toBe(true);
  });

  it("asks for one quotation per listed obligation, repeating its text exactly", () => {
    const { prompt } = buildAnalysisPrompt("Contract body");
    expect(prompt).toContain(
      'For each entry in "obligations", add one entry to "obligation_evidence": its "obligation" repeats that obligation\'s text exactly',
    );
    expect(prompt).toContain(
      'When no obligations are listed, "obligation_evidence" is an empty array.',
    );
    expect(prompt).toContain('"obligation_evidence": [{ "obligation":');
  });
});

describe("finalizing obligation quotations", () => {
  it("stores a verified citation keyed by the obligation, with offsets and revision", () => {
    const stored = finalize({ obligation_evidence: [proposal(build, buildClause)] });
    expect(stored.obligations).toEqual([build]);
    expect(stored.obligation_citations).toEqual([
      {
        obligation: build,
        citation: {
          contract_id: id,
          revision: contractSourceRevision(contract.text),
          index_unit: "unicode-code-points",
          status: "verified",
          quote: buildClause,
          ...offsetsOf(buildClause),
        },
      },
    ]);
    expect(stored).not.toHaveProperty("obligation_evidence");
    const { start, end } = offsetsOf(buildClause);
    expect(Array.from(contract.text).slice(start, end).join("")).toBe(buildClause);
    expect(citationForReport(stored, id, "obligation-0")).toEqual(
      stored.obligation_citations![0]!.citation,
    );
    // Other citations are looked up separately.
    expect(citationForReport(stored, id, "obligation-1")).toBeNull();
    expect(citationForReport(stored, id, "fee-0")).toBeNull();
    expect(citationForReport(stored, id, "penalty-0")).toBeNull();
    expect(citationForReport(stored, id, 0)).toBeNull();
    expect(
      citationForReport(stored, "22e3e947-f71f-4ecd-a901-adbf24edbb8a", "obligation-0"),
    ).toBeNull();
  });

  it.each([
    [
      "a paraphrase",
      [proposal(build, "The Provider builds and hosts the Client's website.")],
    ],
    ["a quotation from the wrong segment", [proposal(build, buildClause, "section-2")]],
    ["a duplicated quotation", [proposal(build, "Client")]],
    ["no evidence", []],
  ])("stores no entry and keeps the obligation for %s", (_label, proposed) => {
    const stored = finalize({ obligation_evidence: proposed });
    expect(stored.obligations).toEqual([build]);
    expect(stored.obligation_citations).toEqual([]);
    expect(stored).not.toHaveProperty("obligation_evidence");
    expect(citationForReport(stored, id, "obligation-0")).toBeNull();
  });

  it("takes the first verifiable proposal for an obligation", () => {
    const stored = finalize({
      obligation_evidence: [
        proposal(build, "Client"),
        proposal(build, buildClause),
        proposal(build, secretClause),
      ],
    });
    expect(citationForReport(stored, id, "obligation-0")?.quote).toBe(buildClause);
  });

  it("discards a proposal whose obligation does not exactly match a listed one", () => {
    for (const named of [build.toLowerCase(), `${build}.`, secret]) {
      const stored = finalize({ obligation_evidence: [proposal(named, buildClause)] });
      expect(stored.obligation_citations).toEqual([]);
      expect(stored.obligations).toEqual([build]);
    }
  });

  it("stores nothing when no obligations are listed, even with proposals", () => {
    const stored = finalize({
      obligations: [],
      obligation_evidence: [proposal(build, buildClause)],
    });
    expect(stored.obligation_citations).toEqual([]);
    expect(citationForReport(stored, id, "obligation-0")).toBeNull();
  });

  it("gives each of two obligations its own quotation, never the other's", () => {
    const stored = finalize({
      obligations: [build, secret],
      // Listed in the other order, so nothing depends on position.
      obligation_evidence: [proposal(secret, secretClause), proposal(build, buildClause)],
    });
    expect(citationForReport(stored, id, "obligation-0")).toMatchObject({
      quote: buildClause,
      ...offsetsOf(buildClause),
    });
    expect(citationForReport(stored, id, "obligation-1")).toMatchObject({
      quote: secretClause,
      ...offsetsOf(secretClause),
    });

    // With only the second obligation quoted, the first has none rather than the second's.
    const one = finalize({
      obligations: [build, secret],
      obligation_evidence: [proposal(secret, secretClause)],
    });
    expect(citationForReport(one, id, "obligation-0")).toBeNull();
    expect(citationForReport(one, id, "obligation-1")?.quote).toBe(secretClause);
  });

  it("verifies the same text listed as an obligation and as a fee in each list on its own", () => {
    const parsed = parse(strict({ obligation_evidence: [proposal(build, buildClause)] }));
    parsed.summary.payments.fees = [build];
    parsed.summary.payments.fee_evidence = [];
    const stored = finalizeAnalysisResult(parsed, contract);
    expect(citationForReport(stored, id, "obligation-0")?.quote).toBe(buildClause);
    expect(citationForReport(stored, id, "fee-0")).toBeNull();
  });

  it("never stores a model-supplied citation as-is", () => {
    const forged = {
      obligation: build,
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
    expect(parse(strict({ obligation_citations: [forged] })).obligation_citations).toEqual([
      forged,
    ]);
    // Without evidence the forged citation is discarded.
    expect(finalize({ obligation_citations: [forged] }).obligation_citations).toEqual([]);
    // With evidence the server's own match replaces it.
    const replaced = finalize({
      obligation_citations: [forged],
      obligation_evidence: [proposal(build, buildClause)],
    }).obligation_citations;
    expect(replaced).toHaveLength(1);
    expect(replaced![0]!.citation).toMatchObject({ quote: buildClause });
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
    expect(citationForReport(legacy, id, "obligation-0")).toBeNull();
  });
});

describe("obligation quotations in long contracts", () => {
  const CONTRACT_ID = id;
  const quote = buildClause;
  const otherQuote = secretClause;
  const text = contractOf(400, {
    200: `200.1 Services. ${quote}\n`,
    380: `380.1 Confidentiality. ${otherQuote}\n`,
  });
  const segments = contractAnalysisSegments(text);
  const sectionOf = (wanted: string) =>
    Number(
      segments
        .find((part) => part.text.includes(wanted))!
        .label.slice("section-".length),
    );
  const buildSection = sectionOf(quote);
  const secretSection = sectionOf(otherQuote);
  type Duties = {
    obligations?: string[];
    obligationQuotes?: Record<string, string>;
  };
  const quoting: Record<number, Duties> = {
    [buildSection]: { obligations: [build], obligationQuotes: { [build]: quote } },
    [secretSection]: {
      obligations: [secret],
      obligationQuotes: { [secret]: otherQuote },
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

  // Each section's obligations come from `bySection`, falling back to the two quoting sections.
  async function analyse(
    merge: "fails" | Record<string, unknown>,
    bySection: Record<number, Duties> = {},
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

  const citedQuotes = (stored: { obligation_citations?: unknown }) =>
    (
      stored.obligation_citations as {
        obligation: string;
        citation: { quote: string };
      }[]
    ).map(({ obligation, citation }) => [obligation, citation.quote]);

  it("quotes each obligation from the section listing it when the merge call fails", async () => {
    expect(buildSection).toBeGreaterThan(1);
    expect(secretSection).toBeGreaterThan(buildSection);
    const { answer, stored } = await analyse("fails");
    expect(answer.result.obligations).toEqual([build, secret]);
    expect(answer.result.obligation_evidence).toEqual([
      { obligation: build, quote, segment: `section-${buildSection}` },
      { obligation: secret, quote: otherQuote, segment: `section-${secretSection}` },
    ]);
    expect(citedQuotes(stored)).toEqual([
      [build, quote],
      [secret, otherQuote],
    ]);
    const start = text.indexOf(otherQuote);
    expect(citationForReport(stored, CONTRACT_ID, "obligation-1")).toMatchObject({
      status: "verified",
      quote: otherQuote,
      start: Array.from(text.slice(0, start)).length,
    });
    expect(citationForReport(stored, CONTRACT_ID, "obligation-0")?.quote).toBe(quote);
  });

  it("skips a section whose quotation is not in its own segment and uses a later one listing the same text", async () => {
    const { answer } = await analyse("fails", {
      1: { obligations: [build], obligationQuotes: { [build]: quote } },
    });
    expect(answer.result.obligation_evidence).toContainEqual({
      obligation: build,
      quote,
      segment: `section-${buildSection}`,
    });
  });

  it("never borrows a quotation from a section that does not list that obligation", async () => {
    const { answer, stored } = await analyse("fails", {
      1: { obligations: [secret] },
      [secretSection]: { obligationQuotes: { [secret]: otherQuote } },
    });
    expect(answer.result.obligations).toEqual([secret, build]);
    expect(citedQuotes(stored)).toEqual([[build, quote]]);
  });

  it("has no quotation for an obligation an earlier section worded differently", async () => {
    const reworded = build.toLowerCase();
    const { answer, stored } = await analyse("fails", {
      1: { obligations: [reworded] },
    });
    expect(answer.result.obligations).toEqual([reworded, secret]);
    expect(citedQuotes(stored)).toEqual([[secret, otherQuote]]);
    expect(citationForReport(stored, CONTRACT_ID, "obligation-0")).toBeNull();
  });

  it("keeps the sections' quotations for the merge model's obligations, never its own", async () => {
    const { answer, stored, double } = await analyse({
      obligations: [secret, build],
      obligation_evidence: [
        { obligation: secret, quote: "Records. Each party", segment: "section-1" },
      ],
      obligation_citations: [
        {
          obligation: secret,
          citation: { status: "verified", quote: "Records", start: 0, end: 7 },
        },
      ],
    });
    expect(answer.result.obligation_evidence).toEqual([
      { obligation: secret, quote: otherQuote, segment: `section-${secretSection}` },
      { obligation: build, quote, segment: `section-${buildSection}` },
    ]);
    expect(answer.result).not.toHaveProperty("obligation_citations");
    expect(citedQuotes(stored)).toEqual([
      [secret, otherQuote],
      [build, quote],
    ]);
    // The merge model never sees the sections' quotations.
    const mergeInput = double.mergeCalls()[0]!.input;
    expect(mergeInput).toContain(build);
    expect(mergeInput).not.toContain("obligation_evidence");
    expect(mergeInput).not.toContain("as described in the order form");
  });

  it("has no quotation for an obligation the merge model reworded or combined", async () => {
    const reworded = "Build and run the Client's website";
    const combined = `${build}, and ${secret.toLowerCase()}`;
    const { answer, stored } = await analyse({
      obligations: [reworded, combined, secret],
    });
    expect(answer.result.obligations).toEqual([reworded, combined, secret]);
    expect(citedQuotes(stored)).toEqual([[secret, otherQuote]]);
    expect(citationForReport(stored, CONTRACT_ID, "obligation-0")).toBeNull();
    expect(citationForReport(stored, CONTRACT_ID, "obligation-1")).toBeNull();
    expect(citationForReport(stored, CONTRACT_ID, "obligation-2")?.quote).toBe(otherQuote);
  });

  it("stores no obligation quotations when no obligations are merged", async () => {
    const { answer, stored } = await analyse({ obligations: [] });
    expect(answer.result.obligation_evidence).toEqual([]);
    expect(stored.obligation_citations).toEqual([]);
  });
});

describe("the merge prompt", () => {
  it("does not show the merge model the sections' obligation quotations", () => {
    const text = `${"1. Records. Each party keeps accurate records of its own work under this agreement.\n".repeat(200)}${buildClause}\n`;
    const segments = contractAnalysisSegments(text);
    expect(segments.length).toBeGreaterThan(1);
    const sections = segments.map((segment) => ({
      segment,
      result: parse(
        strict({ obligation_evidence: [proposal(build, buildClause, segment.label)] }),
      ),
    }));
    const prompt = buildMergePrompt(sections, segments.length);
    expect(prompt).toContain(build);
    expect(prompt).not.toContain("obligation_evidence");
    expect(prompt).not.toContain("obligation_citations");
    expect(prompt).not.toContain("as described in the order form");
  });
});
