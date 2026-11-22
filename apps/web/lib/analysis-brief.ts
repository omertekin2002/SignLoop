import type { AnalysisResult } from "@/lib/schemas";
import { formatNoticePeriod, isNoticePeriodStated } from "@/lib/notice-period";
import { formatAutoRenew, isRenewalStated } from "@/lib/renewal";
import { isPaymentStated } from "@/lib/payment";
import { isTermStated } from "@/lib/term";
import {
  LISTED_FEES,
  LISTED_OBLIGATIONS,
  LISTED_PENALTIES,
  listedCitationRef,
  type KnownListedFact,
} from "@/lib/listed-citations";
import { keyDateCitationRef } from "@/lib/key-date-citations";
import {
  clarifyBeforeSigning,
  KEY_DATE_LABELS,
  NO_VERIFIED_QUOTATION,
  NOT_SPECIFIED,
  quotationStatusLine,
} from "@/lib/analysis-clarify";
import { regionalComparisonsView } from "@/lib/regional-comparisons";
import {
  citationForReport,
  JURISDICTION_CITATION,
  NOTICE_CITATION,
  PAYMENT_CITATION,
  RENEWAL_CITATION,
  SourceRevisionSchema,
  TERM_CITATION,
  type CitationRef,
} from "@/lib/source-citations";
import { formatDate, isRecord } from "@/lib/utils";

/** The stored disclaimer's schema default, for reports saved without one. */
const DEFAULT_DISCLAIMER = "This is an AI analysis, not legal advice.";

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

/**
 * A summary fact's line with its evidence: the verified quotation of the clause stating it, a marker
 * when a stated fact has none, or the line alone when the fact is unknown.
 */
function quotedFactLines(
  line: string,
  stated: boolean,
  result: Partial<AnalysisResult>,
  contractId: string,
  ref: CitationRef,
  indent = "    ",
  caveat = "it shows where this value comes from, not that this reading is correct",
): string[] {
  if (!stated) return [line];
  const cited = citationForReport(result, contractId, ref);
  if (!cited) return [`${line} (**${NO_VERIFIED_QUOTATION}**)`];
  return [
    line,
    `${indent}- **Verified quotation** (matched in the extracted contract text; ${caveat}):`,
    ...blockquote(cited.quote).map((quoted) => `${indent}  ${quoted}`),
  ];
}

/**
 * A cited list's items with their evidence: each item as a bullet at `indent`, then the verified
 * quotation of the clause stating that item or a marker on its line. Empty when none are listed.
 */
function listedItemLines(
  result: Partial<AnalysisResult>,
  container: Record<string, unknown>,
  fact: KnownListedFact,
  contractId: string,
  indent: string,
): string[] {
  const listed = container[fact.list];
  return (Array.isArray(listed) ? listed : []).flatMap(
    (item: unknown, index) => {
      const value = text(item);
      return value
        ? quotedFactLines(
            `${indent}- ${inline(value)}`,
            true,
            result,
            contractId,
            listedCitationRef(fact, index),
            `${indent}  `,
          )
        : [];
    },
  );
}

/**
 * A cited summary list (cancellation penalties, fees) under its label line, with each item's
 * evidence (`listedItemLines`) at `itemIndent`. None listed keeps its unchanged wording.
 */
function listedLines(
  result: Partial<AnalysisResult>,
  group: Record<string, unknown>,
  fact: KnownListedFact,
  label: string,
  contractId: string,
  itemIndent: string,
): string[] {
  const items = listedItemLines(result, group, fact, contractId, itemIndent);
  return items.length ? [label, ...items] : [`${label} None listed`];
}

/** The notice period with its evidence, or the unchanged "Not specified" when none is stated. */
function noticePeriodLines(
  result: Partial<AnalysisResult>,
  cancellation: Record<string, unknown>,
  contractId: string,
): string[] {
  const notice = {
    notice_period_days:
      typeof cancellation.notice_period_days === "number"
        ? cancellation.notice_period_days
        : null,
    notice_period_text: text(cancellation.notice_period_text),
  };
  return quotedFactLines(
    `  - Notice period: ${inline(formatNoticePeriod(notice))}`,
    isNoticePeriodStated(notice),
    result,
    contractId,
    NOTICE_CITATION,
  );
}

/**
 * Renewal with its evidence: both lines, then the verified quotation of the clause stating them or
 * a marker on the period line. Unknown renewal keeps its unchanged lines.
 */
function renewalLines(
  result: Partial<AnalysisResult>,
  renewal: Record<string, unknown>,
  contractId: string,
): string[] {
  const lines = [
    `  - Automatic renewal: ${formatAutoRenew(renewal.auto_renew, "Unknown")}`,
    `  - Renewal period: ${inline(text(renewal.renewal_period) ?? NOT_SPECIFIED)}`,
  ];
  return [
    lines[0]!,
    ...quotedFactLines(
      lines[1]!,
      isRenewalStated(renewal),
      result,
      contractId,
      RENEWAL_CITATION,
    ),
  ];
}

