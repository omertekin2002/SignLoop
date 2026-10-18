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

/**
 * Everything the analyze route does to a model result before storing it: extraction-quality
 * warnings from the contract and its context documents lead the coverage notices, then model
 * evidence is replaced by server-verified citations. The evaluation harness calls this too, so
 * scored output cannot drift from what users see.
 */
export function finalizeAnalysisResult<
  T extends Record<string, unknown> & { coverage_notices?: readonly string[] },
>(
  result: T,
  contract: { id: string; text: string; extractionWarning?: string | null },
  contextDocuments: readonly {
    title: string;
    extractionWarning?: string | null;
  }[] = [],
) {
  const qualityWarnings = [
    contract.extractionWarning,
    ...contextDocuments.map((document) =>
      document.extractionWarning
        ? `${document.title}: ${document.extractionWarning}`
        : null,
    ),
  ].filter((warning): warning is string => Boolean(warning));
  return attachAnalysisSources(
    {
      ...result,
      coverage_notices: [...qualityWarnings, ...(result.coverage_notices ?? [])],
    },
    contract.id,
    contract.text,
  );
}
