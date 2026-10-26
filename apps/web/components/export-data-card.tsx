"use client";

import { useMutation } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const FALLBACK_ERROR = "Your data could not be exported. Please try again.";

function downloadName(response: Response): string {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  return /filename="([^"]+)"/.exec(disposition)?.[1] ?? "signloop-export.zip";
}

// Fetch rather than navigate, so the page can show progress and a readable error.
async function downloadExport(): Promise<void> {
  const response = await fetch("/api/account/export", { cache: "no-store" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error || FALLBACK_ERROR);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = downloadName(response);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser time to start saving before releasing the file.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Settings' export section: downloads everything in the account as one ZIP. */
export function ExportDataCard() {
  const exportData = useMutation({
    mutationFn: downloadExport,
    onSuccess: () => toast.success("Your data export has downloaded."),
  });
  const errorMessage =
    exportData.error instanceof TypeError
      ? FALLBACK_ERROR
      : exportData.error?.message || FALLBACK_ERROR;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export your data</CardTitle>
        <CardDescription id="export-data-description">
          Download everything in your account as one ZIP file: your
          contracts&apos; extracted text, original uploads and analyses,
          projects and their reference documents, saved chats with their files
          and images, and your settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          variant="outline"
          aria-describedby="export-data-description"
          aria-busy={exportData.isPending}
          disabled={exportData.isPending}
          onClick={() => exportData.mutate()}
        >
          {exportData.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              Preparing export...
            </>
          ) : (
            <>
              <Download className="mr-2 h-4 w-4" aria-hidden />
              Download my data
            </>
          )}
        </Button>
        <p className="text-caption text-muted-foreground" aria-live="polite">
          {exportData.isPending
            ? "Collecting your files. Large workspaces can take a minute."
            : ""}
        </p>
        {exportData.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
