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
import { isNoticePeriodStated } from "@/lib/notice-period";
import { isRenewalStated } from "@/lib/renewal";
import { isPaymentStated } from "@/lib/payment";
import { isTermStated } from "@/lib/term";
import {
  LISTED_FEES,
  LISTED_OBLIGATIONS,
  LISTED_PENALTIES,
  type ListedFact,
} from "@/lib/listed-citations";
import {
  citeKeyDates,
  KEY_DATE_CITATIONS,
  KEY_DATE_EVIDENCE,
  KEY_DATES,
} from "@/lib/key-date-citations";
import { isRecord } from "@/lib/utils";

export function contractSourceRevision(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * Always discard model-supplied receipts, even if they claim to be verified. Red flags, the
 * jurisdiction proposal, the cancellation notice period, each cancellation penalty, renewal,
 * payment, each extra fee, the term, each obligation and each key date get server-verified
 * citations instead.
 */
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
  // Summary facts keep their values either way; only a verified quotation of the clause stating one
  // becomes its citation, and only while the fact is stated. A model-sent citation is never kept.
  const summary = isRecord(result.summary) ? result.summary : null;
  const citeFact = (
    group: string,
    evidenceKey: string,
    citationKey: string,
    stated: (fact: Record<string, unknown>) => boolean,
  ): Record<string, Record<string, unknown>> => {
    const fact = isRecord(summary?.[group]) ? summary[group] : null;
    if (!fact) return {};
    const {
      [evidenceKey]: evidence,
      [citationKey]: _untrusted,
      ...rest
    } = fact;
    return {
      [group]: {
        ...rest,
        [citationKey]: stated(rest) ? verifiedCitation(evidence) : null,
      },
    };
  };
  // Each item of a cited list (penalties, fees, obligations) gets the first proposal naming exactly
  // its text whose quotation verifies. Proposals for any other text are discarded, a model-sent
  // citation is never kept, and the items themselves are always kept. `container` is the object
  // holding the list (`listedContainer`): a summary group, or the report for a root list.
  const citeItems = (
    fact: ListedFact,
    container: Record<string, unknown>,
  ): Record<string, unknown> => {
    const {
      [fact.evidence]: proposals,
      [fact.citations]: _untrusted,
      ...rest
    } = container;
    const listed = rest[fact.list];
    const items = Array.isArray(listed)
      ? listed.filter((item): item is string => typeof item === "string")
      : [];
    const offered = Array.isArray(proposals) ? proposals.filter(isRecord) : [];
    const citations = [...new Set(items)].flatMap((item) => {
      const citation =
        offered
          .filter((proposal) => proposal[fact.item] === item)
          .map(verifiedCitation)
          .find(Boolean) ?? null;
      return citation ? [{ [fact.item]: item, citation }] : [];
    });
    return { ...rest, [fact.citations]: citations };
  };
  const citeListed = (
    fact: ListedFact & { group: string },
    cited: Record<string, Record<string, unknown>>,
  ) => {
    const group = cited[fact.group];
    return group ? { ...cited, [fact.group]: citeItems(fact, group) } : cited;
  };
  const citedSummary = summary
    ? {
        ...summary,
        ...citeListed(
          LISTED_PENALTIES,
          citeFact(
            "cancellation",
            "notice_evidence",
            "notice_citation",
            isNoticePeriodStated,
          ),
        ),
        ...citeFact(
          "renewal",
          "renewal_evidence",
          "renewal_citation",
          isRenewalStated,
        ),
        ...citeListed(
          LISTED_FEES,
          citeFact(
            "payments",
            "payment_evidence",
            "payment_citation",
            isPaymentStated,
          ),
        ),
        ...citeFact("term", "term_evidence", "term_citation", isTermStated),
      }
    : null;
  // Obligations sit at the report's root, so their proposals and citations do too. A result that
  // mentions none of the three fields is left as it is, as a summary without that group is.
  const mentionsObligations = [
    LISTED_OBLIGATIONS.list,
    LISTED_OBLIGATIONS.evidence,
    LISTED_OBLIGATIONS.citations,
  ].some((key) => key in result);
  const obligations = mentionsObligations
    ? (citeItems(LISTED_OBLIGATIONS, result) as T)
    : result;
  // Key dates sit at the report's root too. Each listed date (by its exact type and date) gets the
  // first proposal naming exactly that date whose quotation verifies; the dates are always kept.
  const mentionsKeyDates = [KEY_DATES, KEY_DATE_EVIDENCE, KEY_DATE_CITATIONS].some(
    (key) => key in obligations,
  );
  const keyDates = (() => {
    if (!mentionsKeyDates) return obligations;
    const {
      [KEY_DATE_EVIDENCE]: proposals,
      [KEY_DATE_CITATIONS]: _untrusted,
      ...rest
    } = obligations as Record<string, unknown>;
    return {
      ...rest,
      [KEY_DATE_CITATIONS]: citeKeyDates(
        rest[KEY_DATES],
        proposals,
        verifiedCitation,
      ),
    } as unknown as T;
  })();
  return {
    ...keyDates,
    source,
    ...(flags ? { red_flags: flags } : {}),
    ...(citedSummary ? { summary: citedSummary as T["summary"] } : {}),
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
