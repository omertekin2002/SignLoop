import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { marked, type Tokens } from "marked";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrintBrief } from "@/components/print-brief";
import { renderAnalysisBriefMarkdown } from "@/lib/analysis-brief";
import type { AnalysisResult } from "@/lib/schemas";

const mocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

const CONTRACT_ID = "11111111-2222-4333-8444-555555555555";
const REVISION = `sha256:${"a".repeat(64)}`;
const SOURCE = {
  contract_id: CONTRACT_ID,
  revision: REVISION,
  index_unit: "unicode-code-points" as const,
};

const CONTRACT = {
  id: CONTRACT_ID,
  title: "Gym membership",
  status: "ANALYZED",
  extractionWarning: "Scanned pages were read with OCR.",
};

const RESULT: Partial<AnalysisResult> = {
  source: SOURCE,
  risk_badge: "MEDIUM",
  coverage_notices: ["Only part of this contract was analysed."],
  comparison_jurisdiction: "England and Wales",
  key_points: ["Renews every year."],
  summary: {
    what_it_is: "A gym membership agreement.",
    payments: { amount: "£45", frequency: "Monthly", fees: [] },
    term: { start: null, end: null, minimum_term: "12 months" },
    renewal: { auto_renew: true, renewal_period: "12 months" },
    cancellation: {
      how: "Write to the club.",
      notice_period_days: 30,
      notice_period_text: null,
      penalties: [],
    },
  },
  red_flags: [
    {
      type: "Auto-renewal",
      severity: 7,
      explanation: "The contract renews for a further year unless cancelled.",
      where: "Clause 9.2",
      evidence: { quote: "shall renew automatically", segment: "section-2" },
      citation: {
        ...SOURCE,
        status: "verified",
        quote: "shall renew automatically",
        start: 100,
        end: 125,
      },
      confidence: 80,
    },
  ],
  next_actions: {
    questions_to_ask: ["Can I cancel early?"],
    email_templates: [{ subject: "Cancellation", body: "Dear club,\nI wish to cancel." }],
  },
  disclaimer: "This is an AI analysis, not legal advice.",
};

const ANALYSIS = {
  createdAt: "2026-10-29T10:00:00Z",
  riskBadge: "MEDIUM",
  resultJson: RESULT,
};

const BUTTON = { name: "Print brief" };

// The brief gives the analysis time in the viewer's local zone, so these tests set the zone instead
// of inheriting the host's. Kiritimati (UTC+14) puts ANALYSIS.createdAt on the next calendar day,
// which a run in UTC could not tell apart from formatting in UTC. Setting TZ changes the zone in
// Vitest's default forks pool; a worker thread cannot change it, and the date assertion would fail.
const TIME_ZONE = "Pacific/Kiritimati";

function printedBrief(): HTMLElement {
  const articles = document.body.querySelectorAll<HTMLElement>(":scope > [data-print-brief]");
  expect(articles).toHaveLength(1);
  return articles[0]!;
}

function headingsOf(element: HTMLElement): string[] {
  return Array.from(element.querySelectorAll("h1, h2, h3, h4, h5, h6")).map(
    (heading) => `${heading.tagName.toLowerCase()} ${heading.textContent}`,
  );
}

