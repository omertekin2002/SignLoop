"use client";

import { Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  renderAnalysisBriefMarkdown,
  type AnalysisBriefInput,
} from "@/lib/analysis-brief";

/**
 * Downloads the analysis on screen as a Markdown decision brief. The file is built in the browser
 * from data the page already holds, so it calls no API. Renders nothing without an analysis.
 */
export function DownloadBriefButton({
  contract,
  analysis,
  historical,
}: {
  contract: AnalysisBriefInput["contract"];
  analysis: AnalysisBriefInput["analysis"] | null;
  historical?: boolean;
}) {
  if (!analysis?.resultJson || typeof analysis.resultJson !== "object") {
    return null;
  }

  const download = () => {
    let url: string;
    let filename: string;
    try {
      const brief = renderAnalysisBriefMarkdown({ contract, analysis, historical });
      filename = brief.filename;
      url = URL.createObjectURL(
        new Blob([brief.markdown], { type: "text/markdown;charset=utf-8" }),
      );
    } catch {
      toast.error("The brief could not be created. Please try again.");
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Give the browser time to start saving before releasing the file.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <Button variant="outline" onClick={download}>
      <Download className="mr-2 h-4 w-4" aria-hidden />
      Download brief
    </Button>
  );
}
