/** Longest contract title search the list accepts, in code points after trimming. */
export const MAX_CONTRACT_SEARCH_LENGTH = 200;

/** Escape LIKE wildcards and the escape character itself so a search term matches literally. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
