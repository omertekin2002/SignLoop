import { useId, type ReactNode } from "react";
import {
  AlertTriangle,
  Calendar,
  ClipboardList,
  Clock,
  DollarSign,
  FileText,
  Mail,
  RefreshCw,
  Shield,
  XCircle,
} from "lucide-react";
import type { AnalysisResult } from "@/lib/schemas";
import { regionalComparisonsView } from "@/lib/regional-comparisons";
import { cn, getRiskColor } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BeforeYouSign, findingAnchor } from "@/components/before-you-sign";
import {
  FeesSource,
  FindingSource,
  KeyDateSource,
  NoticePeriodSource,
  ObligationsSource,
  PaymentSource,
  PenaltiesSource,
  RenewalSource,
  TermSource,
} from "@/components/contract-source";

const NONE_IDENTIFIED = "None identified in this analysis.";
const NOT_SPECIFIED = "Not specified";
const BOX = "rounded-lg bg-muted/40 p-4";
const LABEL = "mb-1 flex items-center gap-1 text-sm font-medium text-muted-foreground";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function texts(values: unknown): string[] {
  return Array.isArray(values)
    ? values.filter(
        (value): value is string =>
          typeof value === "string" && Boolean(value.trim()),
      )
    : [];
}

function TextList({ values }: { values: unknown }) {
  const items = texts(values);
  return items.length ? (
    <ul className="list-disc space-y-2 pl-5">
      {items.map((value, index) => (
        <li key={index}>{value}</li>
      ))}
    </ul>
  ) : (
    <p className="text-muted-foreground">{NONE_IDENTIFIED}</p>
  );
}

/** One of the brief's level-2 sections, as a region named by its card title, the section's heading. */
function DecisionCard({
  title,
  icon,
  description,
  id,
  children,
}: {
  title: string;
  icon: ReactNode;
  description?: string;
  id?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <Card
      id={id}
      role="region"
      aria-labelledby={titleId}
      className={cn(id && "scroll-mt-6")}
    >
      <CardHeader>
        <CardTitle id={titleId} className="flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="text-sm">{children}</CardContent>
    </Card>
  );
}

/** A labelled group inside a card. */
function Group({
  title,
  icon,
  className,
  children,
}: {
  title: string;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className}>
      <h4 className={LABEL}>
        {icon}
        {title}
      </h4>
      {children}
    </section>
  );
}

const ICON = "h-5 w-5";
const SMALL_ICON = "h-4 w-4";

