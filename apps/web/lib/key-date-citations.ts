// Dependency-free so source-citations can resolve key-date citations without importing schemas.

/**
 * Each key date (`key_dates`, at the report's root) gets its own server-verified quotation, like the
 * items of a cited list (`lib/listed-citations.ts`). Key dates are objects rather than strings, so
 * one is identified by its exact `type` and `date` pair instead of its text: the model proposes
 * `key_date_evidence` entries `{ type, date, quote, segment }`, and attachAnalysisSources stores
 * `key_date_citations` entries `{ type, date, citation }` for the listed dates whose proposal
 * verifies. Never keyed by position, so one date's quotation is never shown beside another's, even
 * two dates of the same type or the same date of two types. The source viewer names a date by its
 * index in the stored list (`key-date-<n>`).
 *
 * Display-only: a quotation shows which clause a date comes from. It does not make a date worked
 * out from that clause (such as a notice cutoff counted back from a renewal) correct, and nothing
 * creates deadlines, reminders or calendar entries from key dates.
 */
export const KEY_DATES = "key_dates";
export const KEY_DATE_EVIDENCE = "key_date_evidence";
export const KEY_DATE_CITATIONS = "key_date_citations";
const KEY_DATE_PREFIX = "key-date";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A key date's identity: its exact type and date, or null for an entry without both. */
export function keyDateIdentity(
  value: unknown,
): { type: string; date: string } | null {
  if (!isObject(value)) return null;
  const { type, date } = value;
  return typeof type === "string" && typeof date === "string"
    ? { type, date }
    : null;
}

/** Whether an evidence or citation entry names exactly this key date: the same type and date. */
export function namesKeyDate(entry: unknown, keyDate: unknown): boolean {
  const named = keyDateIdentity(entry);
  const listed = keyDateIdentity(keyDate);
  return Boolean(
    named && listed && named.type === listed.type && named.date === listed.date,
  );
}

/**
 * The citation stored in a report for exactly this key date's type and date, or null. Callers still
 * validate what it returns (`citationForReport`).
 */
export function keyDateCitation(report: unknown, keyDate: unknown): unknown {
  if (!isObject(report) || !keyDateIdentity(keyDate)) return null;
  const entries = report[KEY_DATE_CITATIONS];
  if (!Array.isArray(entries)) return null;
  const entry = entries.find((candidate) => namesKeyDate(candidate, keyDate));
  return isObject(entry) ? (entry.citation ?? null) : null;
}

/** A citation reference to the key date at an index in a stored report's `key_dates`. */
export type KeyDateCitationRef = `key-date-${number}`;

export function keyDateCitationRef(index: number): KeyDateCitationRef {
  return `${KEY_DATE_PREFIX}-${index}`;
}

/** The references key dates accept: `key-date-` and an index of at most three digits. */
export const KEY_DATE_CITATION_PATTERN = /^key-date-(\d{1,3})$/;

/** The index a reference names in `key_dates`, or null when it is not a key-date reference. */
export function keyDateCitationIndex(ref: unknown): number | null {
  const match =
    typeof ref === "string" ? KEY_DATE_CITATION_PATTERN.exec(ref) : null;
  return match ? Number(match[1]) : null;
}

export function isKeyDateCitationRef(ref: unknown): ref is KeyDateCitationRef {
  return keyDateCitationIndex(ref) !== null;
}

/** The citation a key-date reference names in a stored report, or null. */
export function storedKeyDateCitation(report: unknown, ref: unknown): unknown {
  const index = keyDateCitationIndex(ref);
  if (index === null || !isObject(report)) return null;
  const dates = report[KEY_DATES];
  return Array.isArray(dates) ? keyDateCitation(report, dates[index]) : null;
}

/**
 * The verified citations for a report's key dates: one `{ type, date, citation }` per distinct
 * listed date whose first proposal naming exactly its type and date verifies (`verify` returns the
 * citation, or null). Proposals for any other date are discarded.
 */
export function citeKeyDates(
  keyDates: unknown,
  proposals: unknown,
  verify: (proposal: Record<string, unknown>) => unknown,
): { type: string; date: string; citation: unknown }[] {
  const listed = Array.isArray(keyDates) ? keyDates : [];
  const offered = Array.isArray(proposals) ? proposals.filter(isObject) : [];
  const seen = new Set<string>();
  return listed.flatMap((keyDate) => {
    const identity = keyDateIdentity(keyDate);
    if (!identity) return [];
    const key = JSON.stringify([identity.type, identity.date]);
    if (seen.has(key)) return [];
    seen.add(key);
    const citation =
      offered
        .filter((proposal) => namesKeyDate(proposal, identity))
        .map(verify)
        .find(Boolean) ?? null;
    return citation ? [{ ...identity, citation }] : [];
  });
}
