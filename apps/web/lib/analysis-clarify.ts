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
  listedContainer,
  type KnownListedFact,
} from "@/lib/listed-citations";
import { keyDateCitationRef } from "@/lib/key-date-citations";
import {
  citationForReport,
  NOTICE_CITATION,
  PAYMENT_CITATION,
  RENEWAL_CITATION,
  TERM_CITATION,
  type CitationRef,
} from "@/lib/source-citations";
import { isSubstantiveText } from "@/lib/substantive-text";
import { isRecord } from "@/lib/utils";

/** The label beside a stated fact that has no verified quotation, as the summary marks it. */
export const NO_VERIFIED_QUOTATION = "No verified quotation";
/** The label for one of the four singular facts the analysis does not state. */
export const NOT_SPECIFIED = "Not specified";

/** How a key date's stored type reads in the brief and the checklist. */
export const KEY_DATE_LABELS: Record<string, string> = {
  RENEWAL: "Renewal",
  NOTICE_CUTOFF: "Notice cutoff",
  PRICE_REVIEW: "Price review",
  OTHER: "Other",
};

export type ClarifyCoverageGap = {
  /** "Text extraction" for the contract's extraction warning, "Analysis coverage" for a notice. */
  label: "Text extraction" | "Analysis coverage";
  text: string;
};

/** A stated fact with a citation slot but no verified quotation. */
export type ClarifyUnverifiedFact = {
  /** What the fact is: "Notice period", "Fee", "Key date", ... */
  fact: string;
  /** The stored value, as the analysis states it. */
  value: string;
  /** Where its quotation would be, for linking to the fact. */
  ref: CitationRef;
};

/** A singular fact (notice period, renewal, payment, term) the analysis does not state. */
export type ClarifyUnstatedFact = {
  fact: "Notice period" | "Renewal" | "Payment" | "Term";
};

export type ClarifyFinding = {
  /** Its 1-based position in the stored findings: "Finding N" in the brief. */
  number: number;
  type: string;
  /** 0 to 10, or null when the analysis gave none. */
  severity: number | null;
};

/**
 * What to clarify before signing, in a fixed order: coverage gaps, stated facts without a verified
 * quotation, facts not stated, findings (highest severity first) and the analysis's questions.
 */
export type ClarifyChecklist = {
  coverageGaps: ClarifyCoverageGap[];
  unverified: ClarifyUnverifiedFact[];
  /**
   * True when at least one fact is stated and every stated fact has a verified quotation. Only then
   * may a reader be told so; `coverageGaps` says whether that holds for the whole contract.
   */
  everyStatedFactQuoted: boolean;
  unstated: ClarifyUnstatedFact[];
  findings: ClarifyFinding[];
  questions: string[];
};