/**
 * The payment amount and frequency with their evidence, as top-level lines of Payments and fees:
 * both lines, then the verified quotation of the clause stating them or a marker on the frequency
 * line. Unknown payment keeps its unchanged values. Each fee has its own quotation (`listedLines`).
 */
function paymentLines(
  result: Partial<AnalysisResult>,
  payments: Record<string, unknown>,
  contractId: string,
): string[] {
  const amount = text(payments.amount);
  const frequency = text(payments.frequency);
  return [
    `- **Amount:** ${inline(amount ?? NOT_SPECIFIED)}`,
    ...quotedFactLines(
      `- **Frequency:** ${inline(frequency ?? NOT_SPECIFIED)}`,
      isPaymentStated({ amount, frequency }),
      result,
      contractId,
      PAYMENT_CITATION,
      "  ",
    ),
  ];
}

/**
 * The term with its evidence: start, end and minimum term, then the verified quotation of the
 * clause stating the term or a marker on the minimum-term line. An unknown term keeps its unchanged
 * lines.
 */
function termLines(
  result: Partial<AnalysisResult>,
  term: Record<string, unknown>,
  contractId: string,
): string[] {
  const start = text(term.start);
  const end = text(term.end);
  const minimumTerm = text(term.minimum_term);
  return [
    `  - Start: ${inline(start ?? NOT_SPECIFIED)}`,
    `  - End: ${inline(end ?? NOT_SPECIFIED)}`,
    ...quotedFactLines(
      `  - Minimum term: ${inline(minimumTerm ?? NOT_SPECIFIED)}`,
      isTermStated({ start, end, minimum_term: minimumTerm }),
      result,
      contractId,
      TERM_CITATION,
    ),
  ];
}

/**
 * What the contract is: its description, parties and key points (without lines that repeat a
 * coverage notice). None of these has a citation slot, so none is marked as unquoted.
 */
function overviewSection(result: Partial<AnalysisResult>, keyPoints: string[]): string[] {
  const parties = texts(result.parties);
  const lines = [
    "## Overview",
    "",
    labelled("What it is", text(record(result.summary).what_it_is)),
    ...(parties.length
      ? ["- **Parties:**", ...bulletList(parties, "  ")]
      : ["- **Parties:** None identified in this analysis."]),
  ];
  if (keyPoints.length) {
    lines.push("- **Key points:**", ...bulletList(keyPoints, "  "));
  }
  return lines;
}

function paymentsSection(
  result: Partial<AnalysisResult>,
  contractId: string,
): string[] {
  const payments = record(record(result.summary).payments);
  return [
    "## Payments and fees",
    "",
    ...paymentLines(result, payments, contractId),
    ...listedLines(result, payments, LISTED_FEES, "- **Fees:**", contractId, "  "),
  ];
}

function termSection(
  result: Partial<AnalysisResult>,
  contractId: string,
): string[] {
  const summary = record(result.summary);
  const cancellation = record(summary.cancellation);
  return [
    "## Term, renewal and how it ends",
    "",
    "- **Term:**",
    ...termLines(result, record(summary.term), contractId),
    "- **Renewal:**",
    ...renewalLines(result, record(summary.renewal), contractId),
    "- **Cancellation:**",
    `  - How to cancel: ${inline(text(cancellation.how) ?? NOT_SPECIFIED)}`,
    ...noticePeriodLines(result, cancellation, contractId),
    ...listedLines(
      result,
      cancellation,
      LISTED_PENALTIES,
      "  - Penalties:",
      contractId,
      "    ",
    ),
  ];
}

/** Each obligation with its evidence. The analysis does not say which party owes it. */
function obligationsSection(
  result: Partial<AnalysisResult>,
  contractId: string,
): string[] {
  const obligations = listedItemLines(
    result,
    record(result),
    LISTED_OBLIGATIONS,
    contractId,
    "",
  );
  return [
    "## Obligations in the contract",
    "",
    "This analysis does not record which party owes each obligation.",
    "",
    ...(obligations.length ? obligations : ["None identified in this analysis."]),
  ];
}

