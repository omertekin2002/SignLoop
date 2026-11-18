/** Longest contract search the list accepts, in code points after trimming. */
export const MAX_CONTRACT_SEARCH_LENGTH = 200;

/**
 * Shortest search, in code points after trimming, that also looks in a contract's extracted text.
 * Shorter searches match titles only: one or two letters would be found in nearly every contract.
 */
export const MIN_CONTRACT_TEXT_SEARCH_LENGTH = 3;

/**
 * Code points of contract text an excerpt shows around a text match, before whitespace is collapsed
 * and cut ends are marked. A search longer than this widens the excerpt just enough to hold it.
 */
export const CONTRACT_SEARCH_EXCERPT_LENGTH = 160;

/**
 * Where a searched contract matched: its title, or else its extracted text, with a short excerpt
 * around the first match. List items carry it only when the list was searched.
 */
export type ContractSearchMatch =
  | { in: "title" }
  | { in: "text"; snippet: string };

/** True when a search is long enough to look in contract text as well as titles. */
export function searchesContractText(search: string): boolean {
  return [...search.trim()].length >= MIN_CONTRACT_TEXT_SEARCH_LENGTH;
}

/** One run of an excerpt: text the search matched, or the text between matches. */
export type ExcerptPart = { text: string; match: boolean };

/**
 * Split an excerpt into the runs a search matched and the text around them, case-insensitively.
 * Whitespace in the search matches any run of whitespace, because excerpts collapse it.
 */
export function splitExcerptMatches(excerpt: string, search: string): ExcerptPart[] {
  const words = search.trim().split(/\s+/u).filter(Boolean);
  if (!excerpt || words.length === 0) return excerpt ? [{ text: excerpt, match: false }] : [];
  const pattern = words
    .map((word) => word.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"))
    .join("\\s+");
  // A capturing group makes split keep the matches: they land at the odd indices.
  return excerpt
    .split(new RegExp(`(${pattern})`, "iu"))
    .map((text, index) => ({ text, match: index % 2 === 1 }))
    .filter((part) => part.text);
}

/**
 * Cut a search box's text so that the search it holds, once trimmed, is at most
 * MAX_CONTRACT_SEARCH_LENGTH code points, the unit the list routes count. Leading whitespace is
 * kept and not counted, because the search is trimmed before it is sent; counting it would cut a
 * search the routes accept. Search boxes use this instead of a native `maxLength`, which counts
 * UTF-16 code units and so stops emoji and other characters outside the Basic Multilingual Plane
 * at half the limit.
 */
export function capContractSearch(value: string): string {
  // A code point is at least one code unit, so a string this short is within the limit.
  if (value.length <= MAX_CONTRACT_SEARCH_LENGTH) return value;
  const search = value.trimStart();
  let codePoints = 0;
  let end = value.length - search.length;
  // Iterating a string yields whole code points, never half a surrogate pair.
  for (const character of search) {
    if (codePoints === MAX_CONTRACT_SEARCH_LENGTH) break;
    codePoints += 1;
    end += character.length;
  }
  return value.slice(0, end);
}

/** Escape LIKE wildcards and the escape character itself so a search term matches literally. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Analysis-status filters for the contracts list, as the `status` query parameter spells them. */
export const CONTRACT_STATUS_FILTERS = {
  analyzed: { label: "Analyzed", description: "analyzed", status: "ANALYZED" },
  draft: { label: "Not analyzed yet", description: "not analyzed yet", status: "DRAFT" },
} as const;

export type ContractStatusFilter = keyof typeof CONTRACT_STATUS_FILTERS;

/** Added-date filters for the contracts list, as the `added` query parameter spells them. */
export const CONTRACT_ADDED_FILTERS = {
  "7d": { label: "Last 7 days", description: "added in the last 7 days", days: 7 },
  "30d": { label: "Last 30 days", description: "added in the last 30 days", days: 30 },
  "365d": { label: "Last 12 months", description: "added in the last 12 months", days: 365 },
} as const;

export type ContractAddedFilter = keyof typeof CONTRACT_ADDED_FILTERS;

/** The optional filters a contracts list request carries besides its title search. */
export type ContractListFilters = {
  status?: ContractStatusFilter | null;
  added?: ContractAddedFilter | null;
};

export function isContractStatusFilter(value: string): value is ContractStatusFilter {
  return Object.hasOwn(CONTRACT_STATUS_FILTERS, value);
}

export function isContractAddedFilter(value: string): value is ContractAddedFilter {
  return Object.hasOwn(CONTRACT_ADDED_FILTERS, value);
}

/** True when a filter narrows the list, which then spans every contract, as a title search does. */
export function hasContractListFilters(filters: ContractListFilters): boolean {
  return Boolean(filters.status || filters.added);
}

/** The active filters in words, e.g. "analyzed, added in the last 30 days", or "" when none is set. */
export function describeContractListFilters(filters: ContractListFilters): string {
  return [
    filters.status ? CONTRACT_STATUS_FILTERS[filters.status].description : null,
    filters.added ? CONTRACT_ADDED_FILTERS[filters.added].description : null,
  ]
    .filter(Boolean)
    .join(", ");
}
