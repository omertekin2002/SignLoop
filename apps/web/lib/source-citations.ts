import { z } from "zod";
import {
  isListedCitationRef,
  storedListedCitation,
  type ListedCitationRef,
} from "@/lib/listed-citations";
import {
  isKeyDateCitationRef,
  storedKeyDateCitation,
  type KeyDateCitationRef,
} from "@/lib/key-date-citations";

/**
 * Code points one analysis call reads. A longer contract is split into consecutive sections of at
 * most this length that together cover the whole text; each is analysed separately and the
 * results are merged (analyzeText in lib/analysis.ts).
 */
export const CONTRACT_ANALYSIS_LIMIT = 15000;
// One analysis is admitted and charged as one request, so it makes at most this many section calls
// plus one merge call however long the contract is (a 2,000,000-character upload would otherwise
// be over 130 sections). At SECTION_CONCURRENCY (lib/analysis.ts) calls at a time this is about
// what the section deadline leaves room for. Later sections are named in a coverage notice.
export const MAX_ANALYSED_SECTIONS = 16;
/** Shorter passages, such as a section heading, join the passage that follows them. */
const PASSAGE_MIN_LENGTH = 80;
/** "full" for a contract within CONTRACT_ANALYSIS_LIMIT, otherwise "section-1" to "section-N". */
export type SegmentLabel = "full" | `section-${number}`;
export const SegmentLabelSchema = z.custom<SegmentLabel>(
  (value) =>
    typeof value === "string" && /^(?:full|section-[1-9]\d*)$/.test(value),
);
export const sectionLabel = (index: number): SegmentLabel =>
  `section-${index + 1}`;
export const SOURCE_PAGE_SIZE = 6000;
export const MAX_EVIDENCE_QUOTE = 2000;
export const SourceRevisionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const SourceIdentitySchema = z.object({
  contract_id: z.string().uuid(),
  revision: SourceRevisionSchema,
  index_unit: z.literal("unicode-code-points"),
});
export const CitationSchema = SourceIdentitySchema.extend({
  status: z.literal("verified"),
  quote: z
    .string()
    .min(1)
    .max(MAX_EVIDENCE_QUOTE * 2),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
}).refine(
  (value) =>
    value.quote.trim().length > 0 &&
    value.end > value.start &&
    value.end - value.start === Array.from(value.quote).length &&
    value.end - value.start <= MAX_EVIDENCE_QUOTE,
);
export type SourceCitation = z.infer<typeof CitationSchema>;

// Only this proposal is requested from the model. Identity, revision, and offsets are server-owned.
export const EvidenceProposalSchema = z.object({
  quote: z
    .string()
    .min(1)
    .max(MAX_EVIDENCE_QUOTE * 2),
  segment: SegmentLabelSchema,
});
export type ContractSegment = {
  label: SegmentLabel;
  start: number;
  end: number;
  text: string;
};

/** Unicode code points throughout, matching PostgreSQL substring/char_length (not JS UTF-16). */
export function contractAnalysisSegments(text: string): ContractSegment[] {
  const chars = Array.from(text);
  if (chars.length <= CONTRACT_ANALYSIS_LIMIT)
    return [{ label: "full", start: 0, end: chars.length, text }];
  // Each passage fits the limit, so packing whole passages greedily covers the text with no gaps.
  const sections: Passage[] = [];
  for (const passage of splitPassages(chars, CONTRACT_ANALYSIS_LIMIT)) {
    const current = sections.at(-1);
    if (current && passage.end - current.start <= CONTRACT_ANALYSIS_LIMIT)
      current.end = passage.end;
    else sections.push({ ...passage });
  }
  return sections.map(({ start, end }, index) => ({
    label: sectionLabel(index),
    start,
    end,
    text: chars.slice(start, end).join(""),
  }));
}

/**
 * How much of a contract one analysis reads, without any of its text: the contract detail page
 * shows it before analysis, and analyzeText uses the same count, so the two cannot disagree.
 * Offsets are Unicode code points; uncoveredFrom is where the unanalysed text starts, or null.
 */
export type AnalysisCoverage = {
  characterCount: number;
  sectionCount: number;
  analysedSectionCount: number;
  uncoveredFrom: number | null;
};

export function analysisCoverageOf(
  segments: readonly Pick<ContractSegment, "start" | "end">[],
): AnalysisCoverage {
  const analysedSectionCount = Math.min(segments.length, MAX_ANALYSED_SECTIONS);
  return {
    characterCount: segments.at(-1)?.end ?? 0,
    sectionCount: segments.length,
    analysedSectionCount,
    uncoveredFrom: segments[analysedSectionCount]?.start ?? null,
  };
}

/**
 * Coverage for a contract of `characterCount` code points. A contract within
 * CONTRACT_ANALYSIS_LIMIT is always one section, so `loadText` is called only for a longer one.
 */