export type ClarifyInput = {
  contractId: string;
  /** The contract's current extraction warning, as the page and the brief show it. */
  extractionWarning?: string | null;
  resultJson?: Partial<AnalysisResult> | null;
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

/** A stated value's substantive parts, so a placeholder such as "Not specified" never shows. */
function joinStated(parts: (string | null)[]): string {
  return parts
    .filter((part): part is string => part !== null && isSubstantiveText(part))
    .map((part) => part.trim())
    .join(", ");
}

/**
 * What to clarify before signing, built only from the stored analysis. Pure: it reads only its
 * input, calls no model or API, and decides no new state: a fact is unverified exactly when the
 * page and the brief mark it "No verified quotation" (a stated fact whose citation
 * `citationForReport` rejects), and unstated exactly when they show "Not specified".
 *
 * Fields with no citation slot (how to cancel, the parties, what it is, key points) are never
 * listed. Empty fee, penalty, obligation and key-date lists add nothing. An analysis from before
 * quotations existed lists each stated fact as unverified.
 */
export function clarifyBeforeSigning(input: ClarifyInput): ClarifyChecklist {
  const result: Partial<AnalysisResult> = isRecord(input.resultJson)
    ? input.resultJson
    : {};
  const contractId = input.contractId;
  const verified = (ref: CitationRef) =>
    citationForReport(result, contractId, ref) !== null;

  // Coverage: the same de-duplication as the page and the brief's Coverage section.
  const extractionWarning = text(input.extractionWarning);
  const coverageGaps: ClarifyCoverageGap[] = [
    ...(extractionWarning
      ? [{ label: "Text extraction" as const, text: extractionWarning }]
      : []),
    ...[...new Set(texts(result.coverage_notices))]
      .filter((notice) => notice !== extractionWarning)
      .map((notice) => ({ label: "Analysis coverage" as const, text: notice })),
  ];

  const summary = record(result.summary);
  const cancellation = record(summary.cancellation);
  const renewal = record(summary.renewal);
  const payments = record(summary.payments);
  const term = record(summary.term);

  const unverified: ClarifyUnverifiedFact[] = [];
  const unstated: ClarifyUnstatedFact[] = [];
  let quoted = 0;
  const stated = (fact: string, value: string, ref: CitationRef) => {
    if (verified(ref)) quoted += 1;
    else unverified.push({ fact, value, ref });
  };

  // The four singular facts, in the issue's order: notice period, renewal, payment, term.
  const notice = {
    notice_period_days:
      typeof cancellation.notice_period_days === "number"
        ? cancellation.notice_period_days
        : null,
    notice_period_text: text(cancellation.notice_period_text),
  };
  if (isNoticePeriodStated(notice)) {
    stated("Notice period", formatNoticePeriod(notice), NOTICE_CITATION);
  } else {
    unstated.push({ fact: "Notice period" });
  }

  if (isRenewalStated(renewal)) {
    const period = text(renewal.renewal_period);
    stated(
      "Renewal",
      joinStated([
        formatAutoRenew(renewal.auto_renew, ""),
        period && isSubstantiveText(period) ? `period ${period}` : null,
      ]),
      RENEWAL_CITATION,
    );
  } else {
    unstated.push({ fact: "Renewal" });
  }

  const amount = text(payments.amount);
  const frequency = text(payments.frequency);
  if (isPaymentStated({ amount, frequency })) {
    stated("Payment", joinStated([amount, frequency]), PAYMENT_CITATION);
  } else {
    unstated.push({ fact: "Payment" });
  }

  const start = text(term.start);
  const end = text(term.end);
  const minimumTerm = text(term.minimum_term);
  if (isTermStated({ start, end, minimum_term: minimumTerm })) {
    stated(
      "Term",
      joinStated([
        minimumTerm,
        start && isSubstantiveText(start) ? `starts ${start}` : null,
        end && isSubstantiveText(end) ? `ends ${end}` : null,
      ]),
      TERM_CITATION,
    );
  } else {
    unstated.push({ fact: "Term" });
  }

  // Each listed item keeps its index in the stored list, which names its quotation.
  const listed = (fact: KnownListedFact, label: string) => {
    const items = listedContainer(fact, result)?.[fact.list];
    (Array.isArray(items) ? items : []).forEach((item: unknown, index) => {
      const value = text(item);
      if (value) stated(label, value, listedCitationRef(fact, index));
    });
  };
  listed(LISTED_FEES, "Fee");
  listed(LISTED_PENALTIES, "Penalty");
  listed(LISTED_OBLIGATIONS, "Obligation");

  (Array.isArray(result.key_dates) ? result.key_dates : []).forEach(
    (value: unknown, index) => {
      const date = record(value);
      const when = text(date.date);
      if (!when) return;
      const type = KEY_DATE_LABELS[String(date.type)] ?? "Date";
      stated("Key date", `${type}: ${when}`, keyDateCitationRef(index));
    },
  );

  // Highest severity first; findings without one last; ties keep their stored order.
  const findings = (Array.isArray(result.red_flags) ? result.red_flags : [])
    .map((value: unknown, index): ClarifyFinding => {
      const flag = record(value);
      return {
        number: index + 1,
        type: text(flag.type) ?? "Risk",
        severity:
          typeof flag.severity === "number" && Number.isFinite(flag.severity)
            ? Math.max(0, Math.min(10, flag.severity))
            : null,
      };
    })
    .sort(
      (a, b) =>
        (b.severity ?? -1) - (a.severity ?? -1) || a.number - b.number,
    );

  return {
    coverageGaps,
    unverified,
    everyStatedFactQuoted: quoted > 0 && unverified.length === 0,
    unstated,
    findings,
    questions: texts(record(result.next_actions).questions_to_ask),
  };
}

/**
 * The line shown in place of the unverified list when every stated fact is quoted, or null when
 * some are not (or none is stated). With coverage gaps it says the quotations come only from the
 * text the analysis read, so it never reassures about what it did not see.
 */
export function quotationStatusLine(checklist: ClarifyChecklist): string | null {
  if (!checklist.everyStatedFactQuoted) return null;
  return checklist.coverageGaps.length
    ? "Every stated fact has a verified quotation in the text this analysis read. The coverage gaps above may hide facts it did not see."
    : "Every stated fact has a verified quotation.";
}
