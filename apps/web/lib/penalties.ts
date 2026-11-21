// Dependency-free so source-citations can resolve penalty citations without importing schemas.

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The citation stored for exactly this cancellation penalty's text in a report's
 * `summary.cancellation.penalty_citations`, or null. Citations are keyed by the penalty's exact
 * text, never by position, so one penalty's quotation is never shown beside another. Callers still
 * validate what it returns (`citationForReport`).
 */
export function penaltyCitation(cancellation: unknown, penalty: unknown): unknown {
  if (!isObject(cancellation) || typeof penalty !== "string") return null;
  const entries = cancellation.penalty_citations;
  if (!Array.isArray(entries)) return null;
  const entry = entries.find(
    (item) => isObject(item) && item.penalty === penalty,
  );
  return isObject(entry) ? (entry.citation ?? null) : null;
}

/** A citation reference to the penalty at `index` in a stored report's `penalties`. */
export type PenaltyCitationRef = `penalty-${number}`;

export const PENALTY_CITATION_PATTERN = /^penalty-(\d{1,3})$/;

export function penaltyCitationRef(index: number): PenaltyCitationRef {
  return `penalty-${index}`;
}

/** The penalty index a reference names, or null when it is not a penalty reference. */
export function penaltyCitationIndex(ref: unknown): number | null {
  const match =
    typeof ref === "string" ? PENALTY_CITATION_PATTERN.exec(ref) : null;
  return match ? Number(match[1]) : null;
}
