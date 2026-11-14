import type { AnalysisCoverage } from "@/lib/source-citations";
import { cn } from "@/lib/utils";

const count = new Intl.NumberFormat("en-US");

/**
 * Warns before analysis when the contract is longer than one analysis covers, so the owner learns
 * it before spending a request rather than from the finished report's coverage notice. The counts
 * come from GET /api/contracts/[id], computed with the analysis's own segmentation.
 */
export function AnalysisCoverageNotice({
  coverage,
  rerun = false,
  className,
}: {
  coverage: AnalysisCoverage | null | undefined;
  /** A report already exists, so the notice is about running the analysis again. */
  rerun?: boolean;
  className?: string;
}) {
  if (!coverage) return null;
  const { characterCount, sectionCount, analysedSectionCount, uncoveredFrom } =
    coverage;

  if (uncoveredFrom === null || sectionCount <= analysedSectionCount) {
    // Only before the first run: a long but covered contract takes several calls.
    return !rerun && sectionCount > 1 ? (
      <p className={cn("text-caption text-muted-foreground", className)}>
        This contract is analysed in {sectionCount} sections, so this can take
        a few minutes.
      </p>
    ) : null;
  }

  const percent = Math.floor((uncoveredFrom / Math.max(characterCount, 1)) * 100);
  return (
    <div
      role="status"
      className={cn(
        "rounded-card border border-highlight/40 bg-highlight/[0.06] px-4 py-3 text-left text-sm text-foreground",
        className,
      )}
    >
      <p className="text-highlight">Analysis coverage</p>
      <p className="mt-1">
        This contract has {sectionCount} sections, and one analysis covers only
        the first {analysedSectionCount}. {rerun ? "A re-run" : "The analysis"}{" "}
        stops around character {count.format(uncoveredFrom + 1)} of{" "}
        {count.format(characterCount)} (about {percent}% of the way through), so
        terms after that point will not be reflected.
      </p>
      <p className="mt-1">
        To cover the rest, upload the text from that point on as a separate
        contract and analyse it too.
      </p>
    </div>
  );
}