/** Each key date with its evidence, for display only (no deadlines are derived from them). */
function keyDatesSection(
  result: Partial<AnalysisResult>,
  contractId: string,
): string[] {
  // Each date keeps its index in the stored list, which names its quotation (`key-date-<n>`).
  const keyDates = (Array.isArray(result.key_dates) ? result.key_dates : [])
    .map((date, index) => ({ date: record(date), index }))
    .filter(({ date }) => text(date.date));
  const lines = ["## Key dates", ""];
  if (!keyDates.length) {
    lines.push("None identified in this analysis.");
    return lines;
  }
  for (const { date, index } of keyDates) {
    const type = KEY_DATE_LABELS[String(date.type)] ?? "Date";
    const from = text(date.derived_from);
    lines.push(
      ...quotedFactLines(
        `- **${type}:** ${inline(text(date.date)!)}${from ? ` (from: ${inline(from)})` : ""}`,
        true,
        result,
        contractId,
        keyDateCitationRef(index),
        "  ",
        "it shows which clause this date comes from, not that the date was worked out correctly",
      ),
    );
  }
  return lines;
}

function findingsLines(
  result: Partial<AnalysisResult>,
  contractId: string,
): string[] {
  const flags = Array.isArray(result.red_flags) ? result.red_flags : [];
  const lines = ["### Findings", ""];
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
      `#### ${index + 1}. ${inline(text(flag.type) ?? "Risk")}`,
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

/** The analysis's draft emails. Its questions are in the checklist (`clarifySection`). */
function draftEmailLines(result: Partial<AnalysisResult>): string[] {
  const actions = record(result.next_actions);
  const emails = (Array.isArray(actions.email_templates) ? actions.email_templates : [])
    .map(record)
    .filter((email) => text(email.subject) || text(email.body));
  const lines = ["### Draft emails", ""];
  if (!emails.length) {
    lines.push("No draft emails were suggested in this analysis.");
    return lines;
  }
  lines.push(
    "These are drafts generated by the analysis. Review and adapt them before you use them.",
  );
  emails.forEach((email, index) => {
    const body = text(email.body);
    lines.push(
      "",
      `#### Draft ${index + 1}: ${inline(text(email.subject) ?? "Untitled")}`,
      "",
      ...(body ? fenced(body) : ["No body provided."]),
    );
  });
  return lines;
}

function findingsSection(
  result: Partial<AnalysisResult>,
  contractId: string,
): string[] {
  return [
    "## Findings and draft emails",
    "",
    ...findingsLines(result, contractId),
    "",
    ...draftEmailLines(result),
  ];
}

/**
 * What to clarify before signing (`clarifyBeforeSigning`), as one checklist: templated text and
 * escaped stored values only. It never says there is nothing to clarify, and lists every coverage
 * gap again even though the Coverage section above has them.
 */
function clarifySection(input: AnalysisBriefInput): string[] {
  const checklist = clarifyBeforeSigning({
    contractId: input.contract.id,
    extractionWarning: input.contract.extractionWarning,
    resultJson: input.analysis.resultJson,
  });
  const lines = [
    "## Before you sign: what to clarify",
    "",
    "Built from this analysis. Each entry points to the full fact or finding in the sections below.",
  ];
  if (checklist.coverageGaps.length) {
    lines.push(
      "",
      "### Coverage gaps",
      "",
      ...checklist.coverageGaps.map(
        (gap) => `- **${gap.label}:** ${inline(gap.text)}`,
      ),
    );
  }
  const status = quotationStatusLine(checklist);
  if (status) {
    lines.push("", status);
  } else if (checklist.unverified.length) {
    lines.push(
      "",
      "### Stated without a verified quotation",
      "",
      ...checklist.unverified.map(
        (fact) =>
          `- **${fact.fact}:** ${inline(fact.value)} (${NO_VERIFIED_QUOTATION})`,
      ),
    );
  }
  if (checklist.unstated.length) {
    lines.push(
      "",
      "### Not stated",
      "",
      ...checklist.unstated.map((fact) => `- **${fact.fact}:** ${NOT_SPECIFIED}`),
    );
  }
  if (checklist.findings.length) {
    lines.push(
      "",
      "### Findings",
      "",
      ...checklist.findings.map(
        (finding) =>
          `- **Finding ${finding.number}:** ${inline(finding.type)} (${
            finding.severity === null
              ? "severity not provided"
              : `severity ${finding.severity}/10`
          })`,
      ),
    );
  }
  if (checklist.questions.length) {
    lines.push(
      "",
      "### Questions to ask",
      "",
      "Suggested by the analysis. Review and adapt them before you use them.",
      "",
      ...checklist.questions.map(
        (question, index) => `${index + 1}. ${inline(question)}`,
      ),
    );
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
    overviewSection(result, keyPoints),
    coverageSection(extractionWarning, reportNotices),
    jurisdictionSection(result, contractId),
    clarifySection(input),
    paymentsSection(result, contractId),
    termSection(result, contractId),
    obligationsSection(result, contractId),
    keyDatesSection(result, contractId),
    findingsSection(result, contractId),
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
