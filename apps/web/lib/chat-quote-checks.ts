import {
  createQuoteMatcher,
  MAX_EVIDENCE_QUOTE,
  normalizeQuotation,
  SourceRevisionSchema,
} from "@/lib/source-citations";
import { isRecord, isUuid } from "@/lib/utils";

/**
 * Quotations in a chat answer about one contract, each checked word for word against that
 * contract's text. A "found" quotation establishes provenance only: the words appear in the
 * contract, not that the answer reads them correctly. This module is pure and browser-safe; the
 * chat route loads the text and stores the result with the assistant message.
 */

/** At most this many quotations from one reply are checked and shown. */
export const MAX_QUOTE_CHECKS = 20;
/** An inline "…" passage shorter than this is a phrase or a scare quote, not a quotation. */
export const MIN_INLINE_QUOTE_WORDS = 6;
/** A blockquote paragraph shorter than this is a label or a note, not a quotation. */
const MIN_BLOCKQUOTE_WORDS = 3;

export type QuoteCheckStatus = "found" | "not_found";
export type QuoteCheck = { quote: string; status: QuoteCheckStatus };
/** What is stored with a focused assistant reply: which text was checked, and each result. */
export type ChatQuoteChecks = {
  contractId: string;
  /** The contract's text revision (contractSourceRevision) when the reply was checked. */
  revision: string;
  checks: QuoteCheck[];
};

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const BLOCKQUOTE_MARKERS = /^(?:[ \t]*>[ \t]?)+/;
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+/;
// A line that starts a new block (list item, heading, thematic break or HTML) rather than
// continuing a blockquote's paragraph without its own `>`.
const NEW_BLOCK = /^ {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|#{1,6}(?:[ \t]|$)|(?:[-*_][ \t]*){3,}$|<)/;
// Backslash-escaped punctuation renders as itself; escaped * and _ are kept out of emphasis.
const ESCAPED = /\\([!-/:-@[-`{-~])/g;
const ESCAPED_STAR = "\uE000";
const ESCAPED_UNDERSCORE = "\uE001";
// An attribution line under a quotation ("— Clause 9"), not part of it.
const ATTRIBUTION = /^(?:—|–|--)/;
const INLINE_QUOTATION = /“([^“”]+)”|"([^"]+)"/g;
const BLANK_LINE = /\n[^\S\n]*\n/;

/** Lines inside fenced code blocks become blank, so they hold no quotations or blockquotes. */
function withoutFences(lines: readonly string[]): string[] {
  let fence: string | null = null;
  return lines.map((line) => {
    const match = FENCE.exec(line);
    if (fence !== null) {
      if (
        match &&
        match[1]![0] === fence[0] &&
        match[1]!.length >= fence.length &&
        !match[2]!.trim()
      )
        fence = null;
      return "";
    }
    // A backtick fence's info string cannot hold a backtick; such a line is an inline code span.
    if (match && !(match[1]![0] === "`" && match[2]!.includes("`"))) {
      fence = match[1]!;
      return "";
    }
    return line;
  });
}

/** Code spans (`…`, ``…``) never hold quotations; each becomes a space. */
function withoutCodeSpans(text: string): string {
  return text.replace(/(`+)(?:(?!\1)[\s\S])+?\1(?!`)/g, " ");
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/**
 * Text as the chat's Markdown renderer shows it: emphasis delimiters (`*`, `_`, `**`, `__`, `***`)
 * at the edges of words dropped, and backslash escapes resolved. Intraword underscores, as in
 * snake_case, and a lone `*` between spaces are not emphasis and stay.
 */
function renderedText(text: string): string {
  return text
    .replace(ESCAPED, (_match, char: string) =>
      char === "*" ? ESCAPED_STAR : char === "_" ? ESCAPED_UNDERSCORE : char,
    )
    .replace(/(^|[^\p{L}\p{N}*_])[*_]+(?=[^\s*_])/gu, "$1")
    .replace(/([^\s*_])[*_]+(?=$|[^\p{L}\p{N}*_])/gu, "$1")
    .replaceAll(ESCAPED_STAR, "*")
    .replaceAll(ESCAPED_UNDERSCORE, "_");
}

/**
 * Rendered quoted words (see renderedText, applied once by the caller) with whitespace collapsed,
 * and a leading or trailing ellipsis and one trailing , . ; or : (often written inside the marks)
 * trimmed. Trimming only shortens a quotation, so it can never turn a match into a miss.
 */
function cleanQuotation(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:…|\.{3})\s*/, "")
    .replace(/\s*(?:…|\.{3})$/, "")
    .replace(/[.,;:]$/, "")
    .trim();
}

/**
 * Inline "…" and “…” passages of at least MIN_INLINE_QUOTE_WORDS words, within one paragraph, in
 * text already rendered (renderedText).
 */
function inlineQuotations(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(INLINE_QUOTATION)) {
    const inner = match[1] ?? match[2] ?? "";
    if (BLANK_LINE.test(inner)) continue;
    const quote = cleanQuotation(inner);
    if (wordCount(quote) >= MIN_INLINE_QUOTE_WORDS) found.push(quote);
  }
  return found;
}

/** The text of a passage wrapped whole in quotation marks, without them. */
function withoutOuterMarks(text: string): string {
  const match = /^(?:“([\s\S]*)”|"([\s\S]*)")[.,;:]?$/.exec(text);
  return match ? (match[1] ?? match[2] ?? text) : text;
}

/**
 * One blockquote's quotations. Each paragraph (or list item) is one passage, unless it holds long
 * inline quotations, as in `> Clause 9 says "…"`: then those are the quotations, not the paragraph.
 */
function blockQuotations(lines: readonly string[]): string[] {
  const paragraphs: string[][] = [[]];
  for (const line of withoutFences(lines)) {
    if (!line.trim()) paragraphs.push([]);
    else if (LIST_MARKER.test(line))
      paragraphs.push([line.replace(LIST_MARKER, "")]);
    else paragraphs.at(-1)!.push(line);
  }
  return paragraphs.flatMap((paragraph) => {
    const text = renderedText(
      withoutCodeSpans(paragraph.join("\n")).replace(/\s+/g, " ").trim(),
    );
    if (!text) return [];
    const inline = inlineQuotations(text);
    if (inline.length) return inline;
    if (ATTRIBUTION.test(text)) return [];
    const quote = cleanQuotation(withoutOuterMarks(cleanQuotation(text)));
    return wordCount(quote) >= MIN_BLOCKQUOTE_WORDS ? [quote] : [];
  });
}

/**
 * The quotations in a reply's Markdown, in order: each blockquote passage (consecutive `>` lines
 * joined, with any lazy continuation line the renderer also puts in the blockquote), and each
 * inline "…" or “…” passage of at least MIN_INLINE_QUOTE_WORDS words elsewhere.
 * Code blocks and code spans are ignored. Repeats (after the matcher's normalisation) are dropped,
 * a quotation longer than MAX_EVIDENCE_QUOTE is skipped, and at most MAX_QUOTE_CHECKS are returned.
 */
export function extractQuotations(markdown: string): string[] {
  const lines = withoutFences(markdown.replace(/\r\n?/g, "\n").split("\n"));
  const found: string[] = [];
  let prose: string[] = [];
  let quoted: string[] = [];
  const flushProse = () => {
    if (prose.length)
      found.push(
        ...inlineQuotations(renderedText(withoutCodeSpans(prose.join("\n")))),
      );
    prose = [];
  };
  const flushQuoted = () => {
    if (quoted.length) found.push(...blockQuotations(quoted));
    quoted = [];
  };
  for (const line of lines) {
    if (BLOCKQUOTE_MARKERS.test(line)) {
      flushProse();
      quoted.push(line.replace(BLOCKQUOTE_MARKERS, ""));
    } else if (
      // A paragraph continuation without its own `>` stays in the blockquote, as rendered, so an
      // altered continuation cannot hide behind a matching first line.
      quoted.at(-1)?.trim() &&
      line.trim() &&
      !NEW_BLOCK.test(line)
    ) {
      quoted.push(line);
    } else {
      flushQuoted();
      prose.push(line);
    }
  }
  flushProse();
  flushQuoted();

  const seen = new Set<string>();
  const quotations: string[] = [];
  for (const quote of found) {
    const key = normalizeQuotation(quote);
    if (seen.has(key) || Array.from(quote).length > MAX_EVIDENCE_QUOTE) continue;
    seen.add(key);
    quotations.push(quote);
    if (quotations.length === MAX_QUOTE_CHECKS) break;
  }
  return quotations;
}

/** Each quotation found or not found in the contract's whole text (createQuoteMatcher). */
export function checkQuotations(
  quotations: readonly string[],
  contractText: string,
): QuoteCheck[] {
  const matches = createQuoteMatcher(contractText);
  return quotations.map((quote) => ({
    quote,
    status: matches(quote) ? "found" : "not_found",
  }));
}

/** Stored or received checks, validated at the boundary; null when there is nothing to show. */
export function parseChatQuoteChecks(value: unknown): ChatQuoteChecks | null {
  if (
    !isRecord(value) ||
    !isUuid(value.contractId) ||
    !SourceRevisionSchema.safeParse(value.revision).success ||
    !Array.isArray(value.checks)
  )
    return null;
  const checks = value.checks
    .flatMap((check): QuoteCheck[] =>
      isRecord(check) &&
      typeof check.quote === "string" &&
      check.quote.trim() &&
      Array.from(check.quote).length <= MAX_EVIDENCE_QUOTE &&
      (check.status === "found" || check.status === "not_found")
        ? [{ quote: check.quote, status: check.status }]
        : [],
    )
    .slice(0, MAX_QUOTE_CHECKS);
  return checks.length
    ? { contractId: value.contractId, revision: value.revision as string, checks }
    : null;
}
