import { marked, type Token } from "marked";
import { describe, expect, it } from "vitest";
import {
  renderAnalysisBriefMarkdown,
  type AnalysisBriefInput,
} from "@/lib/analysis-brief";
import type { AnalysisResult } from "@/lib/schemas";

const CONTRACT_ID = "11111111-2222-4333-8444-555555555555";
const REVISION = `sha256:${"a".repeat(64)}`;
const SOURCE = {
  contract_id: CONTRACT_ID,
  revision: REVISION,
  index_unit: "unicode-code-points" as const,
};

function citation(quote: string, start = 100) {
  return {
    ...SOURCE,
    status: "verified" as const,
    quote,
    start,
    end: start + Array.from(quote).length,
  };
}

type RedFlag = AnalysisResult["red_flags"][number];

function flag(overrides: Partial<RedFlag> = {}): RedFlag {
  return {
    type: "Auto-renewal",
    severity: 7,
    explanation: "The contract renews for a further year unless cancelled.",
    where: "Clause 9.2",
    evidence: null,
    citation: null,
    confidence: 80,
    ...overrides,
  };
}

const FULL_RESULT: AnalysisResult = {
  source: SOURCE,
  coverage_notices: [
    "Only part of this contract was analysed: the middle pages were skipped.",
    "Scanned pages were read with OCR and may contain errors.",
  ],
  comparisons_withheld: false,
  comparison_jurisdiction: "England and Wales",
  proposed_jurisdiction: {
    jurisdiction: "England and Wales",
    evidence: { quote: "governed by the laws of England and Wales", segment: "tail" },
    citation: citation("governed by the laws of England and Wales", 900),
  },
  risk_badge: "HIGH",
  key_points: [
    "Renews automatically every year.",
    "Only part of this contract was analysed: the middle pages were skipped.",
  ],
  summary: {
    what_it_is: "A gym membership agreement.",
    payments: { amount: "£45", frequency: "Monthly", fees: ["Joining fee of £20"] },
    term: { start: "2026-01-01", end: "2026-12-31", minimum_term: "12 months" },
    renewal: { auto_renew: true, renewal_period: "12 months" },
    cancellation: {
      how: "Write to the club.",
      notice_period_days: null,
      notice_period_text: "one calendar month",
      penalties: ["Early exit fee of two months' dues"],
    },
  },
  red_flags: [
    flag({
      evidence: { quote: "shall renew automatically", segment: "middle-1" },
      citation: citation("shall renew automatically"),
    }),
    flag({
      type: "Price increase",
      severity: null,
      confidence: null,
      where: null,
      explanation: "Fees may rise once a year.",
      evidence: { quote: "may increase fees annually", segment: "head" },
    }),
    flag({ type: "Liability", explanation: "Liability is capped at one month's fees." }),
  ],
  normal_in_region: [
    {
      topic: "Notice period",
      jurisdiction: "England and Wales",
      typical_range: "30 days",
      yours: "one calendar month",
      label: "typical",
    },
  ],
  next_actions: {
    questions_to_ask: ["Can the renewal be switched off?"],
    email_templates: [
      { subject: "Cancelling my membership", body: "Hello,\n\nPlease cancel my membership.\n\nThanks" },
    ],
  },
  key_dates: [
    { type: "NOTICE_CUTOFF", date: "2026-11-30", derived_from: "One month before renewal" },
  ],
  obligations: ["Pay monthly dues"],
  parties: ["Example Gym Ltd", "Member"],
  disclaimer: "This is an AI analysis, not legal advice.",
};

function brief(
  result: Partial<AnalysisResult> | Record<string, unknown>,
  overrides: Omit<Partial<AnalysisBriefInput>, "contract"> & {
    contract?: Partial<AnalysisBriefInput["contract"]>;
  } = {},
) {
  return renderAnalysisBriefMarkdown({
    timeZone: "UTC",
    ...overrides,
    contract: {
      id: CONTRACT_ID,
      title: "Gym membership",
      status: "ANALYZED",
      extractionWarning: null,
      ...overrides.contract,
    },
    analysis: {
      createdAt: "2026-10-29T14:05:00.000Z",
      riskBadge: "HIGH",
      resultJson: result as Partial<AnalysisResult>,
      ...overrides.analysis,
    },
  });
}

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`No ${heading} section`);
  const next = markdown.indexOf("\n## ", start + 1);
  const end = next < 0 ? markdown.indexOf("\n---\n", start) : next;
  return markdown.slice(start, end < 0 ? undefined : end);
}

function allTokens(tokens: Token[]): Token[] {
  return tokens.flatMap((token) => {
    const children = [
      ...("tokens" in token && Array.isArray(token.tokens) ? token.tokens : []),
      ...("items" in token && Array.isArray(token.items) ? token.items : []),
    ] as Token[];
    return [token, ...allTokens(children)];
  });
}

