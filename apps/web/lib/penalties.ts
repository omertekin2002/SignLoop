// The cancellation-penalty names for the shared per-item quotation code in listed-citations.
import {
  LISTED_PENALTIES,
  listedCitation,
  listedCitationIndex,
  listedCitationPattern,
  listedCitationRef,
  type ListedCitationRef,
} from "@/lib/listed-citations";

/**
 * The citation stored for exactly this cancellation penalty's text in a report's
 * `summary.cancellation.penalty_citations`, or null (`listedCitation`).
 */
export function penaltyCitation(cancellation: unknown, penalty: unknown): unknown {
  return listedCitation(LISTED_PENALTIES, cancellation, penalty);
}

/** A citation reference to the penalty at `index` in a stored report's `penalties`. */
export type PenaltyCitationRef = ListedCitationRef<typeof LISTED_PENALTIES>;

export const PENALTY_CITATION_PATTERN = listedCitationPattern(LISTED_PENALTIES);

export function penaltyCitationRef(index: number): PenaltyCitationRef {
  return listedCitationRef(LISTED_PENALTIES, index);
}

/** The penalty index a reference names, or null when it is not a penalty reference. */
export function penaltyCitationIndex(ref: unknown): number | null {
  return listedCitationIndex(LISTED_PENALTIES, ref);
}
