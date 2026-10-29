import { expect, type Page } from "@playwright/test";

export type CspViolation = {
  directive: string;
  blocked: string;
  source: string;
  line: number;
  sample: string;
};

// Records every Content Security Policy violation the page raises, across navigations: an init
// script listens for `securitypolicyviolation` in each new document, before any of its scripts run,
// and hands each event to the test through a binding. The policy is report-only, so nothing is
// blocked and a violation shows up only here (and as a report to /api/csp-report).
export async function recordCspViolations(page: Page): Promise<CspViolation[]> {
  const violations: CspViolation[] = [];
  await page.exposeBinding("__recordCspViolation", (_source, violation: CspViolation) => {
    violations.push(violation);
  });
  await page.addInitScript(() => {
    const record = (window as unknown as Record<string, (violation: CspViolation) => void>)
      .__recordCspViolation;
    document.addEventListener(
      "securitypolicyviolation",
      (event) =>
        record?.({
          directive: event.effectiveDirective,
          blocked: event.blockedURI,
          source: event.sourceFile,
          line: event.lineNumber,
          sample: event.sample,
        }),
      true,
    );
  });
  return violations;
}

// Fails with every recorded violation listed, so a CI log says what to allow or fix.
export function expectNoCspViolations(violations: CspViolation[], where: string) {
  expect(
    violations.map(
      ({ directive, blocked, source, line, sample }) =>
        `${directive}: blocked ${blocked || "(none)"} from ${source || "(inline)"}:${line}${sample ? ` "${sample}"` : ""}`,
    ),
    `CSP violations on ${where}`,
  ).toEqual([]);
}
