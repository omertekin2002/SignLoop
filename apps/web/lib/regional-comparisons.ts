import { isSubstantiveText, type AnalysisResult } from "@/lib/schemas";
import { isRecord } from "@/lib/utils";

export type RegionalComparison = AnalysisResult["normal_in_region"][number];

/** Longest jurisdiction a user can confirm; migration 019 enforces the same bound. */
export const MAX_JURISDICTION_LENGTH = 100;

/**
 * The region a user confirmed for an analysis, as the prompt shows it, or null when none was.
 * Placeholders such as "Unknown" are not a confirmation. The prompt builder and the stored-report
 * finalization both read it here, so they agree on whether comparisons may be requested and kept.
 */
export function confirmedRegion(
  region: string | null | undefined,
): string | null {
  // Cut by code points, as PostgreSQL counts them: a split surrogate pair cannot be stored as JSON.
  const normalized =
    typeof region === "string"
      ? Array.from(region.trim().replace(/\s+/g, " "))
          .slice(0, MAX_JURISDICTION_LENGTH)
          .join("")
          .trim()
      : "";
  return isSubstantiveText(normalized) ? normalized : null;
}

/**
 * The body of PATCH /api/contracts/[id]: exactly `{ "jurisdiction": string | null }`. A string is
 * stored as confirmedRegion normalizes it; null clears the confirmation. Returns null for anything
 * else, including placeholders and values too long to keep without cutting them.
 */
export function parseJurisdictionUpdate(
  body: unknown,
): { jurisdiction: string | null } | null {
  if (!isRecord(body) || Object.keys(body).join() !== "jurisdiction") {
    return null;
  }
  const { jurisdiction } = body;
  if (jurisdiction === null) return { jurisdiction: null };
  if (
    typeof jurisdiction !== "string" ||
    Array.from(jurisdiction.trim().replace(/\s+/g, " ")).length >
      MAX_JURISDICTION_LENGTH
  ) {
    return null;
  }
  const confirmed = confirmedRegion(jurisdiction);
  return confirmed ? { jurisdiction: confirmed } : null;
}

/**
 * The server-owned comparison fields of a stored report; whatever the model sent is replaced.
 * Without a confirmed region every comparison is withheld. With one, only comparisons that name
 * the jurisdiction they assume are kept, as the prompt requires.
 */
export function withholdUnsupportedComparisons(
  comparisons: unknown,
  region: string | null | undefined,
): { normal_in_region: unknown[]; comparisons_withheld: boolean } {
  if (!confirmedRegion(region)) {
    return { normal_in_region: [], comparisons_withheld: true };
  }
  return {
    normal_in_region: (Array.isArray(comparisons) ? comparisons : []).filter(
      (item) =>
        isRecord(item) &&
        typeof item.jurisdiction === "string" &&
        isSubstantiveText(item.jurisdiction),
    ),
    comparisons_withheld: false,
  };
}

export type RegionalComparisonsView =
  | { status: "withheld" }
  | { status: "confirmed" | "unconfirmed"; items: RegionalComparison[] };

/**
 * How a report presents its comparisons, or null when it has none to show. Reports saved before
 * comparisons were withheld carry no flag; their comparisons stay visible, marked unconfirmed.
 */
export function regionalComparisonsView(
  result: Partial<AnalysisResult>,
): RegionalComparisonsView | null {
  if (result.comparisons_withheld === true) return { status: "withheld" };
  const items = (
    Array.isArray(result.normal_in_region) ? result.normal_in_region : []
  ).filter((item): item is RegionalComparison => isRecord(item));
  if (!items.length) return null;
  const confirmed =
    result.comparisons_withheld === false &&
    items.every((item) => isSubstantiveText(item.jurisdiction));
  return { status: confirmed ? "confirmed" : "unconfirmed", items };
}
