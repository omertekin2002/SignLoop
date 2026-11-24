import { marked, type Token } from "marked";
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
// Escaped `"` and quotation marks inside literal code spans stay protected until delimiter parsing finishes.
const ESCAPED_QUOTE = "\uE002";
const ESCAPED_LEFT_CURLY = "\uE003";
const ESCAPED_RIGHT_CURLY = "\uE004";
// A recognisable contract locator: e.g. `Clause 4`, `Section 2.1`, `Schedule A`, `Article IV`.
const SHORT_LABEL = /[A-Z][\w&/'-]*(?:\s+[A-Z][\w&/'-]*){0,2}/;
const BASE_LOCATOR =
  /(?:Clause|Section|Article|Paragraph|Schedule|Annex|Appendix|Part|Page|Exhibit)\s+(?:\d[\w.-]*|[A-Z](?:\.\d[\w.-]*)?|[IVX]{1,5}\b)/;
const LOCATOR = new RegExp(
  `${BASE_LOCATOR.source}(?:\\s*\\(${SHORT_LABEL.source}\\))?`,
);
// A pure attribution line (`— Clause 9`, `— Clause 2, Fees`): no parentheticals or lowercase prose,
// so operative lines such as `— Section 4 (Payment is required)` or `— Section 4: No interest...`
// stay part of the checked quotation.
const ATTRIBUTION_LINE = new RegExp(
  `^(?:—|–|--)\\s*${BASE_LOCATOR.source}(?:,\\s*${SHORT_LABEL.source})?$`,
);
const INLINE_QUOTATION = /“([^“”]+)”|"([^"]+)"/g;
// Only strip an explicit source introduction inside a blockquote (e.g. `> Clause 4 says "…".`),
// requiring a real locator or explicit subject + speech verb so operative text such as
// `> Clause excludes "…"` or `> The tenant need not give "…"` stays checked in full.
const LEAD_IN_QUOTATION = new RegExp(
  `^(?:${LOCATOR.source}(?:\\s+(?:says|states|provides|reads))?:?\\s*|(?:It|This clause|The clause|The contract|The agreement)\\s+(?:says|states|provides|reads):?\\s*)(?:“([^“”]+)”|"([^"]+)")[.,;:]?$`,
);
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

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/**
 * Render inline Markdown tokens using the same CommonMark tokenizer (`marked`) the chat renderer
 * uses: nested emphasis (`*due *only* on Friday*`) unwraps cleanly, non-flanking literal asterisks
 * (`$500*, plus taxes*.`) and escaped backticks (`\`not\``) stay intact, and code spans are either
 * dropped (prose) or kept completely literal without emphasis/quote processing (blockquotes).
 */
function renderInlineTokens(
  tokens: readonly Token[],
  codeSpans: "drop" | "keep",
): string {
  let out = "";
  for (const token of tokens) {
    if (token.type === "codespan") {
      out +=
        codeSpans === "drop"
          ? " "
          : token.text
              .replaceAll('"', ESCAPED_QUOTE)
              .replaceAll("“", ESCAPED_LEFT_CURLY)
              .replaceAll("”", ESCAPED_RIGHT_CURLY);
    } else if (token.type === "escape") {
      out += token.text === '"' ? ESCAPED_QUOTE : token.text;
    } else if (token.type === "br") {
      out += " ";
    } else if (
      "tokens" in token &&
      Array.isArray(token.tokens) &&
      token.tokens.length
    ) {
      out += renderInlineTokens(token.tokens, codeSpans);
    } else if ("text" in token && typeof token.text === "string") {
      out += token.text;
    } else {
      out += token.raw;
    }
  }
  return out;
}

function renderInlineMarkdown(
  text: string,
  codeSpans: "drop" | "keep",
): string {
  return renderInlineTokens(marked.Lexer.lexInline(text), codeSpans);
}

/**
 * Rendered quoted words with whitespace collapsed, protected quotes restored, and a leading or
 * trailing ellipsis and one trailing , . ; or : (often written inside the marks) trimmed.
 * Trimming only shortens a quotation, so it can never turn a match into a miss.
 */
function cleanQuotation(text: string): string {
  return text
    .replaceAll(ESCAPED_QUOTE, '"')
    .replaceAll(ESCAPED_LEFT_CURLY, "“")
    .replaceAll(ESCAPED_RIGHT_CURLY, "”")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:…|\.{3})\s*/, "")
    .replace(/\s*(?:…|\.{3})$/, "")
    .replace(/[.,;:]$/, "")
    .trim();
}

/**
 * Inline "…" and “…” passages of at least MIN_INLINE_QUOTE_WORDS words, within one paragraph, in
 * text already rendered (`renderInlineMarkdown`).
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
 * One blockquote's quotations. Each paragraph (or list item) is one passage checked as rendered,
 * keeping visible inline-code text literal and never dropping surrounding blockquote text around an
 * inner quotation. Only a recognizable source introduction (`> Clause 9 says "…"`) is stripped.
 */
function blockQuotations(lines: readonly string[]): string[] {
  const paragraphs: string[][] = [[]];
  for (const line of withoutFences(lines)) {
    const trimmed = line.trim();
    if (!trimmed || ATTRIBUTION_LINE.test(trimmed)) paragraphs.push([]);
    else if (LIST_MARKER.test(line))
      paragraphs.push([line.replace(LIST_MARKER, "")]);
    else paragraphs.at(-1)!.push(line);
  }
  return paragraphs.flatMap((paragraph) => {
    const raw = paragraph.join("\n").trim();
    if (!raw) return [];
    const text = renderInlineMarkdown(raw, "keep").replace(/\s+/g, " ").trim();
    if (!text) return [];
    if (ATTRIBUTION_LINE.test(text)) return [];
    const unwrapped = withoutOuterMarks(text);
    if (unwrapped !== text) {
      const quote = cleanQuotation(unwrapped);
      return wordCount(quote) >= MIN_BLOCKQUOTE_WORDS ? [quote] : [];
    }
    const leadIn = LEAD_IN_QUOTATION.exec(text);
    if (leadIn) {
      const quote = cleanQuotation(leadIn[1] ?? leadIn[2] ?? "");
      if (wordCount(quote) >= MIN_INLINE_QUOTE_WORDS) return [quote];
    }
    const quote = cleanQuotation(text);
    return wordCount(quote) >= MIN_BLOCKQUOTE_WORDS ? [quote] : [];
  });
}

/**
 * The quotations in a reply's Markdown, in order: each blockquote passage (consecutive `>` lines
 * joined, with any lazy continuation line the renderer also puts in the blockquote), and each
 * inline "…" or “…” passage of at least MIN_INLINE_QUOTE_WORDS words elsewhere.
 * Fenced code blocks and prose code spans are ignored. Repeats (after the matcher's normalisation)
 * are dropped, a quotation longer than MAX_EVIDENCE_QUOTE is skipped, and at most MAX_QUOTE_CHECKS
 * are returned.
 */
export function extractQuotations(markdown: string): string[] {
  const lines = withoutFences(markdown.replace(/\r\n?/g, "\n").split("\n"));
  const found: string[] = [];
  let prose: string[] = [];
  let quoted: string[] = [];
  const flushProse = () => {
    if (prose.length) {
      // Render each paragraph separately so BLANK_LINE boundaries stay intact.
      const paragraphs = prose.join("\n").split(BLANK_LINE);
      for (const paragraph of paragraphs) {
        if (!paragraph.trim()) continue;
        found.push(...inlineQuotations(renderInlineMarkdown(paragraph, "drop")));
      }
    }
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
