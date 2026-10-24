/**
 * How a turn uses the public research tools (search_web, read_url, http_get):
 * - "auto": offered when configured; the model decides whether to use them.
 * - "always": the answer must rest on text fetched this turn with read_url or a 2xx http_get.
 *   Answer deltas are held back until that is confirmed, and the turn fails with
 *   ResearchUnavailableError otherwise.
 * - "never": not offered, even when configured.
 */
export const RESEARCH_MODES = ["auto", "always", "never"] as const;
export type ResearchMode = (typeof RESEARCH_MODES)[number];

/** Parse a caller-supplied mode; absent means "auto", anything unknown is null. */
export function parseResearchMode(value: unknown): ResearchMode | null {
  if (value === undefined) return "auto";
  return value === "auto" || value === "always" || value === "never"
    ? value
    : null;
}

/** Strict research requires fresh fetched evidence, not a search snippet or an earlier catalog. */
export class ResearchUnavailableError extends Error {
  constructor() {
    super("Grounded research is temporarily unavailable.");
    this.name = "ResearchUnavailableError";
  }
}
