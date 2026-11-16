"use client";

import { useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Printer } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useIsClient } from "@/components/theme-toggle";
import {
  renderAnalysisBriefMarkdown,
  type AnalysisBriefInput,
} from "@/lib/analysis-brief";

function PlainText({ children }: { children?: ReactNode }) {
  return <span>{children}</span>;
}

// Paper has nothing to click, and a saved PDF should not carry links the brief never meant to make
// (GFM turns a bare URL in contract text into one). Images would be network requests.
const COMPONENTS: Components = { a: PlainText };

/**
 * Prints the analysis on screen as the decision brief, laid out for paper and "Save as PDF".
 *
 * The brief's content is the Markdown download's (`renderAnalysisBriefMarkdown`), rendered without
 * raw HTML or images into a print-only <article> directly under <body>. The print styles in
 * `app/globals.css` show only that article in print media, so Ctrl/Cmd+P prints the same brief as
 * the button. Built in the browser from data the page already holds: it calls no API. Renders
 * nothing without an analysis.
 */
export function PrintBrief({
  contract,
  analysis,
  historical,
}: {
  contract: AnalysisBriefInput["contract"];
  analysis: AnalysisBriefInput["analysis"] | null;
  historical?: boolean;
}) {
  // The brief is portalled into <body>, which only exists on the client.
  const isClient = useIsClient();
  const hasAnalysis = Boolean(
    analysis?.resultJson && typeof analysis.resultJson === "object",
  );
  const { id, title, status, extractionWarning } = contract;

  const markdown = useMemo(() => {
    if (!hasAnalysis || !analysis) return null;
    try {
      return renderAnalysisBriefMarkdown({
        contract: { id, title, status, extractionWarning },
        analysis,
        historical,
      }).markdown;
    } catch {
      return null;
    }
  }, [hasAnalysis, analysis, id, title, status, extractionWarning, historical]);

  const brief = useMemo(
    () =>
      markdown === null ? null : (
        <article
          data-print-brief=""
          className="print-brief prose prose-sm hidden max-w-none print:block"
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            disallowedElements={["img"]}
            unwrapDisallowed
            components={COMPONENTS}
          >
            {markdown}
          </ReactMarkdown>
        </article>
      ),
    [markdown],
  );

  if (!hasAnalysis) return null;

  const print = () => {
    if (markdown === null) {
      toast.error("The brief could not be created. Please try again.");
      return;
    }
    window.print();
  };

  return (
    <>
      <Button variant="outline" onClick={print}>
        <Printer className="mr-2 h-4 w-4" aria-hidden />
        Print brief
      </Button>
      {isClient && brief ? createPortal(brief, document.body) : null}
    </>
  );
}
