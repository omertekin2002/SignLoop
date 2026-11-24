import { useId, useMemo, type ReactNode } from "react";
import Link from "next/link";
import { ClipboardCheck, MessagesSquare } from "lucide-react";
import {
  clarifyBeforeSigning,
  NO_VERIFIED_QUOTATION,
  NOT_SPECIFIED,
  quotationStatusLine,
} from "@/lib/analysis-clarify";
import {
  askAboutItemHref,
  findingItemKey,
  questionItemKey,
  unstatedItemKey,
  unverifiedItemKey,
  type ClarifyItemKey,
} from "@/lib/clarify-ask";
import type { AnalysisResult } from "@/lib/schemas";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** The id of a finding in the Findings and draft emails card, which the checklist links to. */
export function findingAnchor(number: number): string {
  return `finding-${number}`;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-2 text-sm font-medium text-muted-foreground">{title}</h4>
      {children}
    </section>
  );
}

const MARKER =
  "ml-2 inline-block rounded border border-border px-2 py-0.5 text-xs text-muted-foreground";

/**
 * Opens a new saved chat about this item with an editable question drafted from it. The link holds
 * only the contract's and analysis's ids and the item's key; the label names the item.
 */
function AskLink({
  contractId,
  analysisId,
  itemKey,
  label,
}: {
  contractId: string;
  analysisId: string;
  itemKey: ClarifyItemKey;
  label: string;
}) {
  return (
    <Link
      href={askAboutItemHref(contractId, analysisId, itemKey)}
      aria-label={label}
      className="ml-2 inline-flex items-center gap-1 rounded text-xs text-highlight underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <MessagesSquare className="h-3 w-3" aria-hidden="true" />
      Ask
    </Link>
  );
}

/**
 * What to clarify before signing, from the same checklist as the brief's "Before you sign: what to
 * clarify" section (`clarifyBeforeSigning`): coverage gaps, stated facts without a verified
 * quotation, facts not stated, findings (each linking to its entry in the Findings and draft emails
 * card) and the analysis's questions. Built from the stored analysis the page already holds; it never says there is nothing to clarify.
 *
 * With `askAnalysisId` (the analysis shown, given only when the contract has text a chat can read),
 * every item except coverage gaps gets an Ask link. Coverage gaps get none: a chat reads the same
 * extracted text, so it cannot see what the analysis did not.
 */
export function BeforeYouSign({
  contractId,
  extractionWarning,
  result,
  askAnalysisId = null,
}: {
  contractId: string;
  extractionWarning: string | null;
  result: Partial<AnalysisResult> | null;
  askAnalysisId?: string | null;
}) {
  const checklist = useMemo(
    () =>
      clarifyBeforeSigning({ contractId, extractionWarning, resultJson: result }),
    [contractId, extractionWarning, result],
  );
  const status = quotationStatusLine(checklist);
  const titleId = useId();
  const ask = (itemKey: ClarifyItemKey, label: string) =>
    askAnalysisId ? (
      <AskLink
        contractId={contractId}
        analysisId={askAnalysisId}
        itemKey={itemKey}
        label={label}
      />
    ) : null;

  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle id={titleId} className="flex items-center gap-2">
          <ClipboardCheck className="h-5 w-5" aria-hidden="true" />
          Before you sign: what to clarify
        </CardTitle>
        <CardDescription>
          What to clarify, built from this analysis. The full facts and
          findings are in the cards below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        {checklist.coverageGaps.length > 0 && (
          <Group title="Coverage gaps">
            <ul className="space-y-2 rounded-card border border-highlight/40 bg-highlight/[0.06] px-4 py-3">
              {checklist.coverageGaps.map((gap, index) => (
                <li key={index}>
                  <span className="text-highlight">{gap.label}:</span>{" "}
                  {gap.text}
                </li>
              ))}
            </ul>
          </Group>
        )}

        {status ? (
          <p>{status}</p>
        ) : (
          checklist.unverified.length > 0 && (
            <Group title="Stated without a verified quotation">
              <ul className="list-disc space-y-2 pl-5">
                {checklist.unverified.map((fact, index) => (
                  <li key={index}>
                    <span className="font-medium">{fact.fact}:</span>{" "}
                    {fact.value}
                    <span className={MARKER}>{NO_VERIFIED_QUOTATION}</span>
                    {ask(
                      unverifiedItemKey(index),
                      `Ask about ${fact.fact}: ${fact.value}`,
                    )}
                  </li>
                ))}
              </ul>
            </Group>
          )
        )}

        {checklist.unstated.length > 0 && (
          <Group title="Not stated">
            <ul className="list-disc space-y-2 pl-5">
              {checklist.unstated.map((fact) => (
                <li key={fact.fact}>
                  <span className="font-medium">{fact.fact}:</span>
                  <span className={MARKER}>{NOT_SPECIFIED}</span>
                  {ask(unstatedItemKey(fact.fact), `Ask about ${fact.fact}`)}
                </li>
              ))}
            </ul>
          </Group>
        )}

        {checklist.findings.length > 0 && (
          <Group title="Findings">
            <ul className="list-disc space-y-2 pl-5">
              {checklist.findings.map((finding) => {
                const duplicateType =
                  checklist.findings.filter(
                    (other) =>
                      other.type.trim().toLowerCase() ===
                      finding.type.trim().toLowerCase(),
                  ).length > 1;
                return (
                  <li key={finding.number}>
                    <a
                      href={`#${findingAnchor(finding.number)}`}
                      className="text-highlight underline underline-offset-4"
                    >
                      {finding.type}
                    </a>{" "}
                    <span className="text-muted-foreground">
                      {finding.severity === null
                        ? "(severity not provided)"
                        : `(severity ${finding.severity}/10)`}
                    </span>
                    {ask(
                      findingItemKey(finding.number),
                      duplicateType
                        ? `Ask about finding ${finding.number}: ${finding.type}`
                        : `Ask about finding: ${finding.type}`,
                    )}
                  </li>
                );
              })}
            </ul>
          </Group>
        )}

        {checklist.questions.length > 0 && (
          <Group title="Questions to Ask">
            <ol className="list-decimal space-y-2 pl-5">
              {checklist.questions.map((question, index) => (
                <li key={index}>
                  {/* Its own element, so the question's text stays whole beside its Ask link. */}
                  <span>{question}</span>
                  {ask(questionItemKey(index), `Ask question ${index + 1}`)}
                </li>
              ))}
            </ol>
          </Group>
        )}
      </CardContent>
    </Card>
  );
}