export async function contractAnalysisCoverage(
  characterCount: number,
  loadText: () => string | Promise<string>,
): Promise<AnalysisCoverage> {
  if (characterCount <= CONTRACT_ANALYSIS_LIMIT)
    return analysisCoverageOf([{ start: 0, end: characterCount }]);
  return analysisCoverageOf(contractAnalysisSegments(await loadText()));
}

type Passage = { start: number; end: number };

const NUMBERED_CLAUSE = /^[ \t]*\d{1,3}(?:\.\d{1,3})*\.?[ \t]/;

/**
 * Splits chars into consecutive passages that together cover it. A passage starts at a line that
 * opens a numbered clause ("9.", "9.1") or follows a blank line. A passage shorter than
 * PASSAGE_MIN_LENGTH joins the next one, and one longer than maxLength is cut.
 */
function splitPassages(chars: readonly string[], maxLength: number): Passage[] {
  const to = chars.length;
  const starts = [0];
  let previousBlank = false;
  for (let lineStart = 0; lineStart < to;) {
    const newline = chars.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? to : newline + 1;
    const line = chars.slice(lineStart, lineEnd).join("");
    const blank = !line.trim();
    if (
      lineStart > 0 &&
      !blank &&
      (previousBlank || NUMBERED_CLAUSE.test(line))
    )
      starts.push(lineStart);
    previousBlank = blank;
    lineStart = lineEnd;
  }
  const blocks = starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? to,
  }));
  const merged: Passage[] = [];
  let pending: Passage | null = null;
  for (const block of blocks) {
    const current: Passage = pending
      ? { start: pending.start, end: block.end }
      : block;
    pending = current.end - current.start < PASSAGE_MIN_LENGTH ? current : null;
    if (!pending) merged.push(current);
  }
  if (pending) merged.push(pending);
  return merged.flatMap((passage) => capPassage(chars, passage, maxLength));
}

/** Cuts an over-long passage at its last line break, else last space, before the cap. */
function capPassage(
  chars: readonly string[],
  passage: Passage,
  maxLength: number,
): Passage[] {
  const pieces: Passage[] = [];
  let { start } = passage;
  while (passage.end - start > maxLength) {
    const limit = start + maxLength;
    const window = chars.slice(start, limit);
    const breakAt = [window.lastIndexOf("\n"), window.lastIndexOf(" ")].find(
      (at) => at >= maxLength / 2,
    );
    const end = breakAt === undefined ? limit : start + breakAt + 1;
    pieces.push({ start, end });
    start = end;
  }
  pieces.push({ start, end: passage.end });
  return pieces;
}

/** A quotation either check accepts: some non-space text, at most MAX_EVIDENCE_QUOTE code points. */
function isQuotable(quote: string): boolean {
  return Boolean(quote.trim()) && Array.from(quote).length <= MAX_EVIDENCE_QUOTE;
}

export function verifyQuote(
  proposal: unknown,
  segments: readonly ContractSegment[],
): { quote: string; start: number; end: number } | null {
  const parsed = EvidenceProposalSchema.safeParse(proposal);
  if (!parsed.success) return null;
  const { quote, segment: label } = parsed.data;
  const length = Array.from(quote).length;
  if (!isQuotable(quote)) return null;
  const segment = segments.find((part) => part.label === label);
  if (!segment) return null;
  const at = segment.text.indexOf(quote);
  // An overlapping duplicate is still ambiguous. Never guess which occurrence the model meant.
  if (at < 0 || segment.text.indexOf(quote, at + 1) >= 0) return null;
  const prefix = segment.text.slice(0, at);
  // A quotation cannot start/end inside a surrogate pair.
  const start = segment.start + Array.from(prefix).length;
  const end = start + length;
  if (
    Array.from(segment.text)
      .slice(start - segment.start, end - segment.start)
      .join("") !== quote
  )
    return null;
  return { quote, start, end };
}

// A lone surrogate could match half of a pair, so a quotation holding one is never found.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const DIGIT_CHAR = /\p{N}/u;
const ATTACHED_SIGN = /[-+−]/;
const ATTACHED_NUMBER_PREFIX = /(?:[-+−.]|(?:\p{N}|[-+−]),)$/u;
const NUMBER_SEP_DIGIT = /^[.,]\p{N}/u;
const DIGIT_NUMBER_SEP = /\p{N}[.,]$/u;

/** True when a match does not start or end inside a word or number (e.g. "0" in "30", "5%" in "−5%" or ".5%", ".5%" in "1.5%" or "−.5%", "200" in "1,200"). */
function atQuotationBoundary(
  haystack: string,
  start: number,
  end: number,
  needle: string,
  first: string,
  last: string,
): boolean {
  if (start > 0) {
    const before = haystack.slice(Math.max(0, start - 3), start);
    const prev = Array.from(before).at(-1);
    if (WORD_CHAR.test(first)) {
      if (prev && WORD_CHAR.test(prev)) return false;
      if (DIGIT_CHAR.test(first) && ATTACHED_NUMBER_PREFIX.test(before)) {
        return false;
      }
    } else if (
      NUMBER_SEP_DIGIT.test(needle) &&
      prev &&
      (DIGIT_CHAR.test(prev) || ATTACHED_SIGN.test(prev))
    ) {
      return false;
    }
  }
  if (end < haystack.length) {
    const after = haystack.slice(end, end + 3);
    const next = Array.from(after)[0];
    if (WORD_CHAR.test(last)) {
      if (next && WORD_CHAR.test(next)) return false;
      if (DIGIT_CHAR.test(last) && NUMBER_SEP_DIGIT.test(after)) return false;
    } else if (DIGIT_NUMBER_SEP.test(needle) && next && DIGIT_CHAR.test(next)) {
      return false;
    }
  }
  return true;
}

