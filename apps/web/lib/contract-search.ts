/** Longest contract title search the list accepts, in code points after trimming. */
export const MAX_CONTRACT_SEARCH_LENGTH = 200;

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
