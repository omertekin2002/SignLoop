import type { AnalysisResult } from "@/lib/schemas";
import { formatNoticePeriod } from "@/lib/notice-period";
import { regionalComparisonsView } from "@/lib/regional-comparisons";
import {
  citationForReport,
  JURISDICTION_CITATION,
  SourceRevisionSchema,
  type CitationRef,
} from "@/lib/source-citations";
import { formatDate, isRecord } from "@/lib/utils";

/** The stored disclaimer's schema default, for reports saved without one. */
const DEFAULT_DISCLAIMER = "This is an AI analysis, not legal advice.";
const NOT_SPECIFIED = "Not specified";
const KEY_DATE_LABELS: Record<string, string> = {
  RENEWAL: "Renewal",
  NOTICE_CUTOFF: "Notice cutoff",
  PRICE_REVIEW: "Price review",
  OTHER: "Other",
};

export type AnalysisBriefInput = {
  /** What the contract page already holds; `id` checks that citations belong to this contract. */
  contract: {
    id: string;
    title?: string | null;
    status?: string | null;
    extractionWarning?: string | null;
  };
  analysis: {
    createdAt?: string | Date | null;
    riskBadge?: string | null;
    resultJson?: Partial<AnalysisResult> | null;
  };
  /** True when a newer analysis of this contract exists. */
  historical?: boolean;
  /** IANA zone for dates; the runtime's local zone when omitted, as the page shows them. */
  timeZone?: string;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function texts(values: unknown): string[] {
  return Array.isArray(values)
    ? values.map(text).filter((value): value is string => value !== null)
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

// Backslash escapes work for every ASCII punctuation character in CommonMark. These are the ones
// that can start emphasis, code, links, HTML, tables, strikethrough or math anywhere in a line.
const INLINE_SIGNIFICANT = /[\\`*_[\]<>#|~$]/g;

/** One line of contract or model text, made inert wherever it lands in the brief. */
function escapeLine(line: string): string {
  return (
    line
      // Leading indentation would start a code block inside a quote or list item.
      .trimStart()
      .replace(INLINE_SIGNIFICANT, "\\$&")
      // An entity such as &copy; would render as a different character.
      .replace(/&(?=#?[a-z0-9]+;)/gi, "\\&")
      // A line that opens with a list marker or a setext underline changes the block structure.
      .replace(/^([-+=])/, "\\$1")
      .replace(/^(\d+)([.)])/, "$1\\$2")
  );
}

/** Text placed on one line: a heading, a list item, or after a label. */
function inline(value: string): string {
  return escapeLine(value.replace(/\s+/g, " ").trim());
}

function blockquote(value: string): string[] {
  return value
    .trim()
    .split(/\r\n?|\n/)
    .map((line) => (line.trim() ? `> ${escapeLine(line)}` : ">"));
}

/** A fence longer than any backtick run in the text, so the text cannot close it. */
function fenced(value: string): string[] {
  const longestRun = Math.max(
    0,
    ...(value.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [`${fence}text`, ...value.trim().split(/\r\n?|\n/), fence];
}

function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 60)
      .replace(/^-+|-+$/g, "") || "contract"
  );
}

/**
 * The quotation behind a finding or the governing-law proposal. It counts as verified only when
 * the page would offer it as a source match: a verified citation for this contract and for the
 * revision the report was analysed against. A model proposal without one is shown as unverified.
 */
function quotation(
  result: Partial<AnalysisResult>,
  contractId: string,
  ref: CitationRef,
  cited: unknown,
): string[] {
  const verified = citationForReport(result, contractId, ref);
  if (verified) {
    return [
      "**Verified quotation** (matched in the extracted contract text; this confirms the wording, not the interpretation):",
      "",
      ...blockquote(verified.quote),
    ];
  }
  const proposed = text(record(record(cited).evidence).quote);
  return proposed
    ? [
        "**Unverified quotation** (proposed by the analysis, not matched in the extracted contract text):",
        "",
        ...blockquote(proposed),
      ]
    : [];
}

function bulletList(values: string[], indent = ""): string[] {
  return values.map((value) => `${indent}- ${inline(value)}`);
}

function labelled(label: string, value: string | null): string {
  return `- **${label}:** ${value === null ? NOT_SPECIFIED : inline(value)}`;
}

function identitySection(input: AnalysisBriefInput, title: string): string[] {
  const result = input.analysis.resultJson ?? {};
  const risk =
    text(input.analysis.riskBadge) ?? text(result.risk_badge) ?? "UNKNOWN";
  const revision = SourceRevisionSchema.safeParse(record(result.source).revision);
  const lines = [
    `# Decision brief: ${inline(title)}`,
    "",
    labelled("Contract", title),
    labelled(
      "Analyzed",
      formatDate(input.analysis.createdAt, "MMM d, yyyy HH:mm", "", input.timeZone) ||
        "Unknown date",
    ),
    `- **Risk level:** ${inline(risk)}`,
  ];
  // The schema restricts a revision to "sha256:" and hex digits, so a code span is safe.
  if (revision.success) lines.push(`- **Source revision:** \`${revision.data}\``);
  if (input.contract.status !== "ANALYZED") {
    lines.push(
      "",
      "**Outdated analysis.** This analysis uses older evidence. The contract or project context has changed; analyze again for a current result.",
    );
  }
  if (input.historical) {
    lines.push(
      "",
      "**Earlier analysis.** A newer analysis of this contract exists.",
    );
  }
  return lines;
}

function coverageSection(
  extractionWarning: string | null,
  reportNotices: string[],
): string[] {
  const lines = ["## Coverage", ""];
  if (extractionWarning) {
    lines.push(`- **Text extraction:** ${inline(extractionWarning)}`);
  }
  if (reportNotices.length) {
    lines.push("- **Analysis coverage:**", ...bulletList(reportNotices, "  "));
  }
  if (!extractionWarning && !reportNotices.length) {
    lines.push("No extraction or coverage notices were recorded for this analysis.");
  }
  return lines;
}

function jurisdictionSection(
  result: Partial<AnalysisResult>,
  contractId: string,
): string[] {
  const ranWith = text(result.comparison_jurisdiction);
  const proposed = text(record(result.proposed_jurisdiction).jurisdiction);
  const lines = ["## Jurisdiction", ""];
  if (ranWith) {
    lines.push(`**Confirmed:** ${inline(ranWith)} (confirmed when this analysis ran).`);
    if (proposed && proposed !== ranWith) {
      lines.push("", `The governing-law clause names ${inline(proposed)}.`);
    }
  } else if (proposed) {
    lines.push(
      `**Proposed, not confirmed:** ${inline(proposed)}, named by the governing-law clause.`,
    );
  } else {
    lines.push("**Not confirmed.** No jurisdiction was confirmed when this analysis ran.");
  }
  if (proposed) {
    const quote = quotation(
      result,
      contractId,
      JURISDICTION_CITATION,
      result.proposed_jurisdiction,
    );
    if (quote.length) lines.push("", ...quote);
  }

  const comparisons = regionalComparisonsView(result);
  if (comparisons?.status === "withheld") {
    lines.push(
      "",
      "Regional comparisons are not included: no jurisdiction was confirmed when this analysis ran, and what is typical or allowed depends on where the contract applies. This analysis describes risks from the contract text alone.",
    );
  } else if (comparisons) {
    lines.push(
      "",
      "### Regional comparisons",
      "",
      comparisons.status === "confirmed"
        ? "Compared with typical practice in the confirmed jurisdiction. General information, not legal advice."
        : "Generated without a confirmed jurisdiction. Treat as general information, not local law.",
      "",
    );
    for (const item of comparisons.items) {
      const topic = text(item.topic) ?? "Comparison";
      const label = text(item.label);
      const where = text(item.jurisdiction);
      lines.push(
        `- **${inline(topic)}**${label ? ` (${inline(label)})` : ""}`,
        ...(where ? [`  - Jurisdiction: ${inline(where)}`] : []),
        `  - Typical: ${inline(text(item.typical_range) ?? NOT_SPECIFIED)}`,
        `  - Your contract: ${inline(text(item.yours) ?? NOT_SPECIFIED)}`,
      );
    }
  }
  return lines;
}

function summarySection(
  result: Partial<AnalysisResult>,
  keyPoints: string[],
): string[] {
  const summary = record(result.summary);
  const payments = record(summary.payments);
  const term = record(summary.term);
  const renewal = record(summary.renewal);
  const cancellation = record(summary.cancellation);
  const fees = texts(payments.fees);
  const penalties = texts(cancellation.penalties);
  const autoRenew =
    renewal.auto_renew === true
      ? "Auto-renews"
      : renewal.auto_renew === false
        ? "Does not auto-renew"
        : "Unknown";
  const keyDates = (Array.isArray(result.key_dates) ? result.key_dates : [])
    .map(record)
    .filter((date) => text(date.date));
  const obligations = texts(result.obligations);
  const parties = texts(result.parties);

  const lines = ["## Summary", "", labelled("What it is", text(summary.what_it_is))];
  lines.push(
    "- **Payments:**",
    `  - Amount: ${inline(text(payments.amount) ?? NOT_SPECIFIED)}`,
    `  - Frequency: ${inline(text(payments.frequency) ?? NOT_SPECIFIED)}`,
    fees.length ? "  - Fees:" : "  - Fees: None listed",
    ...bulletList(fees, "    "),
    "- **Term:**",
    `  - Start: ${inline(text(term.start) ?? NOT_SPECIFIED)}`,
    `  - End: ${inline(text(term.end) ?? NOT_SPECIFIED)}`,
    `  - Minimum term: ${inline(text(term.minimum_term) ?? NOT_SPECIFIED)}`,
    "- **Renewal:**",
    `  - Automatic renewal: ${autoRenew}`,
    `  - Renewal period: ${inline(text(renewal.renewal_period) ?? NOT_SPECIFIED)}`,
    "- **Cancellation:**",
    `  - How to cancel: ${inline(text(cancellation.how) ?? NOT_SPECIFIED)}`,
    `  - Notice period: ${inline(
      formatNoticePeriod({
        notice_period_days:
          typeof cancellation.notice_period_days === "number"
            ? cancellation.notice_period_days
            : null,
        notice_period_text: text(cancellation.notice_period_text),
      }),
    )}`,
    penalties.length ? "  - Penalties:" : "  - Penalties: None listed",
    ...bulletList(penalties, "    "),
  );

  if (keyPoints.length) {
    lines.push("", "### Key points", "", ...bulletList(keyPoints));
  }
  lines.push("", "### Key dates", "");
  if (keyDates.length) {
    for (const date of keyDates) {
      const type = KEY_DATE_LABELS[String(date.type)] ?? "Date";
      const from = text(date.derived_from);
      lines.push(
        `- **${type}:** ${inline(text(date.date)!)}${from ? ` (from: ${inline(from)})` : ""}`,
      );
    }
  } else {
    lines.push("None identified in this analysis.");
  }
  lines.push("", "### Obligations", "");
  lines.push(...(obligations.length ? bulletList(obligations) : ["None identified in this analysis."]));
  lines.push("", "### Parties", "");
  lines.push(...(parties.length ? bulletList(parties) : ["None identified in this analysis."]));
  return lines;
}

function findingsSection(
  result: Partial<AnalysisResult>,
  contractId: string,
): string[] {
  const flags = Array.isArray(result.red_flags) ? result.red_flags : [];
  const lines = ["## Findings", ""];
  if (!flags.length) {
    lines.push("No red flags were identified in this analysis.");
    return lines;
  }
  flags.forEach((value, index) => {
    const flag = record(value);
    const severity =
      typeof flag.severity === "number" && Number.isFinite(flag.severity)
        ? Math.max(0, Math.min(10, flag.severity))
        : null;
    const confidence =
      typeof flag.confidence === "number" && Number.isFinite(flag.confidence)
        ? flag.confidence
        : null;
    const where = text(flag.where);
    if (index > 0) lines.push("");
    lines.push(
      `### ${index + 1}. ${inline(text(flag.type) ?? "Risk")}`,
      "",
      `- **Severity:** ${severity === null ? "Not provided" : `${severity}/10`}`,
      `- **Confidence:** ${confidence === null ? "Not provided" : `${confidence}%`}`,
      ...(where ? [`- **Found in:** ${inline(where)}`] : []),
      "",
      inline(text(flag.explanation) ?? "No explanation provided."),
    );
    const quote = quotation(result, contractId, index, flag);
    lines.push("", ...(quote.length ? quote : ["No source quotation."]));
  });
  return lines;
}

function nextStepsSection(result: Partial<AnalysisResult>): string[] {
  const actions = record(result.next_actions);
  const questions = texts(actions.questions_to_ask);
  const emails = (Array.isArray(actions.email_templates) ? actions.email_templates : [])
    .map(record)
    .filter((email) => text(email.subject) || text(email.body));
  const lines = ["## Next steps", ""];
  if (!questions.length && !emails.length) {
    lines.push("No next steps were suggested in this analysis.");
    return lines;
  }
  lines.push(
    "These are drafts generated by the analysis. Review and adapt them before you use them.",
  );
  if (questions.length) {
    lines.push(
      "",
      "### Questions to ask",
      "",
      ...questions.map((question, index) => `${index + 1}. ${inline(question)}`),
    );
  }
  if (emails.length) {
    lines.push("", "### Draft emails");
    emails.forEach((email, index) => {
      const body = text(email.body);
      lines.push(
        "",
        `#### Draft ${index + 1}: ${inline(text(email.subject) ?? "Untitled")}`,
        "",
        ...(body ? fenced(body) : ["No body provided."]),
      );
    });
  }
  return lines;
}

/**
 * The stored analysis as a portable Markdown decision brief. Pure: it reads only its input and
 * runs no inference. Every piece of contract or model text is escaped, so it cannot change the
 * brief's structure, and the coverage notices and extraction warning are never dropped.
 */
export function renderAnalysisBriefMarkdown(input: AnalysisBriefInput): {
  filename: string;
  markdown: string;
} {
  const result = input.analysis.resultJson ?? {};
  const contractId = input.contract.id;
  const title = text(input.contract.title) ?? "Untitled contract";
  const coverageNotices = texts(result.coverage_notices);
  const extractionWarning = text(input.contract.extractionWarning);
  // The same de-duplication as the page: the current extraction warning is listed once.
  const reportNotices = [...new Set(coverageNotices)].filter(
    (notice) => notice !== extractionWarning,
  );
  const keyPoints = texts(result.key_points).filter(
    (point) => !coverageNotices.includes(point),
  );

  const sections = [
    identitySection(input, title),
    coverageSection(extractionWarning, reportNotices),
    jurisdictionSection(result, contractId),
    summarySection(result, keyPoints),
    findingsSection(result, contractId),
    nextStepsSection(result),
    [
      "---",
      "",
      `**Disclaimer:** ${inline(text(result.disclaimer) ?? DEFAULT_DISCLAIMER)}`,
      "",
      "Exported from SignLoop's stored analysis. No new analysis was run to produce this brief.",
    ],
  ];
  const date = formatDate(input.analysis.createdAt, "yyyy-MM-dd", "", input.timeZone);
  return {
    filename: `signloop-brief-${slug(title)}${date ? `-${date}` : ""}.md`,
    markdown: `${sections.map((section) => section.join("\n")).join("\n\n")}\n`,
  };
}
