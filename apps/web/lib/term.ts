import { isSubstantiveText } from "@/lib/substantive-text";

/**
 * True when the report states the term: a start, an end or a minimum term. Only a stated term can
 * carry a source quotation; an unknown term keeps its "Not specified" text and no citation.
 */
export function isTermStated(term: {
  start?: unknown;
  end?: unknown;
  minimum_term?: unknown;
}): boolean {
  return [term.start, term.end, term.minimum_term].some(
    (value) => typeof value === "string" && isSubstantiveText(value),
  );
}
