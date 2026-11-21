import { isSubstantiveText } from "@/lib/substantive-text";

/**
 * True when the report states renewal: whether the contract renews automatically, or a renewal
 * period. Only stated renewal can carry a source quotation; unknown renewal keeps its "Not
 * specified"/"Unknown" text and no citation.
 */
export function isRenewalStated(renewal: {
  auto_renew?: unknown;
  renewal_period?: unknown;
}): boolean {
  return (
    typeof renewal.auto_renew === "boolean" ||
    (typeof renewal.renewal_period === "string" &&
      isSubstantiveText(renewal.renewal_period))
  );
}

/**
 * Whether the contract renews automatically, in the brief's words. "Does not auto-renew" says only
 * what the contract states; it does not claim the contract offers a manual renewal.
 */
export function formatAutoRenew(autoRenew: unknown, unknown: string): string {
  return autoRenew === true
    ? "Auto-renews"
    : autoRenew === false
      ? "Does not auto-renew"
      : unknown;
}
