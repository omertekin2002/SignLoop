// Dependency-free so source-citations can resolve listed citations without importing schemas.

/**
 * A summary list whose entries each get their own server-verified quotation: the model proposes
 * `evidence` entries naming an item's exact text, and attachAnalysisSources stores `citations`
 * entries, `{ [item]: text, citation }`, for the listed items whose proposal verifies. Citations are
 * keyed by the item's exact text, never by position, so one item's quotation is never shown beside
 * another. The source viewer names an item by its index in the stored list (`<prefix>-<n>`).
 */
export type ListedFact = {
  /** The `summary` group holding the list. */
  readonly group: string;
  /** The list of item texts in that group. */
  readonly list: string;
  /** The key naming an item's text in its evidence and citation entries. */
  readonly item: string;
  /** The model's proposals. */
  readonly evidence: string;
  /** The server-verified citations. */
  readonly citations: string;
  /** The citation reference prefix. */
  readonly prefix: string;
};

/** Each cancellation penalty (`summary.cancellation.penalties`). */
export const LISTED_PENALTIES = {
  group: "cancellation",
  list: "penalties",
  item: "penalty",
  evidence: "penalty_evidence",
  citations: "penalty_citations",
  prefix: "penalty",
} as const satisfies ListedFact;

/** Each extra fee (`summary.payments.fees`). */
export const LISTED_FEES = {
  group: "payments",
  list: "fees",
  item: "fee",
  evidence: "fee_evidence",
  citations: "fee_citations",
  prefix: "fee",
} as const satisfies ListedFact;

export const LISTED_FACTS = [LISTED_PENALTIES, LISTED_FEES] as const;

/** One of the cited lists, with its literal field names. */
export type KnownListedFact = (typeof LISTED_FACTS)[number];

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The citation stored for exactly this item's text in a report's summary group (for example
 * `summary.cancellation` for a penalty), or null. Callers still validate what it returns
 * (`citationForReport`).
 */
export function listedCitation(
  fact: ListedFact,
  group: unknown,
  item: unknown,
): unknown {
  if (!isObject(group) || typeof item !== "string") return null;
  const entries = group[fact.citations];
  if (!Array.isArray(entries)) return null;
  const entry = entries.find(
    (candidate) => isObject(candidate) && candidate[fact.item] === item,
  );
  return isObject(entry) ? (entry.citation ?? null) : null;
}

/** A citation reference to the item at an index in a stored report's list, e.g. `fee-0`. */
export type ListedCitationRef<F extends ListedFact = KnownListedFact> =
  `${F["prefix"]}-${number}`;

export function listedCitationRef<F extends ListedFact>(
  fact: F,
  index: number,
): ListedCitationRef<F> {
  return `${fact.prefix}-${index}` as ListedCitationRef<F>;
}

/** The references a list accepts: its prefix and an index of at most three digits. */
export function listedCitationPattern(fact: ListedFact): RegExp {
  return new RegExp(`^${fact.prefix}-(\\d{1,3})$`);
}

/** The index a reference names in this list, or null when it is not a reference to this list. */
export function listedCitationIndex(
  fact: ListedFact,
  ref: unknown,
): number | null {
  const match =
    typeof ref === "string" ? listedCitationPattern(fact).exec(ref) : null;
  return match ? Number(match[1]) : null;
}

/** Whether a value is a reference to an item of any cited list (`penalty-<n>`, `fee-<n>`). */
export function isListedCitationRef(ref: unknown): ref is ListedCitationRef {
  return LISTED_FACTS.some((fact) => listedCitationIndex(fact, ref) !== null);
}

/** The citation a listed reference names in a report's `summary`, or null. */
export function storedListedCitation(summary: unknown, ref: unknown): unknown {
  for (const fact of LISTED_FACTS) {
    const index = listedCitationIndex(fact, ref);
    if (index === null) continue;
    const group = isObject(summary) ? summary[fact.group] : null;
    const items = isObject(group) ? group[fact.list] : null;
    return Array.isArray(items) ? listedCitation(fact, group, items[index]) : null;
  }
  return null;
}
