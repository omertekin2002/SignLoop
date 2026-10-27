"use client";

import {
  createContext,
  useContext,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient, getApiErrorMessage, type ApiError } from "@/lib/api-client";
import {
  citationForReport,
  JURISDICTION_CITATION,
  SourcePageSchema,
  type CitationRef,
  type SourceCitation,
} from "@/lib/source-citations";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const SourceContext = createContext<{
  open: (ref?: CitationRef) => void;
  citation: (ref: CitationRef) => SourceCitation | null;
} | null>(null);

type SourceRequest = { offset: number; revision?: string; flag?: CitationRef };

/** The caller keys this workspace by contract/report/revision, retiring old requests on a switch. */
export function ContractSourceProvider({
  contractId,
  analysisId,
  result,
  children,
}: {
  contractId: string;
  analysisId?: string;
  result: unknown;
  children: ReactNode;
}) {
  const [request, setRequest] = useState<SourceRequest | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const citation = (ref: CitationRef) =>
    citationForReport(result, contractId, ref);
  const open = (ref?: CitationRef) => {
    const match = ref === undefined ? null : citation(ref);
    if (ref !== undefined && !match) return;
    if (request === null)
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    setRequest(
      match
        ? {
            offset: Math.max(0, match.start - 250),
            revision: match.revision,
            flag: ref,
          }
        : { offset: 0 },
    );
  };
  const sourceQuery = useQuery({
    queryKey: ["contract-source", contractId, analysisId, request],
    enabled: request !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await apiClient.get(`/contracts/${contractId}/source`, {
        signal,
        params: {
          offset: request!.offset,
          revision: request!.revision,
          ...(request!.flag !== undefined
            ? { analysisId, flag: request!.flag }
            : {}),
        },
      });
      const page = SourcePageSchema.parse(response.data);
      if (
        page.contractId.toLowerCase() !== contractId.toLowerCase() ||
        (request?.revision && request.revision !== page.revision)
      )
        throw new Error(
          "Source response does not match the requested revision",
        );
      return page;
    },
  });
  // Never keep a previous page visible while a revision/deletion recheck is running or fails.
  const page =
    !sourceQuery.isFetching && !sourceQuery.isError
      ? sourceQuery.data
      : undefined;
  const chars = Array.from(page?.text ?? "");
  const match = page?.highlight;
  const canHighlight =
    page &&
    match &&
    request?.flag !== undefined &&
    match.contract_id.toLowerCase() === contractId.toLowerCase() &&
    match.revision === page.revision &&
    match.start >= page.offset &&
    match.end <= page.offset + chars.length &&
    chars.slice(match.start - page.offset, match.end - page.offset).join("") ===
      match.quote;
  const move = (offset: number) => {
    if (page) setRequest({ ...request, offset, revision: page.revision });
  };

  return (
    <SourceContext.Provider value={{ open, citation }}>
      {children}
      <Dialog
        open={request !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setRequest(null);
        }}
      >
        <DialogContent
          className="flex max-w-3xl flex-col gap-4"
          onCloseAutoFocus={(event) => {
            if (opener.current?.isConnected) {
              event.preventDefault();
              opener.current.focus();
            }
          }}
        >
          <DialogHeader className="pr-6">
            <DialogTitle>Extracted contract text</DialogTitle>
            <DialogDescription>
              Text extracted from your upload. Formatting, tables, or scanned
              content may be missing.
              {request?.flag !== undefined &&
                " A matched quotation confirms text provenance, not the finding’s interpretation."}
            </DialogDescription>
          </DialogHeader>
          {sourceQuery.isFetching && (
            <p role="status" className="py-6 text-sm text-muted-foreground">
              Loading source text…
            </p>
          )}
          {sourceQuery.isError && (
            <div role="alert" className="space-y-3 py-4 text-sm">
              <p>
                {getApiErrorMessage(
                  sourceQuery.error,
                  "Could not load source text. Please try again.",
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    void sourceQuery.refetch();
                  }}
                >
                  Retry
                </Button>
                {(sourceQuery.error as ApiError).response?.status === 409 && (
                  <Button variant="ghost" onClick={() => open()}>
                    Open current source
                  </Button>
                )}
              </div>
            </div>
          )}
          {page && (
            <>
              {page.extractionWarning && (
                <p role="status" className="text-sm text-highlight">
                  {page.extractionWarning}
                </p>
              )}
              {request?.flag !== undefined && (
                <p role="status" className="text-sm text-muted-foreground">
                  {canHighlight
                    ? "Quotation matched in the analyzed text. Highlighted below."
                    : "Showing another passage of the same source. The matched quotation is outside this page."}
                </p>
              )}
              {page.totalCharacters === 0 ? (
                <p role="status" className="py-6 text-sm text-muted-foreground">
                  No extracted text yet. Upload a contract file to read its
                  source.
                </p>
              ) : (
                <>
                  <nav
                    aria-label="Source text pages"
                    className="flex flex-wrap items-center justify-between gap-3 text-sm"
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page.previousOffset === null}
                      onClick={() => move(page.previousOffset!)}
                    >
                      Previous passage
                    </Button>
                    <p className="text-muted-foreground">
                      Characters {page.offset + 1}–{page.offset + chars.length}{" "}
                      of {page.totalCharacters}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page.nextOffset === null}
                      onClick={() => move(page.nextOffset!)}
                    >
                      Next passage
                    </Button>
                  </nav>
                  <div
                    // The passage scrolls, so keyboard users must be able to focus it to scroll it
                    // (axe's scrollable-region-focusable); a labelled region is not a widget.
                    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                    tabIndex={0}
                    role="region"
                    aria-label="Source passage"
                    className="max-h-[50dvh] overflow-y-auto whitespace-pre-wrap break-words rounded-card border p-4 text-sm leading-relaxed [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {canHighlight ? (
                      <>
                        {chars.slice(0, match.start - page.offset).join("")}
                        <mark className="rounded bg-highlight/20 text-foreground underline decoration-highlight decoration-2 underline-offset-4">
                          {match.quote}
                        </mark>
                        {chars.slice(match.end - page.offset).join("")}
                      </>
                    ) : (
                      page.text
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </SourceContext.Provider>
  );
}

export function OpenContractSource() {
  const source = useContext(SourceContext);
  return (
    <Button variant="outline" onClick={() => source?.open()}>
      View source text
    </Button>
  );
}

function QuotedSource({
  citationRef,
  label,
}: {
  citationRef: CitationRef;
  label: string;
}) {
  const source = useContext(SourceContext);
  const citation = source?.citation(citationRef);
  return citation ? (
    <div className="mt-3 space-y-2">
      <blockquote className="whitespace-pre-wrap break-words text-sm text-subtle-foreground">
        “{citation.quote}”
      </blockquote>
      <Button
        variant="outline"
        size="sm"
        onClick={() => source?.open(citationRef)}
        aria-label={label}
      >
        View matched quotation
      </Button>
    </div>
  ) : null;
}

/** The verified governing-law quotation behind a report's jurisdiction proposal, if it has one. */
export function JurisdictionSource() {
  return (
    <QuotedSource
      citationRef={JURISDICTION_CITATION}
      label="View the governing-law clause in the source text"
    />
  );
}

export function FindingSource({ index }: { index: number }) {
  const source = useContext(SourceContext);
  return source?.citation(index) ? (
    <QuotedSource
      citationRef={index}
      label={`View source quotation for finding ${index + 1}`}
    />
  ) : (
    <p className="mt-2 text-xs text-muted-foreground">
      Verified source quotation unavailable.
    </p>
  );
}