/**
 * The only differences the whole-text check forgives, applied alike to both sides: every run of
 * whitespace becomes one space, and curly double and single quotation marks and apostrophes become
 * straight ones. Nothing fuzzier.
 */
export function normalizeQuotation(text: string): string {
  return text
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/\s+/g, " ");
}

/**
 * verifyQuote's exact match over the whole text rather than one labelled segment, for checking
 * where a quotation came from rather than where it sits: a quotation that appears more than once
 * still matches, as long as an occurrence sits on word and number boundaries (so "0 days" never
 * matches "30 days"). The text is normalised once, so one matcher can check many quotations. A
 * well-formed quotation can only match whole code points, so this agrees with a code-point search.
 */
export function createQuoteMatcher(text: string): (quote: string) => boolean {
  const haystack = normalizeQuotation(text);
  return (quote) => {
    const needle = normalizeQuotation(quote).trim();
    if (!isQuotable(needle) || LONE_SURROGATE.test(needle)) return false;
    const chars = Array.from(needle);
    const first = chars[0]!;
    const last = chars.at(-1)!;
    let at = haystack.indexOf(needle);
    while (at >= 0) {
      if (
        atQuotationBoundary(haystack, at, at + needle.length, needle, first, last)
      ) {
        return true;
      }
      at = haystack.indexOf(needle, at + 1);
    }
    return false;
  };
}

/**
 * A cited passage in a stored report: a red flag by index, the jurisdiction proposal, the
 * cancellation notice period, renewal, the payment amount and frequency, the term, or a cancellation
 * penalty, an extra fee or an obligation by its index in the stored `penalties` (`penalty-<n>`),
 * `fees` (`fee-<n>`) or `obligations` (`obligation-<n>`), or a key date by its index in the stored
 * `key_dates` (`key-date-<n>`).
 */
export type CitationRef =
  | number
  | "jurisdiction"
  | "notice"
  | "renewal"
  | "payment"
  | "term"
  | ListedCitationRef
  | KeyDateCitationRef;
export const JURISDICTION_CITATION = "jurisdiction";
export const NOTICE_CITATION = "notice";
export const RENEWAL_CITATION = "renewal";
export const PAYMENT_CITATION = "payment";
export const TERM_CITATION = "term";

function storedCitation(report: Record<string, unknown>, ref: CitationRef): unknown {
  const field = (value: unknown, key: string) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)[key]
      : null;
  if (ref === JURISDICTION_CITATION)
    return field(report.proposed_jurisdiction, "citation");
  if (ref === NOTICE_CITATION)
    return field(field(report.summary, "cancellation"), "notice_citation");
  if (ref === RENEWAL_CITATION)
    return field(field(report.summary, "renewal"), "renewal_citation");
  if (ref === PAYMENT_CITATION)
    return field(field(report.summary, "payments"), "payment_citation");
  if (ref === TERM_CITATION)
    return field(field(report.summary, "term"), "term_citation");
  if (isListedCitationRef(ref)) return storedListedCitation(report, ref);
  if (isKeyDateCitationRef(ref)) return storedKeyDateCitation(report, ref);
  return Array.isArray(report.red_flags)
    ? field(report.red_flags[ref], "citation")
    : null;
}

export function citationForReport(
  result: unknown,
  contractId: string,
  ref: CitationRef,
): SourceCitation | null {
  if (!result || typeof result !== "object") return null;
  const report = result as Record<string, unknown>;
  const source = SourceIdentitySchema.safeParse(report.source);
  const parsed = CitationSchema.safeParse(storedCitation(report, ref));
  if (
    !source.success ||
    !parsed.success ||
    source.data.contract_id.toLowerCase() !== contractId.toLowerCase() ||
    parsed.data.contract_id.toLowerCase() !== contractId.toLowerCase() ||
    source.data.revision !== parsed.data.revision
  )
    return null;
  return parsed.data;
}

export const SourcePageSchema = z.object({
  contractId: z.string().uuid(),
  revision: SourceRevisionSchema,
  text: z.string().max(SOURCE_PAGE_SIZE * 2),
  offset: z.number().int().nonnegative(),
  totalCharacters: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  previousOffset: z.number().int().nonnegative().nullable(),
  extractionWarning: z.string().nullable(),
  highlight: CitationSchema.nullable(),
});
export type SourcePage = z.infer<typeof SourcePageSchema>;