function Overview({
  result,
  riskBadge,
  analyzedOn,
  model,
  extractionWarning,
  stale,
}: {
  result: Partial<AnalysisResult>;
  riskBadge: string;
  analyzedOn: string;
  model: string | null;
  extractionWarning: string | null;
  stale: boolean;
}) {
  const summary = record(result.summary);
  const whatItIs =
    typeof summary.what_it_is === "string" && summary.what_it_is
      ? summary.what_it_is
      : NOT_SPECIFIED;
  const coverageNotices = texts(result.coverage_notices);
  const keyPoints = texts(result.key_points).filter(
    (point) => !coverageNotices.includes(point),
  );
  // A report carries the extraction warning from its own run; the page-level notice already
  // shows the current one, so the same sentence is not repeated under Analysis coverage.
  const reportCoverageNotices = coverageNotices.filter(
    (notice) => notice !== extractionWarning,
  );

  return (
    <DecisionCard title="Overview" icon={<FileText className={ICON} aria-hidden="true" />}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Badge
            className={`px-4 py-1 text-lg ${getRiskColor(riskBadge, { hover: true })}`}
          >
            {riskBadge || "UNKNOWN"}
          </Badge>
          <p className="text-muted-foreground">Analyzed on {analyzedOn}</p>
          {model && (
            <p className="text-xs text-muted-foreground">LLM: {model}</p>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Group title="What it is" className={BOX}>
            <p>{whatItIs}</p>
          </Group>
          <Group title="Parties" className={BOX}>
            <TextList values={result.parties} />
          </Group>
        </div>

        <Group title="Key points">
          {reportCoverageNotices.length > 0 && (
            <div
              role="status"
              className="mb-4 rounded-card border border-highlight/40 bg-highlight/[0.06] px-4 py-3 text-foreground"
            >
              <p className="text-highlight">Analysis coverage</p>
              <ul className="mt-2 list-disc pl-5">
                {reportCoverageNotices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            </div>
          )}
          {stale && (
            <p
              role="status"
              className="mb-4 rounded-card border border-highlight/40 bg-highlight/[0.06] px-4 py-3 text-foreground"
            >
              This analysis uses older evidence. The contract or project
              context has changed; analyze again for a current result.
            </p>
          )}
          {keyPoints.length > 0 ? (
            <ul className="space-y-4">
              {keyPoints.map((point, idx) => (
                <li
                  key={idx}
                  className="flex items-start gap-3 rounded-lg bg-muted/60 p-3"
                >
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-highlight" />
                  <span className="leading-relaxed text-foreground/90">
                    {point}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">{NONE_IDENTIFIED}</p>
          )}
        </Group>
      </div>
    </DecisionCard>
  );
}

/** The regional comparisons that go with the Jurisdiction card, or why they are not shown. */
function RegionalComparisons({ result }: { result: Partial<AnalysisResult> }) {
  const comparisons = regionalComparisonsView(result);
  if (!comparisons) return null;
  if (comparisons.status === "withheld") {
    return (
      <div role="note" className="rounded-card border px-4 py-3 text-sm">
        <p className="text-foreground">Regional comparisons not shown</p>
        <p className="mt-1 text-muted-foreground">
          No jurisdiction was confirmed when this analysis ran, and what is
          typical or allowed depends on where the contract applies. This
          analysis describes risks from the contract text alone. Confirm a
          jurisdiction and re-run the analysis to add comparisons.
        </p>
      </div>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Regional comparisons</CardTitle>
        {/* Reports saved before withholding carry no flag; their comparisons
            were generated against "Region: Unknown". */}
        <CardDescription
          className={cn(comparisons.status === "unconfirmed" && "text-highlight")}
        >
          {comparisons.status === "confirmed"
            ? "Compared with typical practice in the jurisdiction you confirmed. General information, not legal advice."
            : "Generated without a confirmed jurisdiction — treat as general information, not local law."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {comparisons.items.map((item, index) => (
          <section
            key={index}
            className="border-b border-border pb-4 last:border-0 last:pb-0"
          >
            <h4 className="font-medium">
              {item.topic}{" "}
              <span className="text-muted-foreground">({item.label})</span>
            </h4>
            {item.jurisdiction && (
              <p className="mt-1 text-muted-foreground">
                Jurisdiction: {item.jurisdiction}
              </p>
            )}
            <p className="mt-2">Typical: {item.typical_range}</p>
            <p>Your contract: {item.yours || NOT_SPECIFIED}</p>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}

function Findings({ result }: { result: Partial<AnalysisResult> }) {
  const redFlags = Array.isArray(result.red_flags) ? result.red_flags : [];
  if (!redFlags.length) {
    return (
      <p className="text-muted-foreground">
        No red flags were identified in this analysis.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {redFlags.map((flag, idx) => {
        const type = typeof flag?.type === "string" ? flag.type : "Risk";
        const explanation =
          typeof flag?.explanation === "string" ? flag.explanation : "";
        const confidence =
          typeof flag?.confidence === "number"
            ? `${flag.confidence}%`
            : "Not provided";
        const severity =
          typeof flag?.severity === "number" && Number.isFinite(flag.severity)
            ? Math.max(0, Math.min(10, flag.severity))
            : null;
        const where = typeof flag?.where === "string" ? flag.where : "";

        return (
          <div
            key={idx}
            id={findingAnchor(idx + 1)}
            className="scroll-mt-6 rounded-lg border bg-card p-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="mb-2 flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">
                    {type}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    Confidence: {confidence}
                  </span>
                </div>
                <p className="text-sm">
                  {explanation || "No explanation provided."}
                </p>
                <FindingSource index={idx} />
                {where && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Found in: {where}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="text-xs text-muted-foreground">Severity</span>
                {severity !== null ? (
                  <div className="flex items-center gap-1">
                    <div className="h-2 w-16 overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full ${
                          severity >= 7
                            ? "bg-destructive"
                            : severity >= 4
                              ? "bg-highlight"
                              : "bg-success"
                        }`}
                        style={{ width: `${severity * 10}%` }}
                      />
                    </div>
                    <span className="text-xs font-medium">{severity}/10</span>
                  </div>
                ) : (
                  <span className="text-xs font-medium text-muted-foreground">
                    Not provided
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DraftEmails({ result }: { result: Partial<AnalysisResult> }) {
  const templates = Array.isArray(result.next_actions?.email_templates)
    ? result.next_actions.email_templates
    : [];
  if (!templates.length) {
    return (
      <p className="text-muted-foreground">
        No draft emails were suggested in this analysis.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {templates.map((template, idx) => (
        <div key={idx} className="rounded-lg border bg-muted/30 p-3">
          <p className="mb-1 text-sm font-medium">
            Subject:{" "}
            {typeof template?.subject === "string"
              ? template.subject
              : "Untitled"}
          </p>
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">
            {typeof template?.body === "string" ? template.body : ""}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * An analysed contract's report, grouped and ordered like the decision brief's level-2 sections:
 * Overview, Jurisdiction (the page's own card, passed in, then the regional comparisons), Before you
 * sign: what to clarify, Payments and fees, Term, renewal and how it ends, Obligations in the
 * contract, Key dates, and Findings and draft emails, then the disclaimer. Every fact appears once,
 * in its group, with the same quotation or marker as its `*Source` component gives it, and every
 * group shows an empty state instead of disappearing. It needs a `ContractSourceProvider` above it.
 */
export function ContractDecisionSections({
  contractId,
  result,
  extractionWarning,
  riskBadge,
  analyzedOn,
  model,
  stale,
  jurisdiction,
}: {
  contractId: string;
  result: Partial<AnalysisResult>;
  extractionWarning: string | null;
  riskBadge: string;
  analyzedOn: string;
  /** The provider and model line, or null when the analysis does not record its model. */
  model: string | null;
  /** The contract or its context changed after this analysis ran. */
  stale: boolean;
  jurisdiction: ReactNode;
}) {
  const summary = record(result.summary);
  const payments = record(summary.payments);
  const cancellation = record(summary.cancellation);
  const keyDates = Array.isArray(result.key_dates) ? result.key_dates : [];
  const disclaimer =
    typeof result.disclaimer === "string" && result.disclaimer.trim()
      ? result.disclaimer
      : null;

  return (
    <>
      <Overview
        result={result}
        riskBadge={riskBadge}
        analyzedOn={analyzedOn}
        model={model}
        extractionWarning={extractionWarning}
        stale={stale}
      />

      {jurisdiction}
      <RegionalComparisons result={result} />

      {/* What to clarify before signing, from the same checklist as the brief. */}
      <BeforeYouSign
        contractId={contractId}
        extractionWarning={extractionWarning}
        result={result}
      />

      <DecisionCard
        title="Payments and fees"
        icon={<DollarSign className={ICON} aria-hidden="true" />}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Group title="Payment" className={BOX}>
            <PaymentSource payments={payments} />
          </Group>
          <Group title="Fees" className={BOX}>
            <FeesSource fees={payments.fees} />
          </Group>
        </div>
      </DecisionCard>

      <DecisionCard
        title="Term, renewal and how it ends"
        icon={<Clock className={ICON} aria-hidden="true" />}
      >
        <div className="grid gap-4 md:grid-cols-3">
          <Group
            title="Term"
            icon={<Clock className={SMALL_ICON} aria-hidden="true" />}
            className={BOX}
          >
            <TermSource term={record(summary.term)} />
          </Group>
          <Group
            title="Renewal"
            icon={<RefreshCw className={SMALL_ICON} aria-hidden="true" />}
            className={BOX}
          >
            <RenewalSource renewal={record(summary.renewal)} />
          </Group>
          <Group
            title="Cancellation"
            icon={<XCircle className={SMALL_ICON} aria-hidden="true" />}
            className={cn(BOX, "space-y-3")}
          >
            <section>
              <h5 className="text-xs font-medium text-muted-foreground">
                How to cancel
              </h5>
              <p>
                {typeof cancellation.how === "string" && cancellation.how
                  ? cancellation.how
                  : NOT_SPECIFIED}
              </p>
            </section>
            <section>
              <h5 className="text-xs font-medium text-muted-foreground">
                Notice period
              </h5>
              <NoticePeriodSource cancellation={cancellation} />
            </section>
            <section>
              <h5 className="text-xs font-medium text-muted-foreground">
                Penalties
              </h5>
              <PenaltiesSource penalties={cancellation.penalties} />
            </section>
          </Group>
        </div>
      </DecisionCard>

      <DecisionCard
        title="Obligations in the contract"
        icon={<ClipboardList className={ICON} aria-hidden="true" />}
      >
        <p className="mb-3 text-muted-foreground">
          This analysis does not record which party owes each obligation.
        </p>
        <ObligationsSource obligations={result.obligations} />
      </DecisionCard>

      <DecisionCard
        title="Key dates"
        icon={<Calendar className={ICON} aria-hidden="true" />}
      >
        {keyDates.length > 0 ? (
          <ul
            aria-label="Key dates"
            className="grid gap-3 md:grid-cols-2 lg:grid-cols-3"
          >
            {keyDates.map((date, idx) => (
              <li
                key={idx}
                className="flex items-start gap-3 rounded-lg border bg-card p-3"
              >
                <div className="rounded-full bg-primary/10 p-2">
                  <Calendar className="h-4 w-4 text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {typeof date?.type === "string"
                      ? date.type.replace(/_/g, " ")
                      : "DATE"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {typeof date?.date === "string" ? date.date : "Unknown"}
                  </p>
                  {typeof date?.derived_from === "string" &&
                    date.derived_from && (
                      <p className="text-xs italic text-muted-foreground">
                        Analysis’s explanation: {date.derived_from}
                      </p>
                    )}
                  <KeyDateSource index={idx} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{NONE_IDENTIFIED}</p>
        )}
      </DecisionCard>

      {/* Before you sign links each finding here by its anchor. Questions are only there. */}
      <DecisionCard
        id="red-flags"
        title="Findings and draft emails"
        icon={<Shield className={ICON} aria-hidden="true" />}
      >
        <div className="space-y-6">
          <Group
            title="Findings"
            icon={<Shield className={cn(SMALL_ICON, "text-destructive")} aria-hidden="true" />}
          >
            <Findings result={result} />
          </Group>
          <Group
            title="Draft emails"
            icon={<Mail className={cn(SMALL_ICON, "text-primary")} aria-hidden="true" />}
          >
            <DraftEmails result={result} />
          </Group>
        </div>
      </DecisionCard>

      {disclaimer && (
        <p className="text-sm text-muted-foreground">{disclaimer}</p>
      )}
    </>
  );
}
