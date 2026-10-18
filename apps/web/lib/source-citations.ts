import { z } from "zod";

export const CONTRACT_ANALYSIS_LIMIT = 15000;
export const CONTRACT_HEAD_LENGTH = 9750;
export const CONTRACT_TAIL_LENGTH =
  CONTRACT_ANALYSIS_LIMIT - CONTRACT_HEAD_LENGTH;
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
  segment: z.enum(["full", "head", "tail"]),
});
export type ContractSegment = {
  label: "full" | "head" | "tail";
  start: number;
  end: number;
  text: string;
};

/** Unicode code points throughout, matching PostgreSQL substring/char_length (not JS UTF-16). */
export function contractAnalysisSegments(text: string): ContractSegment[] {
  const chars = Array.from(text);
  if (chars.length <= CONTRACT_ANALYSIS_LIMIT)
    return [{ label: "full", start: 0, end: chars.length, text }];
  return [
    {
      label: "head",
      start: 0,
      end: CONTRACT_HEAD_LENGTH,
      text: chars.slice(0, CONTRACT_HEAD_LENGTH).join(""),
    },
    {
      label: "tail",
      start: chars.length - CONTRACT_TAIL_LENGTH,
      end: chars.length,
      text: chars.slice(-CONTRACT_TAIL_LENGTH).join(""),
    },
  ];
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

export function citationForReport(
  result: unknown,
  contractId: string,
  index: number,
): SourceCitation | null {
  if (!result || typeof result !== "object") return null;
  const report = result as Record<string, unknown>;
  const source = SourceIdentitySchema.safeParse(report.source);
  const flag = Array.isArray(report.red_flags) ? report.red_flags[index] : null;
  const parsed = CitationSchema.safeParse(flag?.citation);
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
