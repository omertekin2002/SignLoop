import { marked } from "marked";
import type { WebSearchSource } from "@/lib/gemini-search";

// Post-processing applied to a finished answer. Everything here works from server-side ground
// truth — which pages were actually fetched, and what text came back — rather than from the
// model's prose, because the prose is exactly what cannot be trusted.

/** Models trained on OpenAI's citation format emit 【1†L23-L26】 where the prompt asked for [1]. */
const FOREIGN_CITATION_MARKER = /【\s*(\d{1,3})\s*(?:†[^】]*)?】/g;

/** Measured quantities: decimals and grouped thousands. */
// Bare integers are deliberately excluded — "3 reasons" and "September 2026" are not claims that
// need a source, and matching them would make the check noise rather than signal.
const MEASURED_FIGURE = /\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+[.,]\d+/g;

export type FigureVerification = "ok" | "no-evidence" | "unmatched";

const FIGURE_NOTICES: Record<Exclude<FigureVerification, "ok">, string> = {
  "no-evidence":
    "_No page was read for this answer, so the figures above come from the model's own knowledge rather than a source._",
  unmatched:
    "_The figures above could not be matched to the text of the pages that were read._",
};

export function normalizeCitationMarkers(message: string): string {
  return message.replace(FOREIGN_CITATION_MARKER, (_match, number: string) => `[${number}]`);
}

/** Prose only: code blocks, inline code, and link destinations are not the model's claims. */
function collectProse(message: string): string[] {
  const chunks: string[] = [];
  marked.walkTokens(marked.lexer(message), (token) => {
    if (token.type === "text") chunks.push(token.raw);
  });
  return chunks;
}

/** A number written 14.35 may appear in a source as 14,35 or 1435; check the usual renderings. */
function figureVariants(figure: string): string[] {
  return [
    figure,
    figure.replace(/[.,]/g, ""),
    figure.replace(/,/g, "."),
    figure.replace(/\./g, ","),
  ];
}

/**
 * Substring presence proves provenance, never meaning: a figure that appears in a fetched page may
 * still be the wrong figure for the question. So this only reports the case where NOTHING in the
 * answer traces to fetched text, which is the difference between a grounded answer and an invented
 * one, and keeps a derived value (a computed percentage, say) from raising a false alarm.
 */
export function verifyFigures(
  message: string,
  evidence: readonly string[],
): FigureVerification {
  const prose = collectProse(message).join("\n");
  const figures = [...new Set(prose.match(MEASURED_FIGURE) ?? [])];
  if (!figures.length) return "ok";
  if (!evidence.length) return "no-evidence";
  const haystack = evidence.join("\n");
  const anyMatched = figures.some((figure) =>
    figureVariants(figure).some((variant) => haystack.includes(variant)),
  );
  return anyMatched ? "ok" : "unmatched";
}

export function appendWebSourcesToMessage(
  message: string,
  sources: readonly WebSearchSource[],
  options?: {
    /** 1-based numbers of pages fetched during this turn; listed whether or not they were cited. */
    readThisTurn?: readonly number[];
    figures?: FigureVerification;
  },
): string {
  const normalized = normalizeCitationMarkers(message);
  if (!normalized.trim()) return message;

  const notice =
    options?.figures && options.figures !== "ok"
      ? FIGURE_NOTICES[options.figures]
      : null;
  const withNotice = notice ? `${normalized.trim()}\n\n${notice}` : normalized;
  if (!sources.length) return withNotice;

  // Ground truth first: anything fetched this turn is listed even when the model cited nothing,
  // so a missing citation can no longer hide which pages an answer was built from.
  const listed = new Set<number>(
    (options?.readThisTurn ?? []).filter(
      (number) => Number.isInteger(number) && number >= 1 && number <= sources.length,
    ),
  );
  // Sources carried over from earlier turns are listed only where this answer cites them.
  marked.walkTokens(marked.lexer(normalized), (token) => {
    if (token.type !== "text") return;
    for (const match of token.raw.matchAll(/\[(\d+)\]/g)) {
      const number = Number(match[1]);
      if (number >= 1 && number <= sources.length) listed.add(number);
    }
  });
  if (!listed.size) return withNotice;

  const links = [...listed]
    .sort((a, b) => a - b)
    .map((number) => {
      const source = sources[number - 1]!;
      // Explicit labels preserve citation numbers when only a subset is used.
      return `- [${number}] [${source.title}](<${source.url}>)`;
    });
  return `${withNotice.trim()}\n\nSources:\n${links.join("\n")}`;
}
