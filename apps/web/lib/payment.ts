import { isSubstantiveText } from "@/lib/substantive-text";

/**
 * True when the report states payment: an amount or a frequency. Only stated payment can carry a
 * source quotation; unknown payment keeps its "Not specified" text and no citation. Fees are not
 * part of it and stay unquoted.
 */
export function isPaymentStated(payments: {
  amount?: unknown;
  frequency?: unknown;
}): boolean {
  return (
    (typeof payments.amount === "string" &&
      isSubstantiveText(payments.amount)) ||
    (typeof payments.frequency === "string" &&
      isSubstantiveText(payments.frequency))
  );
}
