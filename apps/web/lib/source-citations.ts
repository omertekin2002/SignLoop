import { z } from "zod";

export const CONTRACT_ANALYSIS_LIMIT = 15000;
// A longer contract is sent as a head, up to MIDDLE_SEGMENT_LABELS.length passages selected from
// the middle, and a tail, within the same budget. The head keeps the parties, definitions and
// commercial terms that open most contracts; the tail keeps governing law, signatures and fee
// schedules. The rest (2,200 code points, a few typical clauses) goes to the middle passages
// that score highest on MIDDLE_PASSAGE_KEYWORDS, where term, renewal and notice clauses often sit.
export const CONTRACT_HEAD_LENGTH = 8000;
export const CONTRACT_TAIL_LENGTH = 4800;
export const CONTRACT_MIDDLE_BUDGET =
  CONTRACT_ANALYSIS_LIMIT - CONTRACT_HEAD_LENGTH - CONTRACT_TAIL_LENGTH;
export const MIDDLE_SEGMENT_LABELS = [
  "middle-1",
  "middle-2",
  "middle-3",
  "middle-4",
] as const;
/** Longer clauses are split, so one clause cannot take the whole middle budget. */
export const MIDDLE_PASSAGE_MAX_LENGTH = 1000;
/** Shorter passages, such as a section heading, join the passage that follows them. */
const MIDDLE_PASSAGE_MIN_LENGTH = 80;
/**
 * Lower-case stems of the clause types the analysis reports. A passage scores one point per stem
 * it contains, so a long passage cannot win by repeating one word.
 */
export const MIDDLE_PASSAGE_KEYWORDS = [
  "renew",
  "term",
  "terminat",
  "cancel",
  "notice",
  "fee",
  "price",
  "increase",
  "payment",
  "late",
  "interest",
  "penalt",
  "liabil",
  "indemn",
  "governing law",
  "jurisdiction",
  "arbitration",
  "exclusiv",
  "auto",
] as const;
const SEGMENT_LABELS = [
  "full",
  "head",
  ...MIDDLE_SEGMENT_LABELS,
  "tail",
] as const;
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
  segment: z.enum(SEGMENT_LABELS),
});
export type ContractSegment = {
  label: (typeof SEGMENT_LABELS)[number];
  start: number;
  end: number;
  text: string;
};

/** Unicode code points throughout, matching PostgreSQL substring/char_length (not JS UTF-16). */
export function contractAnalysisSegments(text: string): ContractSegment[] {
  const chars = Array.from(text);
  if (chars.length <= CONTRACT_ANALYSIS_LIMIT)
    return [{ label: "full", start: 0, end: chars.length, text }];
  const tailStart = chars.length - CONTRACT_TAIL_LENGTH;
  const segment = (
    label: ContractSegment["label"],
    start: number,
    end: number,
  ): ContractSegment => ({
    label,
    start,
    end,
    text: chars.slice(start, end).join(""),
  });
  return [
    segment("head", 0, CONTRACT_HEAD_LENGTH),
    ...selectMiddlePassages(chars, CONTRACT_HEAD_LENGTH, tailStart).map(
      (passage, index) =>
        segment(MIDDLE_SEGMENT_LABELS[index]!, passage.start, passage.end),
    ),
    segment("tail", tailStart, chars.length),
  ];
}

type Passage = { start: number; end: number };

const NUMBERED_CLAUSE = /^[ \t]*\d{1,3}(?:\.\d{1,3})*\.?[ \t]/;

/**
 * Splits chars[from, to) into consecutive passages that together cover it. A passage starts at a
 * line that opens a numbered clause ("9.", "9.1") or follows a blank line. A passage shorter than
 * MIDDLE_PASSAGE_MIN_LENGTH joins the next one, and one longer than MIDDLE_PASSAGE_MAX_LENGTH is cut.
 */
function splitMiddlePassages(
  chars: readonly string[],
  from: number,
  to: number,
): Passage[] {
  const starts = [from];
  let previousBlank = false;
  for (let lineStart = from; lineStart < to;) {
    const newline = chars.indexOf("\n", lineStart);
    const lineEnd = newline < 0 || newline >= to ? to : newline + 1;
    const line = chars.slice(lineStart, lineEnd).join("");
    const blank = !line.trim();
    if (
      lineStart > from &&
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
    pending =
      current.end - current.start < MIDDLE_PASSAGE_MIN_LENGTH ? current : null;
    if (!pending) merged.push(current);
  }
  if (pending) merged.push(pending);
  return merged.flatMap((passage) => capPassage(chars, passage));
}

/** Cuts an over-long passage at its last line break, else last space, before the cap. */
function capPassage(chars: readonly string[], passage: Passage): Passage[] {
  const pieces: Passage[] = [];
  let { start } = passage;
  while (passage.end - start > MIDDLE_PASSAGE_MAX_LENGTH) {
    const limit = start + MIDDLE_PASSAGE_MAX_LENGTH;
    const window = chars.slice(start, limit);
    const breakAt = [window.lastIndexOf("\n"), window.lastIndexOf(" ")].find(
      (at) => at >= MIDDLE_PASSAGE_MAX_LENGTH / 2,
    );
    const end = breakAt === undefined ? limit : start + breakAt + 1;
    pieces.push({ start, end });
    start = end;
  }
  pieces.push({ start, end: passage.end });
  return pieces;
}

function scoreMiddlePassage(text: string): number {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  return MIDDLE_PASSAGE_KEYWORDS.filter((keyword) =>
    normalized.includes(keyword),
  ).length;
}

/**
 * The highest-scoring passages of chars[from, to) that fit CONTRACT_MIDDLE_BUDGET, in document
 * order. Passages without a keyword are never sent, and ties go to the earlier passage, so the
 * same text always yields the same selection.
 */
function selectMiddlePassages(
  chars: readonly string[],
  from: number,
  to: number,
): Passage[] {
  const ranked = splitMiddlePassages(chars, from, to)
    .map((passage, index) => ({
      ...passage,
      index,
      score: scoreMiddlePassage(
        chars.slice(passage.start, passage.end).join(""),
      ),
    }))
    .filter((passage) => passage.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: Passage[] = [];
  let remaining = CONTRACT_MIDDLE_BUDGET;
  for (const passage of ranked) {
    if (selected.length === MIDDLE_SEGMENT_LABELS.length) break;
    const length = passage.end - passage.start;
    if (length > remaining) continue;
    selected.push({ start: passage.start, end: passage.end });
    remaining -= length;
  }
  return selected.sort((a, b) => a.start - b.start);
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
