// Dependency-free so schemas and notice-period can share it without importing each other.
const NON_SUBSTANTIVE_VALUES = new Set([
  "",
  "unknown",
  "undetermined",
  "unspecified",
  "not specified",
  "not provided",
  "not available",
  "not found",
  "not applicable",
  "no information provided",
  "cannot determine",
  "n/a",
  "none",
  "none identified",
  "contract analysis",
  "general term",
  "general risk",
  "potential risk identified",
  "contract clarification request",
]);

/** False for placeholders such as "Not specified"; the evaluation suite scores these as abstentions. */
export function isSubstantiveText(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .trim();
  return !NON_SUBSTANTIVE_VALUES.has(normalized);
}
