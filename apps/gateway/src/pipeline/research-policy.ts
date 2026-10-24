export const RESEARCH_MODES = ["auto", "always", "never"] as const;
export type ResearchMode = (typeof RESEARCH_MODES)[number];

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