describe("renderAnalysisBriefMarkdown", () => {
  it("renders every section of a full analysis in order", () => {
    const { filename, markdown } = brief(FULL_RESULT);

    expect(filename).toBe("signloop-brief-gym-membership-2026-10-29.md");
    const headings = markdown.match(/^## .+$/gm);
    expect(headings).toEqual([
      "## Coverage",
      "## Jurisdiction",
      "## Summary",
      "## Findings",
      "## Next steps",
    ]);
    expect(markdown).toMatch(/^# Decision brief: Gym membership\n/);
    expect(markdown).toContain("- **Analyzed:** Oct 29, 2026 14:05");
    expect(markdown).toContain("- **Risk level:** HIGH");
    expect(markdown).toContain(`- **Source revision:** \`${REVISION}\``);
    expect(markdown).not.toContain("Outdated analysis");

    const summary = section(markdown, "Summary");
    expect(summary).toContain("- **What it is:** A gym membership agreement.");
    expect(summary).toContain("  - Amount: £45");
    expect(summary).toContain("    - Joining fee of £20");
    expect(summary).toContain("  - Automatic renewal: Auto-renews");
    // The original notice wording, with its units, wins over a day count.
    expect(summary).toContain("  - Notice period: one calendar month");
    expect(summary).toContain("    - Early exit fee of two months' dues");
    expect(summary).toContain("- **Notice cutoff:** 2026-11-30 (from: One month before renewal)");
    expect(summary).toContain("- Pay monthly dues");
    expect(summary).toContain("- Example Gym Ltd");
    // Key points exclude coverage notices, as on the page.
    expect(summary).toContain("- Renews automatically every year.");
    expect(summary).not.toContain("middle pages were skipped");

    const findings = section(markdown, "Findings");
    expect(findings).toContain("### 1. Auto-renewal");
    expect(findings).toContain("- **Severity:** 7/10");
    expect(findings).toContain("- **Confidence:** 80%");
    expect(findings).toContain("- **Found in:** Clause 9.2");

    const nextSteps = section(markdown, "Next steps");
    expect(nextSteps).toContain("These are drafts generated by the analysis.");
    expect(nextSteps).toContain("1. Can the renewal be switched off?");
    expect(nextSteps).toContain("#### Draft 1: Cancelling my membership");
    expect(nextSteps).toContain("```text\nHello,\n\nPlease cancel my membership.\n\nThanks\n```");

    expect(markdown).toContain("**Disclaimer:** This is an AI analysis, not legal advice.");
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("renders a partial analysis without null, undefined or empty values", () => {
    const { filename, markdown } = brief(
      {
        risk_badge: "LOW",
        summary: {
          what_it_is: "",
          payments: { amount: null, frequency: null, fees: [] },
          term: { start: null, end: null, minimum_term: null },
          renewal: { auto_renew: false, renewal_period: null },
          cancellation: { how: "By email", notice_period_days: null, penalties: [] },
        },
        red_flags: [{ type: "", severity: null, explanation: "", where: null, confidence: null }],
        key_points: [],
        coverage_notices: [],
        key_dates: [],
        obligations: [null, "  "],
        parties: [],
        next_actions: { questions_to_ask: [], email_templates: [] },
      },
      {
        contract: { title: null },
        analysis: { createdAt: null, riskBadge: null },
      },
    );

    expect(markdown).not.toMatch(/\bnull\b|\bundefined\b|NaN|\[object/);
    expect(filename).toBe("signloop-brief-untitled-contract.md");
    expect(markdown).toContain("# Decision brief: Untitled contract");
    expect(markdown).toContain("- **Analyzed:** Unknown date");
    expect(markdown).toContain("- **Risk level:** LOW");
    expect(markdown).not.toContain("Source revision");
    expect(markdown).toContain("- **What it is:** Not specified");
    expect(markdown).toContain("  - Automatic renewal: Does not auto-renew");
    expect(markdown).toContain("  - Notice period: Not specified");
    expect(markdown).toContain("  - Fees: None listed");
    expect(markdown).toContain("### 1. Risk");
    expect(markdown).toContain("No explanation provided.");
    expect(markdown).toContain("No extraction or coverage notices were recorded");
    expect(markdown).toContain("No next steps were suggested in this analysis.");
    // A report saved without a disclaimer still carries the default one.
    expect(markdown).toContain("**Disclaimer:** This is an AI analysis, not legal advice.");
    // A missing section of the stored result is skipped, not rendered as an error.
    expect(() => brief({})).not.toThrow();
    expect(brief({}).markdown).not.toMatch(/\bnull\b|\bundefined\b/);
  });

  it("renders an unknown auto-renewal as unknown, not as no", () => {
    const { markdown } = brief({
      ...FULL_RESULT,
      summary: {
        ...FULL_RESULT.summary,
        renewal: { auto_renew: null, renewal_period: null },
      },
    });
    expect(markdown).toContain("  - Automatic renewal: Unknown");
    expect(markdown).not.toContain("Does not auto-renew");
  });

  it("labels verified, unverified and missing quotations", () => {
    const findings = section(brief(FULL_RESULT).markdown, "Findings");
    const [first, second, third] = findings.split(/\n### \d+\. /).slice(1);

    expect(first).toContain("**Verified quotation**");
    expect(first).toContain("> shall renew automatically");
    expect(second).toContain("**Unverified quotation**");
    expect(second).not.toContain("Verified quotation");
    expect(second).toContain("> may increase fees annually");
    expect(second).toContain("- **Severity:** Not provided");
    expect(second).toContain("- **Confidence:** Not provided");
    expect(second).not.toContain("Found in");
    expect(third).not.toMatch(/quotation\*\*|^>/m);
    expect(third).toContain("No source quotation.");
  });

  it("does not call a citation verified unless it matches this contract's analysed revision", () => {
    const stale = flag({
      evidence: { quote: "shall renew automatically", segment: "full" },
      citation: { ...citation("shall renew automatically"), revision: `sha256:${"b".repeat(64)}` },
    });
    const otherContract = flag({
      citation: {
        ...citation("shall renew automatically"),
        contract_id: "99999999-2222-4333-8444-555555555555",
      },
    });
    const findings = section(
      brief({ ...FULL_RESULT, red_flags: [stale, otherContract] }).markdown,
      "Findings",
    );
    expect(findings).not.toContain("Verified quotation");
    expect(findings).toContain("**Unverified quotation**");
    // A citation that fails the check, without a proposal of its own, shows no quote at all.
    expect(findings.split(/\n### \d+\. /)[2]).toContain("No source quotation.");
  });

  it("states confirmed, proposed-only and absent jurisdictions", () => {
    const confirmed = section(brief(FULL_RESULT).markdown, "Jurisdiction");
    expect(confirmed).toContain("**Confirmed:** England and Wales (confirmed when this analysis ran).");
    expect(confirmed).toContain("**Verified quotation**");
    expect(confirmed).toContain("> governed by the laws of England and Wales");

    const proposedOnly = section(
      brief({
        ...FULL_RESULT,
        comparison_jurisdiction: null,
        comparisons_withheld: true,
        normal_in_region: [],
        proposed_jurisdiction: {
          jurisdiction: "Scotland",
          evidence: { quote: "the laws of Scotland", segment: "tail" },
          citation: null,
        },
      }).markdown,
      "Jurisdiction",
    );
    expect(proposedOnly).toContain("**Proposed, not confirmed:** Scotland");
    expect(proposedOnly).not.toContain("**Confirmed:**");
    expect(proposedOnly).toContain("**Unverified quotation**");

    const absent = section(
      brief({
        ...FULL_RESULT,
        comparison_jurisdiction: null,
        proposed_jurisdiction: null,
        comparisons_withheld: true,
        normal_in_region: [],
      }).markdown,
      "Jurisdiction",
    );
    expect(absent).toContain("**Not confirmed.**");
    expect(absent).not.toContain("quotation");
  });

  it("includes regional comparisons only when the page would show them", () => {
    const shown = section(brief(FULL_RESULT).markdown, "Jurisdiction");
    expect(shown).toContain("### Regional comparisons");
    expect(shown).toContain("Compared with typical practice in the confirmed jurisdiction.");
    expect(shown).toContain("- **Notice period** (typical)");
    expect(shown).toContain("  - Typical: 30 days");

    // Withheld reports never list comparisons, even if stored data still carries some.
    const withheld = section(
      brief({ ...FULL_RESULT, comparisons_withheld: true }).markdown,
      "Jurisdiction",
    );
    expect(withheld).not.toContain("### Regional comparisons");
    expect(withheld).not.toContain("30 days");
    expect(withheld).toContain("Regional comparisons are not included");

    // Reports saved before withholding existed keep their comparisons, marked unconfirmed.
    const legacy = section(
      brief({ ...FULL_RESULT, comparisons_withheld: undefined }).markdown,
      "Jurisdiction",
    );
    expect(legacy).toContain("Generated without a confirmed jurisdiction.");
  });

  it("always keeps the extraction warning and coverage notices, listing each once", () => {
    const warning = "Scanned pages were read with OCR and may contain errors.";
    const coverage = section(
      brief(
        {
          ...FULL_RESULT,
          coverage_notices: [...FULL_RESULT.coverage_notices!, FULL_RESULT.coverage_notices![0]!],
        },
        { contract: { extractionWarning: warning } },
      ).markdown,
      "Coverage",
    );
    expect(coverage).toContain(`- **Text extraction:** ${warning}`);
    expect(coverage).toContain(
      "  - Only part of this contract was analysed: the middle pages were skipped.",
    );
    expect(coverage.split(warning)).toHaveLength(2);
    expect(coverage.split("middle pages were skipped")).toHaveLength(2);

    // Without a current warning, the report's own copy of it stays listed.
    const withoutWarning = section(brief(FULL_RESULT).markdown, "Coverage");
    expect(withoutWarning).toContain(`  - ${warning}`);
    expect(withoutWarning).not.toContain("Text extraction");
  });

  it("marks an outdated or earlier analysis", () => {
    const outdated = brief(FULL_RESULT, { contract: { status: "UPLOADED" } }).markdown;
    expect(outdated).toContain(
      "**Outdated analysis.** This analysis uses older evidence. The contract or project context has changed; analyze again for a current result.",
    );
    expect(brief(FULL_RESULT, { contract: { status: null } }).markdown).toContain(
      "**Outdated analysis.**",
    );
    expect(brief(FULL_RESULT, { historical: true }).markdown).toContain(
      "**Earlier analysis.** A newer analysis of this contract exists.",
    );
    expect(brief(FULL_RESULT).markdown).not.toContain("Earlier analysis");
  });

  it("keeps Markdown in titles, quotes and model text inert", () => {
    const hostile = [
      "# Injected heading",
      "> fake quote",
      "```js",
      "alert(1)",
      "```",
      "- injected item",
      "1. injected step",
      "| a | b |",
      "| - | - |",
      "    indented code",
      "<script>alert(1)</script> [click](https://evil.example) ![x](https://evil.example/x.png)",
      "**bold** _em_ ~~strike~~ $x$ &copy;",
    ].join("\n");
    const title = "# Lease `v2` <b>bold</b> [link](https://evil.example) |x|";
    const { filename, markdown } = brief(
      {
        ...FULL_RESULT,
        coverage_notices: [hostile],
        key_points: [hostile],
        red_flags: [
          flag({
            type: hostile,
            explanation: hostile,
            where: hostile,
            evidence: { quote: hostile, segment: "full" },
            citation: citation(hostile),
          }),
          flag({ evidence: { quote: hostile, segment: "full" } }),
        ],
        next_actions: {
          questions_to_ask: [hostile],
          email_templates: [{ subject: hostile, body: `${hostile}\n\`\`\`\`\nafter fence` }],
        },
        obligations: [hostile],
        disclaimer: hostile,
      },
      { contract: { title, extractionWarning: hostile } },
    );

    expect(filename).toBe("signloop-brief-lease-v2-b-bold-b-link-https-evil-example-x-2026-10-29.md");
    const tokens = allTokens(marked.lexer(markdown));
    const types = new Set(tokens.map((token) => token.type));
    for (const type of ["html", "image", "table", "em", "del"]) {
      expect(types, type).not.toContain(type);
    }
    // A bare URL may still autolink, but only as itself: no text can hide where a link goes.
    for (const link of tokens.filter((token) => token.type === "link")) {
      expect("href" in link && link.href).toMatch(/^https:\/\/evil\.example/);
      expect("text" in link && link.text).toBe(link.raw);
    }
    const headings = tokens.filter((token) => token.type === "heading");
    expect(headings.filter((token) => "depth" in token && token.depth === 1)).toHaveLength(1);
    for (const heading of headings) {
      expect(heading.raw).not.toMatch(/^#+ Injected heading/);
    }
    // Only the source revision is a code span, and only the email drafts are code blocks.
    const codeSpans = tokens.filter((token) => token.type === "codespan");
    expect(codeSpans.map((token) => "text" in token && token.text)).toEqual([REVISION]);
    const codeBlocks = tokens.filter((token) => token.type === "code");
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0]).toMatchObject({ lang: "text" });
    expect("text" in codeBlocks[0]! && codeBlocks[0].text).toContain("after fence");
    // The brief's strong labels never contain contract text.
    for (const strong of tokens.filter((token) => token.type === "strong")) {
      expect("text" in strong && strong.text).not.toMatch(/bold|Injected/);
    }

    const html = marked.parse(markdown, { async: false });
    expect(html).not.toMatch(/<script|<b>|<img|<table|<del|<em>|>click</);
    expect(html).toContain("# Injected heading");
    expect(html).toContain("&lt;script&gt;");
    // The jurisdiction's and the two findings' quotations stay single blockquotes; the injected
    // "> fake quote" neither nests nor starts one of its own.
    const quotes = tokens.filter((token) => token.type === "blockquote");
    expect(quotes).toHaveLength(3);
    for (const quote of quotes) {
      expect(allTokens("tokens" in quote ? (quote.tokens as Token[]) : []).map((t) => t.type))
        .not.toContain("blockquote");
    }
  });
});
