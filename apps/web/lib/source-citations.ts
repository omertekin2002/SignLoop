import { z } from "zod";

/**
 * Code points one analysis call reads. A longer contract is split into consecutive sections of at
 * most this length that together cover the whole text; each is analysed separately and the
 * results are merged (analyzeText in lib/analysis.ts).
 */
export const CONTRACT_ANALYSIS_LIMIT = 15000;
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

export function verifyQuote(
  proposal: unknown,
  segments: readonly ContractSegment[],
): { quote: string; start: number; end: number } | null {
  const parsed = EvidenceProposalSchema.safeParse(proposal);
  if (!parsed.success) return null;
  const { quote, segment: label } = parsed.data;
  const length = Array.from(quote).length;
  if (!quote.trim() || length > MAX_EVIDENCE_QUOTE) return null;
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

/** A cited passage in a stored report: a red flag by index, or the jurisdiction proposal. */
export type CitationRef = number | "jurisdiction";
export const JURISDICTION_CITATION = "jurisdiction";

export function citationForReport(
  result: unknown,
  contractId: string,
  ref: CitationRef,
): SourceCitation | null {
  if (!result || typeof result !== "object") return null;
  const report = result as Record<string, unknown>;
  const source = SourceIdentitySchema.safeParse(report.source);
  const cited =
    ref === JURISDICTION_CITATION
      ? report.proposed_jurisdiction
      : Array.isArray(report.red_flags)
        ? report.red_flags[ref]
        : null;
  const parsed = CitationSchema.safeParse(
    cited && typeof cited === "object"
      ? (cited as Record<string, unknown>).citation
      : null,
  );
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
