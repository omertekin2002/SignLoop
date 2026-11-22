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
    evidence: { quote: "governed by the laws of England and Wales", segment: "section-3" },
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
      evidence: { quote: "shall renew automatically", segment: "section-2" },
      citation: citation("shall renew automatically"),
    }),
    flag({
      type: "Price increase",
      severity: null,
      confidence: null,
      where: null,
      explanation: "Fees may rise once a year.",
      evidence: { quote: "may increase fees annually", segment: "section-1" },
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
      "## Before you sign: what to clarify",
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
    // The questions moved to the checklist; the drafts stay here.
    expect(nextSteps).not.toContain("Questions to ask");
    expect(nextSteps).not.toContain("Can the renewal be switched off?");
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
    expect(markdown).toContain("No draft emails were suggested in this analysis.");
    // A report saved without a disclaimer still carries the default one.
    expect(markdown).toContain("**Disclaimer:** This is an AI analysis, not legal advice.");
    // A missing section of the stored result is skipped, not rendered as an error.
    expect(() => brief({})).not.toThrow();
    expect(brief({}).markdown).not.toMatch(/\bnull\b|\bundefined\b/);
  });

  it("shows the notice period's verified quotation, marks a stated period without one, and leaves an unknown one", () => {
    const withNotice = (cancellation: Record<string, unknown>) =>
      section(
        brief({
          ...FULL_RESULT,
          summary: {
            ...FULL_RESULT.summary,
            cancellation: { how: "Write to the club.", penalties: [], ...cancellation },
          },
        }).markdown,
        "Summary",
      );
    const clause = "Either party may end this agreement on 10 business days' *written* notice.";

    const quoted = withNotice({
      notice_period_days: null,
      notice_period_text: "10 business days",
      notice_citation: citation(clause, 400),
    });
    expect(quoted).toContain(
      [
        "  - Notice period: 10 business days",
        "    - **Verified quotation** (matched in the extracted contract text; it shows where this value comes from, not that this reading is correct):",
        "      > Either party may end this agreement on 10 business days' \\*written\\* notice.",
      ].join("\n"),
    );
    expect(quoted).not.toContain("10 business days (**No verified quotation**)");
    // The quotation renders inside the notice period's list item as a block quote.
    const tokens = allTokens(marked.lexer(quoted));
    expect(tokens.filter((token) => token.type === "blockquote")).toHaveLength(1);

    // A report stored before notice quotations, an unverified one, and one for another contract.
    for (const cancellation of [
      { notice_period_days: 60 },
      { notice_period_days: 60, notice_period_text: "60 days", notice_citation: null },
      {
        notice_period_days: 60,
        notice_citation: { ...citation(clause), contract_id: "99999999-2222-4333-8444-555555555555" },
      },
    ]) {
      const marked = withNotice(cancellation);
      expect(marked).toContain("  - Notice period: 60 days (**No verified quotation**)");
      expect(marked).not.toContain("Verified quotation");
    }

    const unknown = withNotice({
      notice_period_days: null,
      notice_period_text: null,
      notice_citation: citation(clause),
    });
    expect(unknown).toContain("  - Notice period: Not specified\n");
    expect(unknown).not.toContain("Either party may end this agreement");
  });

  it("shows renewal's verified quotation, marks stated renewal without one, and leaves unknown renewal", () => {
    const withRenewal = (renewal: Record<string, unknown>) =>
      section(
        brief({
          ...FULL_RESULT,
          summary: { ...FULL_RESULT.summary, renewal },
        }).markdown,
        "Summary",
      );
    const clause = "This membership renews *automatically* for further 12-month terms.";

    const quoted = withRenewal({
      auto_renew: true,
      renewal_period: "12 months",
      renewal_citation: citation(clause, 300),
    });
    expect(quoted).toContain(
      [
        "- **Renewal:**",
        "  - Automatic renewal: Auto-renews",
        "  - Renewal period: 12 months",
        "    - **Verified quotation** (matched in the extracted contract text; it shows where this value comes from, not that this reading is correct):",
        "      > This membership renews \\*automatically\\* for further 12-month terms.",
        "- **Cancellation:**",
      ].join("\n"),
    );
    expect(quoted).not.toContain("Renewal period: 12 months (**No verified quotation**)");
    // The quotation renders inside the renewal period's list item as a block quote.
    const tokens = allTokens(marked.lexer(quoted));
    expect(tokens.filter((token) => token.type === "blockquote")).toHaveLength(1);

    // A report stored before renewal quotations, an unverified one, one for another contract, and
    // renewal stated only as not automatic or only by its period.
    for (const [renewal, lines] of [
      [{ auto_renew: true, renewal_period: "12 months" }, ["Auto-renews", "12 months"]],
      [
        { auto_renew: true, renewal_period: "12 months", renewal_citation: null },
        ["Auto-renews", "12 months"],
      ],
      [
        {
          auto_renew: true,
          renewal_period: "12 months",
          renewal_citation: { ...citation(clause), contract_id: "99999999-2222-4333-8444-555555555555" },
        },
        ["Auto-renews", "12 months"],
      ],
      [{ auto_renew: false, renewal_period: null }, ["Does not auto-renew", "Not specified"]],
      [{ auto_renew: null, renewal_period: "Monthly" }, ["Unknown", "Monthly"]],
    ] as const) {
      const marked = withRenewal(renewal);
      expect(marked).toContain(
        `  - Automatic renewal: ${lines[0]}\n  - Renewal period: ${lines[1]} (**No verified quotation**)\n`,
      );
      expect(marked).not.toContain("Verified quotation** (");
    }

    const unknown = withRenewal({
      auto_renew: null,
      renewal_period: null,
      renewal_citation: citation(clause),
    });
    expect(unknown).toContain(
      "  - Automatic renewal: Unknown\n  - Renewal period: Not specified\n",
    );
    expect(unknown).not.toContain(clause);
    expect(unknown).not.toContain("Renewal period: Not specified (");
  });

  it("shows the payment's verified quotation, marks stated payment without one, and leaves unknown payment", () => {
    const withPayments = (payments: Record<string, unknown>) =>
      section(
        brief({
          ...FULL_RESULT,
          summary: { ...FULL_RESULT.summary, payments: { fees: [], ...payments } },
        }).markdown,
        "Summary",
      );
    const clause = "Members pay *£45* each month by direct debit.";

    const quoted = withPayments({
      amount: "£45",
      frequency: "Monthly",
      fees: ["Joining fee of £20"],
      payment_citation: citation(clause, 200),
    });
    expect(quoted).toContain(
      [
        "- **Payments:**",
        "  - Amount: £45",
        "  - Frequency: Monthly",
        "    - **Verified quotation** (matched in the extracted contract text; it shows where this value comes from, not that this reading is correct):",
        "      > Members pay \\*£45\\* each month by direct debit.",
        "  - Fees:",
        // Reports analysed before fee quotations mark each listed fee.
        "    - Joining fee of £20 (**No verified quotation**)",
        "- **Term:**",
      ].join("\n"),
    );
    expect(quoted).not.toContain("Monthly (**No verified quotation**)");
    // The quotation renders inside the frequency's list item as a block quote.
    const tokens = allTokens(marked.lexer(quoted));
    expect(tokens.filter((token) => token.type === "blockquote")).toHaveLength(1);

    // A report stored before payment quotations, an unverified one, one for another contract, and
    // payment stated only by its amount or only by its frequency.
    for (const [payments, lines] of [
      [{ amount: "£45", frequency: "Monthly" }, ["£45", "Monthly"]],
      [{ amount: "£45", frequency: "Monthly", payment_citation: null }, ["£45", "Monthly"]],
      [
        {
          amount: "£45",
          frequency: "Monthly",
          payment_citation: { ...citation(clause), contract_id: "99999999-2222-4333-8444-555555555555" },
        },
        ["£45", "Monthly"],
      ],
      [{ amount: "£45", frequency: null }, ["£45", "Not specified"]],
      [{ amount: null, frequency: "Yearly" }, ["Not specified", "Yearly"]],
    ] as const) {
      const marked = withPayments(payments);
      expect(marked).toContain(
        `  - Amount: ${lines[0]}\n  - Frequency: ${lines[1]} (**No verified quotation**)\n  - Fees: None listed\n`,
      );
      expect(marked).not.toContain("Verified quotation** (");
    }

    for (const unknown of [
      { amount: null, frequency: null },
      { amount: "Not specified", frequency: "Unknown" },
    ]) {
      const marked = withPayments({ ...unknown, payment_citation: citation(clause) });
      expect(marked).toContain(
        `  - Amount: ${unknown.amount ?? "Not specified"}\n  - Frequency: ${unknown.frequency ?? "Not specified"}\n  - Fees: None listed\n`,
      );
      expect(marked).not.toContain("direct debit");
      expect(marked).not.toMatch(/Frequency: [^\n]*\(/);
    }
  });

  it("shows the term's verified quotation, marks a stated term without one, and leaves an unknown term", () => {
    const withTerm = (term: Record<string, unknown>) =>
      section(
        brief({
          ...FULL_RESULT,
          summary: { ...FULL_RESULT.summary, term },
        }).markdown,
        "Summary",
      );
    const clause = "Membership starts on *1 January 2026* and lasts at least 12 months.";

    const quoted = withTerm({
      start: "2026-01-01",
      end: "2026-12-31",
      minimum_term: "12 months",
      term_citation: citation(clause, 300),
    });
    expect(quoted).toContain(
      [
        "- **Term:**",
        "  - Start: 2026-01-01",
        "  - End: 2026-12-31",
        "  - Minimum term: 12 months",
        "    - **Verified quotation** (matched in the extracted contract text; it shows where this value comes from, not that this reading is correct):",
        "      > Membership starts on \\*1 January 2026\\* and lasts at least 12 months.",
        "- **Renewal:**",
      ].join("\n"),
    );
    expect(quoted).not.toContain("Minimum term: 12 months (**No verified quotation**)");
    // The quotation renders inside the minimum term's list item as a block quote.
    const tokens = allTokens(marked.lexer(quoted));
    expect(tokens.filter((token) => token.type === "blockquote")).toHaveLength(1);

    // A report stored before term quotations, an unverified one, one for another contract, and a
    // term stated only by its start, only by its end, or only by its minimum term.
    for (const [term, lines] of [
      [
        { start: "2026-01-01", end: "2026-12-31", minimum_term: "12 months" },
        ["2026-01-01", "2026-12-31", "12 months"],
      ],
      [
        { start: "2026-01-01", end: "2026-12-31", minimum_term: "12 months", term_citation: null },
        ["2026-01-01", "2026-12-31", "12 months"],
      ],
      [
        {
          start: "2026-01-01",
          end: "2026-12-31",
          minimum_term: "12 months",
          term_citation: { ...citation(clause), contract_id: "99999999-2222-4333-8444-555555555555" },
        },
        ["2026-01-01", "2026-12-31", "12 months"],
      ],
      [{ start: "2026-01-01", end: null, minimum_term: null }, ["2026-01-01", "Not specified", "Not specified"]],
      [{ start: null, end: "2026-12-31", minimum_term: null }, ["Not specified", "2026-12-31", "Not specified"]],
      [{ start: null, end: null, minimum_term: "12 months" }, ["Not specified", "Not specified", "12 months"]],
    ] as const) {
      const marked = withTerm(term);
      expect(marked).toContain(
        `- **Term:**\n  - Start: ${lines[0]}\n  - End: ${lines[1]}\n  - Minimum term: ${lines[2]} (**No verified quotation**)\n- **Renewal:**`,
      );
      expect(marked).not.toContain("lasts at least");
    }

    for (const unknown of [
      { start: null, end: null, minimum_term: null },
      { start: "Not specified", end: "Unknown", minimum_term: "N/A" },
    ]) {
      const marked = withTerm({ ...unknown, term_citation: citation(clause) });
      expect(marked).toContain(
        `- **Term:**\n  - Start: ${unknown.start ?? "Not specified"}\n  - End: ${unknown.end ?? "Not specified"}\n  - Minimum term: ${unknown.minimum_term ?? "Not specified"}\n- **Renewal:**`,
      );
      expect(marked).not.toContain("lasts at least");
    }
  });

  it("shows each penalty's own verified quotation, marks a penalty without one, and leaves none listed", () => {
    const withCancellation = (cancellation: Record<string, unknown>) =>
      section(
        brief({
          ...FULL_RESULT,
          summary: {
            ...FULL_RESULT.summary,
            cancellation: { how: "Write to the club.", notice_period_days: null, ...cancellation },
          },
        }).markdown,
        "Summary",
      );
    const earlyExit = "Early exit fee of two months' dues";
    const kit = "Unreturned kit is charged at *cost*";
    const earlyExitClause = "Leaving before the end of the term costs two months' dues.";
    const kitClause = "Kit not returned within 30 days is charged at cost.";

    const quoted = withCancellation({
      penalties: [earlyExit, kit],
      penalty_citations: [
        { penalty: kit, citation: citation(kitClause, 300) },
        { penalty: earlyExit, citation: citation(earlyExitClause, 200) },
      ],
    });
    expect(quoted).toContain(
      [
        "  - Penalties:",
        "    - Early exit fee of two months' dues",
        "      - **Verified quotation** (matched in the extracted contract text; it shows where this value comes from, not that this reading is correct):",
        `        > ${earlyExitClause}`,
        "    - Unreturned kit is charged at \\*cost\\*",
        "      - **Verified quotation** (matched in the extracted contract text; it shows where this value comes from, not that this reading is correct):",
        `        > ${kitClause}`,
      ].join("\n"),
    );
    // Up to the next heading: the Obligations section after it marks its own items.
    expect(quoted.split("\n### ")[0]).not.toMatch(/Penalties:[\s\S]*No verified quotation/);
    // Each quotation renders inside its own penalty's list item as a block quote.
    const tokens = allTokens(marked.lexer(quoted));
    expect(tokens.filter((token) => token.type === "blockquote")).toHaveLength(2);

    // One penalty quoted and the other not: the other is marked, never given its neighbour's quote.
    const one = withCancellation({
      penalties: [earlyExit, kit],
      penalty_citations: [{ penalty: kit, citation: citation(kitClause, 300) }],
    });
    expect(one).toContain(
      `  - Penalties:\n    - ${earlyExit} (**No verified quotation**)\n    - Unreturned kit`,
    );
    expect(one).not.toContain(earlyExitClause);

    // A report stored before penalty quotations, a citation for another contract, and one keyed by
    // different text.
    for (const cancellation of [
      { penalties: [earlyExit] },
      {
        penalties: [earlyExit],
        penalty_citations: [
          {
            penalty: earlyExit,
            citation: { ...citation(earlyExitClause), contract_id: "99999999-2222-4333-8444-555555555555" },
          },
        ],
      },
      {
        penalties: [earlyExit],
        penalty_citations: [{ penalty: earlyExit.toLowerCase(), citation: citation(earlyExitClause) }],
      },
    ]) {
      const marked = withCancellation(cancellation);
      expect(marked).toContain(`  - Penalties:\n    - ${earlyExit} (**No verified quotation**)\n`);
      expect(marked).not.toContain(earlyExitClause);
    }

    for (const none of [{ penalties: [] }, {}]) {
      const marked = withCancellation(none);
      expect(marked).toContain("  - Penalties: None listed");
      expect(marked.split("\n### ")[0]).not.toMatch(/Penalties:[\s\S]*No verified quotation/);
    }
  });

  it("shows each fee's own verified quotation beside the payment's, marks a fee without one, and leaves none listed", () => {
    const withPayments = (payments: Record<string, unknown>) =>
      section(
        brief({
          ...FULL_RESULT,
          summary: { ...FULL_RESULT.summary, payments },
        }).markdown,
        "Summary",
      );
    const late = "Late payment fee of *£10*";
    const joining = "Joining fee of £20";
    const lateClause = "Payments received after the 5th are charged a £10 late fee.";
    const joiningClause = "New members pay a one-off joining fee of £20.";
    const paymentClause = "Members pay £45 each month by direct debit.";

    const quoted = withPayments({
      amount: "£45",
      frequency: "Monthly",
      payment_citation: citation(paymentClause, 50),
      fees: [joining, late],
      fee_citations: [
        { fee: late, citation: citation(lateClause, 300) },
        { fee: joining, citation: citation(joiningClause, 200) },
      ],
    });
    expect(quoted).toContain(
      [
        "- **Payments:**",
        "  - Amount: £45",
        "  - Frequency: Monthly",
        "    - **Verified quotation** (matched in the extracted contract text; it shows where this value comes from, not that this reading is correct):",
        `      > ${paymentClause}`,
        "  - Fees:",
        `    - ${joining}`,
        "      - **Verified quotation** (matched in the extracted contract text; it shows where this value comes from, not that this reading is correct):",
        `        > ${joiningClause}`,
        "    - Late payment fee of \\*£10\\*",
        "      - **Verified quotation** (matched in the extracted contract text; it shows where this value comes from, not that this reading is correct):",
        `        > ${lateClause}`,
        "- **Term:**",
      ].join("\n"),
    );
    expect(quoted).not.toMatch(/Payments:[\s\S]*No verified quotation[\s\S]*Term:/);
    // The payment's and each fee's quotation render as their own block quotes.
    const tokens = allTokens(marked.lexer(quoted));
    expect(tokens.filter((token) => token.type === "blockquote")).toHaveLength(3);

    // One fee quoted and the other not: the other is marked, never given its neighbour's quote.
    const one = withPayments({
      amount: "£45",
      frequency: "Monthly",
      fees: [joining, late],
      fee_citations: [{ fee: late, citation: citation(lateClause, 300) }],
    });
    expect(one).toContain(`  - Fees:\n    - ${joining} (**No verified quotation**)\n    - Late payment fee`);
    expect(one).not.toContain(joiningClause);

    // A report stored before fee quotations, a citation for another contract, one keyed by
    // different text, and one stored under the penalties' key.
    for (const payments of [
      { fees: [joining] },
      {
        fees: [joining],
        fee_citations: [
          {
            fee: joining,
            citation: { ...citation(joiningClause), contract_id: "99999999-2222-4333-8444-555555555555" },
          },
        ],
      },
      { fees: [joining], fee_citations: [{ fee: joining.toLowerCase(), citation: citation(joiningClause) }] },
      { fees: [joining], fee_citations: [{ penalty: joining, citation: citation(joiningClause) }] },
    ]) {
      const marked = withPayments({ amount: null, frequency: null, ...payments });
      expect(marked).toContain(`  - Fees:\n    - ${joining} (**No verified quotation**)\n`);
      expect(marked).not.toContain(joiningClause);
    }

    for (const none of [{ fees: [] }, {}]) {
      const marked = withPayments({ amount: null, frequency: null, ...none });
      expect(marked).toContain("  - Fees: None listed");
      expect(marked).not.toMatch(/Fees:[^\n]*No verified quotation/);
    }
  });

  it("shows each obligation's own verified quotation, marks an obligation without one, and leaves none identified", () => {
    const obligationsOf = (fields: Record<string, unknown>) => {
      const summary = section(brief({ ...FULL_RESULT, ...fields }).markdown, "Summary");
      return summary.slice(
        summary.indexOf("### Obligations"),
        summary.indexOf("### Parties"),
      );
    };
    const pay = "Pay monthly dues by *direct debit*";
    const kit = "Return club kit when leaving";
    const payClause = "The Member pays the monthly dues by direct debit.";
    const kitClause = "On leaving, the Member returns all club kit within 30 days.";

    const quoted = obligationsOf({
      obligations: [pay, kit],
      obligation_citations: [
        { obligation: kit, citation: citation(kitClause, 300) },
        { obligation: pay, citation: citation(payClause, 200) },
      ],
    });
    expect(quoted).toBe(
      [
        "### Obligations",
        "",
        "- Pay monthly dues by \\*direct debit\\*",
        "  - **Verified quotation** (matched in the extracted contract text; it shows where this value comes from, not that this reading is correct):",
        `    > ${payClause}`,
        `- ${kit}`,
        "  - **Verified quotation** (matched in the extracted contract text; it shows where this value comes from, not that this reading is correct):",
        `    > ${kitClause}`,
        "",
        "",
      ].join("\n"),
    );
    // Each quotation renders inside its own obligation's list item as a block quote.
    const tokens = allTokens(marked.lexer(quoted));
    expect(tokens.filter((token) => token.type === "blockquote")).toHaveLength(2);
    expect(tokens.filter((token) => token.type === "list_item")).toHaveLength(4);

    // One obligation quoted and the other not: the other is marked, never given its neighbour's quote.
    const one = obligationsOf({
      obligations: [kit, pay],
      obligation_citations: [{ obligation: pay, citation: citation(payClause, 200) }],
    });
    expect(one).toContain(`- ${kit} (**No verified quotation**)\n- Pay monthly dues`);
    expect(one).not.toContain(kitClause);

    // A report stored before obligation quotations, a citation for another contract, one keyed by
    // different text, and one stored under the fees' key.
    for (const fields of [
      { obligations: [kit] },
      {
        obligations: [kit],
        obligation_citations: [
          {
            obligation: kit,
            citation: { ...citation(kitClause), contract_id: "99999999-2222-4333-8444-555555555555" },
          },
        ],
      },
      { obligations: [kit], obligation_citations: [{ obligation: kit.toLowerCase(), citation: citation(kitClause) }] },
      { obligations: [kit], obligation_citations: [{ fee: kit, citation: citation(kitClause) }] },
    ]) {
      const marked = obligationsOf(fields);
      expect(marked).toBe(`### Obligations\n\n- ${kit} (**No verified quotation**)\n\n`);
    }

    for (const none of [{ obligations: [] }, { obligations: undefined }]) {
      expect(obligationsOf(none)).toBe("### Obligations\n\nNone identified in this analysis.\n\n");
    }
  });

  it("shows each key date's own verified quotation, marks a date without one, and leaves none identified", () => {
    const datesOf = (fields: Record<string, unknown>) => {
      const summary = section(brief({ ...FULL_RESULT, ...fields }).markdown, "Summary");
      return summary.slice(
        summary.indexOf("### Key dates"),
        summary.indexOf("### Obligations"),
      );
    };
    const renewal = { type: "RENEWAL", date: "2026-12-31", derived_from: "End of the first year" };
    const cutoff = { type: "NOTICE_CUTOFF", date: "2026-11-30", derived_from: "One month before renewal" };
    const renewalClause = "The membership renews on 31 December 2026 for a further year.";
    const cutoffClause = "The Member may cancel with one calendar month's notice before renewal.";
    const caveat =
      "  - **Verified quotation** (matched in the extracted contract text; it shows which clause this date comes from, not that the date was worked out correctly):";

    const quoted = datesOf({
      key_dates: [renewal, cutoff],
      key_date_citations: [
        { type: cutoff.type, date: cutoff.date, citation: citation(cutoffClause, 300) },
        { type: renewal.type, date: renewal.date, citation: citation(renewalClause, 200) },
      ],
    });
    expect(quoted).toBe(
      [
        "### Key dates",
        "",
        "- **Renewal:** 2026-12-31 (from: End of the first year)",
        caveat,
        `    > ${renewalClause}`,
        "- **Notice cutoff:** 2026-11-30 (from: One month before renewal)",
        caveat,
        `    > ${cutoffClause}`,
        "",
        "",
      ].join("\n"),
    );
    // Each quotation renders inside its own date's list item as a block quote.
    const tokens = allTokens(marked.lexer(quoted));
    expect(tokens.filter((token) => token.type === "blockquote")).toHaveLength(2);
    expect(tokens.filter((token) => token.type === "list_item")).toHaveLength(4);

    // Two dates of the same type, or the same date of two types: only the exact date is quoted.
    const later = { type: "RENEWAL", date: "2027-12-31", derived_from: null };
    const sameDay = { type: "OTHER", date: renewal.date, derived_from: null };
    const one = datesOf({
      key_dates: [later, sameDay, renewal],
      key_date_citations: [
        { type: renewal.type, date: renewal.date, citation: citation(renewalClause, 200) },
      ],
    });
    expect(one).toContain(
      "- **Renewal:** 2027-12-31 (**No verified quotation**)\n- **Other:** 2026-12-31 (**No verified quotation**)\n- **Renewal:** 2026-12-31 (from: End of the first year)\n",
    );
    expect(one.match(/> /g)).toHaveLength(1);

    // A report stored before key-date quotations, a citation for another contract, one keyed by
    // another type or date, and one stored under the obligations' key.
    for (const fields of [
      { key_dates: [cutoff] },
      {
        key_dates: [cutoff],
        key_date_citations: [
          {
            type: cutoff.type,
            date: cutoff.date,
            citation: { ...citation(cutoffClause), contract_id: "99999999-2222-4333-8444-555555555555" },
          },
        ],
      },
      {
        key_dates: [cutoff],
        key_date_citations: [
          { type: "RENEWAL", date: cutoff.date, citation: citation(cutoffClause) },
          { type: cutoff.type, date: "2026-11-29", citation: citation(cutoffClause) },
        ],
      },
      {
        key_dates: [cutoff],
        obligation_citations: [{ obligation: cutoff.date, citation: citation(cutoffClause) }],
      },
    ]) {
      const marked = datesOf(fields);
      expect(marked).toContain(
        "- **Notice cutoff:** 2026-11-30 (from: One month before renewal) (**No verified quotation**)",
      );
      expect(marked).not.toContain(cutoffClause);
    }

    // No key dates keeps the unchanged text.
    expect(datesOf({ key_dates: [] })).toBe("### Key dates\n\nNone identified in this analysis.\n\n");
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
          evidence: { quote: "the laws of Scotland", segment: "section-3" },
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

describe("renderAnalysisBriefMarkdown: Before you sign", () => {
  const CLARIFY = "Before you sign: what to clarify";

  it("lists coverage gaps, unverified and unstated facts, findings by severity and the questions, in that order", () => {
    const { markdown } = brief(
      {
        ...FULL_RESULT,
        summary: {
          ...FULL_RESULT.summary,
          // Payment is not stated; the rest of the summary has no citations.
          payments: { amount: null, frequency: null, fees: ["Joining fee of £20"] },
        },
      },
      { contract: { extractionWarning: "Scanned pages were read with OCR and may contain errors." } },
    );
    const clarify = section(markdown, CLARIFY);

    expect(clarify.trim().split("\n")).toEqual([
      `## ${CLARIFY}`,
      "",
      "Built from this analysis. Each entry points to the full fact or finding in the sections below.",
      "",
      "### Coverage gaps",
      "",
      "- **Text extraction:** Scanned pages were read with OCR and may contain errors.",
      "- **Analysis coverage:** Only part of this contract was analysed: the middle pages were skipped.",
      "",
      "### Stated without a verified quotation",
      "",
      "- **Notice period:** one calendar month (No verified quotation)",
      "- **Renewal:** Auto-renews, period 12 months (No verified quotation)",
      "- **Term:** 12 months, starts 2026-01-01, ends 2026-12-31 (No verified quotation)",
      "- **Fee:** Joining fee of £20 (No verified quotation)",
      "- **Penalty:** Early exit fee of two months' dues (No verified quotation)",
      "- **Obligation:** Pay monthly dues (No verified quotation)",
      "- **Key date:** Notice cutoff: 2026-11-30 (No verified quotation)",
      "",
      "### Not stated",
      "",
      "- **Payment:** Not specified",
      "",
      "### Findings",
      "",
      "- **Finding 1:** Auto-renewal (severity 7/10)",
      "- **Finding 3:** Liability (severity 7/10)",
      "- **Finding 2:** Price increase (severity not provided)",
      "",
      "### Questions to ask",
      "",
      "Suggested by the analysis. Review and adapt them before you use them.",
      "",
      "1. Can the renewal be switched off?",
    ]);
    // The findings it points to keep their numbers.
    expect(section(markdown, "Findings")).toContain("### 3. Liability");
  });

  it("says every stated fact is quoted only when coverage is full, and never that there is nothing to clarify", () => {
    const quoted = {
      source: SOURCE,
      summary: {
        what_it_is: "A gym membership agreement.",
        payments: { amount: "£45", frequency: "Monthly", fees: [], payment_citation: citation("£45 a month") },
        term: { start: null, end: null, minimum_term: "12 months", term_citation: citation("twelve months") },
        renewal: { auto_renew: true, renewal_period: null, renewal_citation: citation("renews") },
        cancellation: {
          how: "Write to the club.",
          notice_period_days: 30,
          notice_period_text: null,
          penalties: [],
          notice_citation: citation("30 days"),
        },
      },
      red_flags: [],
      key_dates: [],
      obligations: [],
      parties: [],
      key_points: [],
      coverage_notices: [],
      next_actions: { questions_to_ask: [], email_templates: [] },
    };
    const full = section(brief(quoted).markdown, CLARIFY);
    expect(full).toContain("\nEvery stated fact has a verified quotation.\n");
    expect(full).not.toContain("### Stated without a verified quotation");
    expect(full).not.toContain("### Not stated");
    expect(full).not.toMatch(/nothing to clarify/i);

    const partial = section(
      brief({ ...quoted, coverage_notices: ["Only part of this contract was analysed."] }).markdown,
      CLARIFY,
    );
    expect(partial).toContain("- **Analysis coverage:** Only part of this contract was analysed.");
    expect(partial).toContain(
      "Every stated fact has a verified quotation in the text this analysis read. The coverage gaps above may hide facts it did not see.",
    );
    expect(partial).not.toContain("\nEvery stated fact has a verified quotation.\n");
  });

  it("lists each stated fact of an analysis from before quotations without throwing", () => {
    const legacy = { ...FULL_RESULT } as Record<string, unknown>;
    delete legacy.source;
    let markdown = "";
    expect(() => {
      markdown = brief(legacy).markdown;
    }).not.toThrow();
    const clarify = section(markdown, CLARIFY);
    expect(clarify.match(/\(No verified quotation\)$/gm)).toHaveLength(8);
    expect(clarify).not.toContain("Every stated fact has a verified quotation");
  });

  it("escapes model text and lists the questions exactly once", () => {
    const { markdown } = brief({
      ...FULL_RESULT,
      next_actions: {
        questions_to_ask: ["# Is the **renewal** optional?", "Who pays [fees](https://evil.example)?"],
        email_templates: [],
      },
    });
    const clarify = section(markdown, CLARIFY);
    expect(clarify).toContain("1. \\# Is the \\*\\*renewal\\*\\* optional?");
    expect(clarify).toContain("2. Who pays \\[fees\\](https://evil.example)?");
    expect(markdown.match(/Questions to ask/g)).toHaveLength(1);
    expect(markdown.match(/Is the \\\*\\\*renewal/g)).toHaveLength(1);

    const tokens = allTokens(marked.lexer(clarify));
    expect(tokens.filter((token) => token.type === "heading").map((token) => "text" in token && token.text))
      .not.toContain("Is the **renewal** optional?");
    for (const strong of tokens.filter((token) => token.type === "strong")) {
      expect("text" in strong && strong.text).not.toMatch(/renewal\b/);
    }
    // A bare URL may still autolink, but only as itself: the bracketed text never becomes a link.
    for (const link of tokens.filter((token) => token.type === "link")) {
      expect("text" in link && link.text).toBe("https://evil.example");
    }
  });
});
