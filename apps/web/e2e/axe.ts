import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

// The quality bar is WCAG 2.2 AA. axe tags its checks by the WCAG version and level that added them.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// Serious and critical violations fail a scan. Minor and moderate ones are left for later work.
const FAILING_IMPACTS = new Set(["serious", "critical"]);

export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

// next-themes (components/providers.tsx) reads the stored choice from localStorage's `theme` key
// before the first paint. Writing it before every navigation renders the page in that theme from
// the start, as it would for a returning user who picked it.
export async function startInTheme(page: Page, theme: Theme) {
  await page.addInitScript((value) => window.localStorage.setItem("theme", value), theme);
}

type ScanOptions = {
  // The theme the page should be in; the scan first checks that <html> carries its class.
  theme: Theme;
  // Selectors of elements the app cannot fix (third-party widgets). Each needs a comment at the
  // call site saying why. Never disable a rule instead.
  exclude?: string[];
};

// Scans the page for WCAG 2.x A/AA violations and fails on any serious or critical one, listing
// each with its rule, impact, help text and failing elements so a CI log is readable on its own.
export async function expectNoA11yViolations(page: Page, { theme, exclude = [] }: ScanOptions) {
  const html = page.locator("html");
  for (const name of THEMES) {
    const hasClass = new RegExp(`(^|\\s)${name}(\\s|$)`);
    if (name === theme) await expect(html).toHaveClass(hasClass);
    else await expect(html).not.toHaveClass(hasClass);
  }

  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  for (const selector of exclude) builder = builder.exclude(selector);
  const { violations } = await builder.analyze();

  const failing = violations.filter((violation) => FAILING_IMPACTS.has(violation.impact ?? ""));
  // Soft, so a test that scans several states reports every one of them in a single run.
  expect.soft(
    failing.map(formatViolation).join("\n\n"),
    `axe found violations on ${page.url()} (${theme})`,
  ).toBe("");
}

type Violation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];

function formatViolation(violation: Violation): string {
  const nodes = violation.nodes.map((node) => {
    const target = node.target.map(String).join(" ");
    // The summary carries the details, such as the measured contrast ratio and the required one.
    const summary = node.failureSummary?.replace(/\s*\n\s*/g, " ").trim();
    // Class-based selectors can be hard to find in the code; the element's markup locates it.
    const html = node.html.length > 200 ? `${node.html.slice(0, 200)}…` : node.html;
    return [`  - ${target}`, `    ${html}`, ...(summary ? [`    ${summary}`] : [])].join("\n");
  });
  return [
    `[${violation.impact}] ${violation.id}: ${violation.help}`,
    `  ${violation.helpUrl}`,
    ...nodes,
  ].join("\n");
}
