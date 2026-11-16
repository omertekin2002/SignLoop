/** Longest contract title search the list accepts, in code points after trimming. */
export const MAX_CONTRACT_SEARCH_LENGTH = 200;

/**
 * Cut a search to its first MAX_CONTRACT_SEARCH_LENGTH code points, the unit the list routes count.
 * Search boxes use this instead of a native `maxLength`, which counts UTF-16 code units and so
 * stops emoji and other characters outside the Basic Multilingual Plane at half the limit.
 */
export function capContractSearch(value: string): string {
  // A code point is at least one code unit, so a string this short is within the limit.
  if (value.length <= MAX_CONTRACT_SEARCH_LENGTH) return value;
  let codePoints = 0;
  let end = 0;
  // Iterating a string yields whole code points, never half a surrogate pair.
  for (const character of value) {
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
