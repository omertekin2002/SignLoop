import { createHash } from "node:crypto";
import { contractAnalysisSegments, verifyQuote } from "@/lib/source-citations";

export function contractSourceRevision(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** Always discard model-supplied receipts, even if they claim to be verified. */
export function attachAnalysisSources<T extends Record<string, unknown>>(
  result: T,
  contractId: string,
  text: string,
): T & {
  source: {
    contract_id: string;
    revision: string;
    index_unit: "unicode-code-points";
  };
} {
  const source = {
    contract_id: contractId.toLowerCase(),
    revision: contractSourceRevision(text),
    index_unit: "unicode-code-points" as const,
  };
  const segments = contractAnalysisSegments(text);
  const flags = Array.isArray(result.red_flags)
    ? result.red_flags.map((flag: unknown) => {
        if (!flag || typeof flag !== "object" || Array.isArray(flag))
          return flag;
        const {
          citation: _untrusted,
          evidence,
          ...rest
        } = flag as Record<string, unknown>;
        const match = verifyQuote(evidence, segments);
        return {
          ...rest,
          citation: match ? { ...source, ...match, status: "verified" } : null,
        };
      })
    : undefined;
  return { ...result, source, ...(flags ? { red_flags: flags } : {}) };
}
