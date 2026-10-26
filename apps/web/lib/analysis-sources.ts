import { createHash } from "node:crypto";
import {
  confirmedRegion,
  withholdUnsupportedComparisons,
} from "@/lib/regional-comparisons";
import {
  contractAnalysisSegments,
  verifyQuote,
  type SourceCitation,
} from "@/lib/source-citations";
import { isRecord } from "@/lib/utils";

export function contractSourceRevision(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** Always discard model-supplied receipts, even if they claim to be verified. */
export function attachAnalysisSources<T extends Record<string, unknown>>(
  result: T,
  contractId: string,
  text: string,
): Omit<T, "proposed_jurisdiction"> & {
  source: {
    contract_id: string;
    revision: string;
    index_unit: "unicode-code-points";
  };
  proposed_jurisdiction: { jurisdiction: string; citation: SourceCitation } | null;
} {
  const source = {
    contract_id: contractId.toLowerCase(),
    revision: contractSourceRevision(text),
    index_unit: "unicode-code-points" as const,
  };
  const segments = contractAnalysisSegments(text);
  const verifiedCitation = (evidence: unknown) => {
    const match = verifyQuote(evidence, segments);
    return match ? { ...source, ...match, status: "verified" as const } : null;
  };
  const flags = Array.isArray(result.red_flags)
    ? result.red_flags.map((flag: unknown) => {
        if (!flag || typeof flag !== "object" || Array.isArray(flag))
          return flag;
        const {
          citation: _untrusted,
          evidence,
          ...rest
        } = flag as Record<string, unknown>;
        return { ...rest, citation: verifiedCitation(evidence) };
      })
    : undefined;
  // A jurisdiction proposal is kept only with a verified quotation of its governing-law clause.
  // An unverifiable or missing quotation means no proposal, never an unsupported one.
  const proposal = isRecord(result.proposed_jurisdiction)
    ? result.proposed_jurisdiction
    : null;
  const jurisdiction = confirmedRegion(
    typeof proposal?.jurisdiction === "string" ? proposal.jurisdiction : null,
  );
  const proposalCitation = jurisdiction
    ? verifiedCitation(proposal?.evidence)
    : null;
  return {
    ...result,
    source,
    ...(flags ? { red_flags: flags } : {}),
    proposed_jurisdiction:
      jurisdiction && proposalCitation
        ? { jurisdiction, citation: proposalCitation }
        : null,
  };
}

/**
 * Everything the analyze route does to a model result before storing it: extraction-quality
 * warnings from the contract and its context documents lead the coverage notices, regional
 * comparisons are withheld unless a region was confirmed (which is recorded with the report), then
 * model evidence is replaced by server-verified citations and an unverified jurisdiction proposal
 * is dropped. The evaluation harness calls this too, so scored output cannot drift
 * from what users see.
 */
export function finalizeAnalysisResult<
  T extends Record<string, unknown> & { coverage_notices?: readonly string[] },
>(
  result: T,
  contract: {
    id: string;
    text: string;
    extractionWarning?: string | null;
    /** The jurisdiction the user confirmed, as given to analyzeText, or null when none is. */
    region?: string | null;
  },
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
      ...withholdUnsupportedComparisons(result.normal_in_region, contract.region),
      comparison_jurisdiction: confirmedRegion(contract.region),
    },
    contract.id,
    contract.text,
  );
}
