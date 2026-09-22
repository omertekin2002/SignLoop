import type { AnalysisResult } from "@/lib/schemas";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
  const comparisons = Array.isArray(result.normal_in_region)
    ? result.normal_in_region
    : [];
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
      {comparisons.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Regional comparisons</CardTitle>
            <p className="text-sm text-muted-foreground">
              Model-generated comparisons; verify applicable local rules.
            </p>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {comparisons.map(
              (item, index) =>
                item && (
                  <section
                    key={index}
                    className="border-b border-border pb-4 last:border-0 last:pb-0"
                  >
                    <h3 className="font-medium">
                      {item.topic}{" "}
                      <span className="text-muted-foreground">
                        ({item.label})
                      </span>
                    </h3>
                    <p className="mt-2">Typical: {item.typical_range}</p>
                    <p>Your contract: {item.yours || "Not specified"}</p>
                  </section>
                ),
            )}
          </CardContent>
        </Card>
      )}
      {typeof result.disclaimer === "string" && result.disclaimer.trim() && (
        <p className="text-sm text-muted-foreground">{result.disclaimer}</p>
      )}
    </div>
  );
}