describe("PrintBrief", () => {
  const fetchMock = vi.fn();
  const printMock = vi.fn();

  beforeAll(() => {
    vi.stubEnv("TZ", TIME_ZONE);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    fetchMock.mockReset();
    printMock.mockReset();
    mocks.toast.error.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("print", printMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders nothing until an analysis exists", () => {
    const { rerender } = render(<PrintBrief contract={CONTRACT} analysis={null} />);
    expect(screen.queryByRole("button", BUTTON)).not.toBeInTheDocument();
    expect(document.body.querySelector("[data-print-brief]")).toBeNull();

    rerender(<PrintBrief contract={CONTRACT} analysis={{ ...ANALYSIS, resultJson: null }} />);
    expect(screen.queryByRole("button", BUTTON)).not.toBeInTheDocument();
    expect(document.body.querySelector("[data-print-brief]")).toBeNull();

    rerender(<PrintBrief contract={CONTRACT} analysis={ANALYSIS} />);
    expect(screen.getByRole("button", BUTTON)).toBeInTheDocument();
    printedBrief();
  });

  it("puts the brief directly under <body>, hidden on screen and shown in print", () => {
    const { container } = render(<PrintBrief contract={CONTRACT} analysis={ANALYSIS} />);
    const brief = printedBrief();
    // Outside the app's tree, so the print styles can hide every other child of <body>.
    expect(container.contains(brief)).toBe(false);
    expect(brief).toHaveClass("hidden", "print:block", "print-brief");
  });

  it("prints the same sections as the Markdown brief", () => {
    render(<PrintBrief contract={CONTRACT} analysis={ANALYSIS} />);
    const brief = printedBrief();

    const { markdown } = renderAnalysisBriefMarkdown({ contract: CONTRACT, analysis: ANALYSIS });
    const expected = marked
      .lexer(markdown)
      .filter((token): token is Tokens.Heading => token.type === "heading")
      .map((token) => `h${token.depth} ${token.text}`);
    expect(expected).toEqual(
      expect.arrayContaining([
        "h1 Decision brief: Gym membership",
        "h2 Coverage",
        "h2 Jurisdiction",
        "h2 Summary",
        "h2 Findings",
        "h2 Next steps",
      ]),
    );
    expect(headingsOf(brief)).toEqual(expected);

    // Report identity, coverage and jurisdiction.
    expect(brief).toHaveTextContent("Contract: Gym membership");
    expect(brief).toHaveTextContent("Analyzed: Oct 30, 2026 00:00");
    expect(brief).toHaveTextContent("Risk level: MEDIUM");
    expect(brief).toHaveTextContent(`Source revision: ${REVISION}`);
    expect(brief).toHaveTextContent("Text extraction: Scanned pages were read with OCR.");
    expect(brief).toHaveTextContent("Only part of this contract was analysed.");
    expect(brief).toHaveTextContent("Confirmed: England and Wales (confirmed when this analysis ran).");
    // The finding's source quotation, as a quotation.
    expect(brief).toHaveTextContent("Verified quotation");
    const quote = brief.querySelector("blockquote");
    expect(quote).toHaveTextContent("shall renew automatically");
    // Draft email bodies keep their line breaks.
    expect(brief.querySelector("pre")).toHaveTextContent("Dear club, I wish to cancel.");
    expect(brief).toHaveTextContent("No new analysis was run to produce this brief.");
    expect(brief).not.toHaveTextContent("Earlier analysis.");
  });

  it("prints each fee under Payments with its own quotation, or marks it", () => {
    const lateClause = "A late fee of £10 applies to payments made after the 5th.";
    const withFees = {
      ...ANALYSIS,
      resultJson: {
        ...RESULT,
        summary: {
          ...RESULT.summary!,
          payments: {
            amount: "£45",
            frequency: "Monthly",
            fees: ["Late fee of £10", "Joining fee of £20"],
            fee_citations: [
              {
                fee: "Late fee of £10",
                citation: { ...SOURCE, status: "verified" as const, quote: lateClause, start: 300, end: 357 },
              },
            ],
          },
        },
      },
    };
    render(<PrintBrief contract={CONTRACT} analysis={withFees} />);
    const brief = printedBrief();
    const fees = Array.from(brief.querySelectorAll("li")).find((item) =>
      item.firstChild?.textContent?.startsWith("Fees:"),
    );
    expect(fees).toBeDefined();
    const [late, joining] = Array.from(fees!.querySelectorAll(":scope > ul > li"));
    expect(late).toHaveTextContent("Late fee of £10");
    expect(late!.querySelector("blockquote")).toHaveTextContent(lateClause);
    expect(joining).toHaveTextContent("Joining fee of £20 (No verified quotation)");
    expect(joining!.querySelector("blockquote")).toBeNull();
  });

  it("prints each obligation with its own quotation, or marks it", () => {
    const payClause = "The Member pays the monthly dues by direct debit.";
    const withObligations = {
      ...ANALYSIS,
      resultJson: {
        ...RESULT,
        obligations: ["Pay monthly dues", "Return club kit when leaving"],
        obligation_citations: [
          {
            obligation: "Pay monthly dues",
            citation: { ...SOURCE, status: "verified" as const, quote: payClause, start: 200, end: 249 },
          },
        ],
      },
    };
    render(<PrintBrief contract={CONTRACT} analysis={withObligations} />);
    const heading = Array.from(printedBrief().querySelectorAll("h3")).find(
      (item) => item.textContent === "Obligations",
    );
    expect(heading?.nextElementSibling?.tagName).toBe("UL");
    const [pay, kit] = Array.from(heading!.nextElementSibling!.querySelectorAll(":scope > li"));
    expect(pay).toHaveTextContent("Pay monthly dues");
    expect(pay!.querySelector("blockquote")).toHaveTextContent(payClause);
    expect(kit).toHaveTextContent("Return club kit when leaving (No verified quotation)");
    expect(kit!.querySelector("blockquote")).toBeNull();
  });

  it("prints each key date with its own quotation, or marks it", () => {
    const renewalClause = "The membership renews on 31 December 2026 for a further year.";
    const withDates = {
      ...ANALYSIS,
      resultJson: {
        ...RESULT,
        key_dates: [
          { type: "RENEWAL" as const, date: "2026-12-31", derived_from: null },
          { type: "NOTICE_CUTOFF" as const, date: "2026-12-31", derived_from: "Same day as renewal" },
        ],
        key_date_citations: [
          {
            type: "RENEWAL" as const,
            date: "2026-12-31",
            citation: { ...SOURCE, status: "verified" as const, quote: renewalClause, start: 200, end: 200 + renewalClause.length },
          },
        ],
      },
    };
    render(<PrintBrief contract={CONTRACT} analysis={withDates} />);
    const heading = Array.from(printedBrief().querySelectorAll("h3")).find(
      (item) => item.textContent === "Key dates",
    );
    expect(heading?.nextElementSibling?.tagName).toBe("UL");
    const [renewal, cutoff] = Array.from(heading!.nextElementSibling!.querySelectorAll(":scope > li"));
    expect(renewal).toHaveTextContent("Renewal: 2026-12-31");
    expect(renewal!.querySelector("blockquote")).toHaveTextContent(renewalClause);
    expect(cutoff).toHaveTextContent(
      "Notice cutoff: 2026-12-31 (from: Same day as renewal) (No verified quotation)",
    );
    expect(cutoff!.querySelector("blockquote")).toBeNull();
  });

  it("prints the term's quotation under Term, or marks a stated term without one", () => {
    const termClause = "This membership starts on joining and lasts at least 12 months.";
    const withTerm = (term: AnalysisResult["summary"]["term"]) => ({
      ...ANALYSIS,
      resultJson: { ...RESULT, summary: { ...RESULT.summary!, term } },
    });
    const termItem = () =>
      Array.from(printedBrief().querySelectorAll("li")).find((item) =>
        item.firstChild?.textContent?.startsWith("Term:"),
      );

    const { unmount } = render(
      <PrintBrief
        contract={CONTRACT}
        analysis={withTerm({
          start: "On joining",
          end: null,
          minimum_term: "12 months",
          term_citation: { ...SOURCE, status: "verified" as const, quote: termClause, start: 400, end: 463 },
        })}
      />,
    );
    const quoted = termItem();
    expect(quoted).toBeDefined();
    const minimum = Array.from(quoted!.querySelectorAll(":scope > ul > li")).find((item) =>
      item.textContent?.startsWith("Minimum term:"),
    );
    expect(minimum).toHaveTextContent("Minimum term: 12 months");
    expect(minimum!.querySelector("blockquote")).toHaveTextContent(termClause);
    expect(quoted).not.toHaveTextContent("No verified quotation");
    unmount();

    // A report stored before term quotations.
    render(<PrintBrief contract={CONTRACT} analysis={ANALYSIS} />);
    expect(termItem()).toHaveTextContent("Minimum term: 12 months (No verified quotation)");
    expect(termItem()!.querySelector("blockquote")).toBeNull();
  });

  it("marks an earlier analysis as historical", () => {
    render(<PrintBrief contract={CONTRACT} analysis={ANALYSIS} historical />);
    expect(printedBrief()).toHaveTextContent(
      "Earlier analysis. A newer analysis of this contract exists.",
    );
  });

  it("renders contract and model text as text, never as HTML, links or images", () => {
    const hostileImage = "<img src=x onerror=alert(1)>";
    const hostileLink = "[click me](javascript:alert(1))";
    const hostileScript = "<script>alert(1)</script>";
    const autolink = "https://evil.example/track";
    const imageMarkdown = "![pixel](https://evil.example/pixel.png)";
    render(
      <PrintBrief
        contract={{ ...CONTRACT, title: `Lease ${hostileImage}` }}
        analysis={{
          ...ANALYSIS,
          resultJson: {
            ...RESULT,
            key_points: [`See ${autolink}`, imageMarkdown],
            red_flags: [
              {
                ...RESULT.red_flags![0]!,
                type: `**Bold** ${hostileScript}`,
                explanation: `Read ${hostileLink} now.`,
                evidence: { quote: `${hostileImage}\n# Not a heading`, segment: "section-2" },
                citation: null,
              },
            ],
          },
        }}
      />,
    );
    const brief = printedBrief();

    expect(brief.querySelector("img, script, a, iframe, strong > strong")).toBeNull();
    expect(brief.querySelector("[onerror], [href], [src]")).toBeNull();
    expect(brief).toHaveTextContent(`Decision brief: Lease ${hostileImage}`);
    expect(brief).toHaveTextContent(`**Bold** ${hostileScript}`);
    expect(brief).toHaveTextContent(`Read ${hostileLink} now.`);
    expect(brief).toHaveTextContent(imageMarkdown);
    expect(brief).toHaveTextContent(`See ${autolink}`);
    expect(within(brief).queryByRole("heading", { name: "Not a heading" })).toBeNull();
    expect(brief.querySelector("blockquote")).toHaveTextContent(`${hostileImage} # Not a heading`);
  });

  it("opens the browser's print dialog without a network request", async () => {
    const user = userEvent.setup();
    render(<PrintBrief contract={CONTRACT} analysis={ANALYSIS} />);

    await user.click(screen.getByRole("button", BUTTON));

    expect(printMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
});
