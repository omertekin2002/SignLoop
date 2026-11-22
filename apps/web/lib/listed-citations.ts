// Dependency-free so source-citations can resolve listed citations without importing schemas.

/**
 * A report list whose entries each get their own server-verified quotation: the model proposes
 * `evidence` entries naming an item's exact text, and attachAnalysisSources stores `citations`
 * entries, `{ [item]: text, citation }`, for the listed items whose proposal verifies. Citations are
 * keyed by the item's exact text, never by position, so one item's quotation is never shown beside
 * another. The source viewer names an item by its index in the stored list (`<prefix>-<n>`).
 *
 * The list, its evidence and its citations sit side by side in one object, the list's container:
 * a `summary` group (`summary.cancellation`, `summary.payments`), or the report itself.
 */
export type ListedFact = {
  /** The `summary` group holding the list, or null for a list at the report's root. */
  readonly group: string | null;
  /** The list of item texts in that container. */
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

/** Each obligation (`obligations`, at the report's root). */
export const LISTED_OBLIGATIONS = {
  group: null,
  list: "obligations",
  item: "obligation",
  evidence: "obligation_evidence",
  citations: "obligation_citations",
  prefix: "obligation",
} as const satisfies ListedFact;

export const LISTED_FACTS = [
  LISTED_PENALTIES,
  LISTED_FEES,
  LISTED_OBLIGATIONS,
] as const;

/** One of the cited lists, with its literal field names. */
export type KnownListedFact = (typeof LISTED_FACTS)[number];

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The object holding a list, its evidence and its citations in a report: its `summary` group, or
 * the report itself for a root list. Null when the report has no such object.
 */
export function listedContainer(
  fact: ListedFact,
  report: unknown,
): Record<string, unknown> | null {
  if (!isObject(report)) return null;
  if (fact.group === null) return report;
  const summary = report.summary;
  const group = isObject(summary) ? summary[fact.group] : null;
  return isObject(group) ? group : null;
}

/**
 * The citation stored for exactly this item's text in a list's container (`listedContainer`: for
 * example `summary.cancellation` for a penalty, or the report for an obligation), or null. Callers
 * still validate what it returns (`citationForReport`).
 */
export function listedCitation(
  fact: ListedFact,
  container: unknown,
  item: unknown,
): unknown {
  if (!isObject(container) || typeof item !== "string") return null;
  const entries = container[fact.citations];
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

/**
 * Whether a value is a reference to an item of any cited list (`penalty-<n>`, `fee-<n>`,
 * `obligation-<n>`).
 */
export function isListedCitationRef(ref: unknown): ref is ListedCitationRef {
  return LISTED_FACTS.some((fact) => listedCitationIndex(fact, ref) !== null);
}

/** The citation a listed reference names in a stored report, or null. */
export function storedListedCitation(report: unknown, ref: unknown): unknown {
  for (const fact of LISTED_FACTS) {
    const index = listedCitationIndex(fact, ref);
    if (index === null) continue;
    const container = listedContainer(fact, report);
    const items = container?.[fact.list];
    return Array.isArray(items)
      ? listedCitation(fact, container, items[index])
      : null;
  }
  return null;
}
