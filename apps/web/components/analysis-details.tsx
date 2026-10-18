import type { AnalysisResult } from "@/lib/schemas";
import { regionalComparisonsView } from "@/lib/regional-comparisons";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function TextList({ values }: { values: unknown }) {
  const items = Array.isArray(values)
    ? values.filter(
        (value): value is string =>
          typeof value === "string" && Boolean(value.trim()),
      )
    : [];
  return items.length ? (
    <ul className="list-disc space-y-2 pl-5">
      {items.map((value, index) => (
        <li key={index}>{value}</li>
      ))}
    </ul>
  ) : (
    <p className="text-muted-foreground">None identified in this analysis.</p>
  );
}

export function AnalysisDetails({
  result,
}: {
  result: Partial<AnalysisResult>;
}) {
  const term = result.summary?.term;
  const comparisons = regionalComparisonsView(result);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Parties and obligations</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6 text-sm md:grid-cols-2">
          <section>
            <h3 className="mb-3 font-medium">Parties</h3>
            <TextList values={result.parties} />
          </section>
          <section>
            <h3 className="mb-3 font-medium">Obligations</h3>
            <TextList values={result.obligations} />
          </section>
          <section>
            <h3 className="mb-3 font-medium">Payment fees</h3>
            <TextList values={result.summary?.payments?.fees} />
          </section>
          <section>
            <h3 className="mb-3 font-medium">Term dates</h3>
            <p>Start: {term?.start || "Not specified"}</p>
            <p>End: {term?.end || "Not specified"}</p>
          </section>
        </CardContent>
      </Card>
      {comparisons?.status === "withheld" && (
        <div role="note" className="rounded-card border px-4 py-3 text-sm">
          <p className="text-foreground">Regional comparisons not shown</p>
          <p className="mt-1 text-muted-foreground">
            No jurisdiction was confirmed for this contract, and what is typical
            or allowed depends on where it applies. This analysis describes
            risks from the contract text alone. You&apos;ll be able to confirm
            a jurisdiction in a later update.
          </p>
        </div>
      )}
      {comparisons && comparisons.status !== "withheld" && (
        <Card>
          <CardHeader>
            <CardTitle>Regional comparisons</CardTitle>
            {/* Reports saved before withholding carry no flag; their comparisons
                were generated against "Region: Unknown". */}
            <CardDescription
              className={cn(
                comparisons.status === "unconfirmed" && "text-highlight",
              )}
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
                <h3 className="font-medium">
                  {item.topic}{" "}
                  <span className="text-muted-foreground">({item.label})</span>
                </h3>
                {item.jurisdiction && (
                  <p className="mt-1 text-muted-foreground">
                    Jurisdiction: {item.jurisdiction}
                  </p>
                )}
                <p className="mt-2">Typical: {item.typical_range}</p>
                <p>Your contract: {item.yours || "Not specified"}</p>
              </section>
            ))}
          </CardContent>
        </Card>
      )}
      {typeof result.disclaimer === "string" && result.disclaimer.trim() && (
        <p className="text-sm text-muted-foreground">{result.disclaimer}</p>
      )}
    </div>
  );
}
