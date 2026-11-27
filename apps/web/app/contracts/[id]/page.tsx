"use client";

import { useOperationProgress, isOperationCanceled } from "@/lib/use-operation-progress";
import { OperationStatus } from "@/components/operation-status";
import { postOperation } from "@/lib/operation-progress-client";
import { isAnalysisOperationResult } from "@/lib/operation-progress";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient, getApiErrorMessage, type ApiError } from "@/lib/api-client";
import { invalidateAfterWrite } from "@/lib/invalidate-after-write";
import { formatDate, getRiskColor } from "@/lib/utils";
import {
  admissionRejectionMessage,
  analysisUsageNote,
  parseAdmissionRejection,
  syncUsage,
  useUsage,
} from "@/lib/usage-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft,
  MessagesSquare,
  Play,
  Loader2,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { ContractSourceProvider, OpenContractSource } from "@/components/contract-source";
import { ContractDecisionSections } from "@/components/contract-decision-sections";
import { DownloadBriefButton } from "@/components/download-brief-button";
import { PrintBrief } from "@/components/print-brief";
import { ContractNotes } from "@/components/contract-notes";
import { ContractChats } from "@/components/contract-chats";
import { ContractJurisdiction } from "@/components/contract-jurisdiction";
import { AnalysisCoverageNotice } from "@/components/analysis-coverage-notice";
import type { AnalysisResult } from "@/lib/schemas";
import {
  contractAnalysisOptions,
  contractDetailOptions,
  type AnalysisRecord,
  type ContractDetail,
} from "@/lib/workspace-query-options";

const ContractDetails = () => {
  const params = useParams();
  const id = params?.id as string;
  const queryClient = useQueryClient();
  const analysisOperation = useOperationProgress(`analysis:${id}`, {
    abortOnUnmount: false,
  });
  const router = useRouter();
  const [selectedAnalysisId, setSelectedAnalysisId] = useState<string | null>(
    null,
  );

  const getContractErrorDetails = (error: unknown) => {
    const status = (error as ApiError).response?.status;
    const message = getApiErrorMessage(
      error,
      error instanceof Error ? error.message : "",
    );

    if (status === 404) {
      return {
        title: "Contract not found",
        description:
          "We could not find this contract. It may have been deleted or the link is invalid.",
      };
    }

    if (typeof status === "number" && status >= 500) {
      return {
        title: "Server error",
        description:
          "We hit a server error while loading this contract. Please try again soon.",
      };
    }

    return {
      title: "Unable to load contract",
      description:
        message ||
        "We could not load this contract right now. Please try again later.",
    };
  };

  const renderIssueState = (title: string, description: string) => (
    <div className="min-h-screen bg-transparent">
      <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6 lg:px-8">
        <Card className="max-w-xl mx-auto">
          <CardContent className="flex flex-col items-center text-center py-10">
            <div className="rounded-full bg-destructive/10 p-3 mb-4">
              <XCircle className="h-8 w-8 text-destructive" />
            </div>
            <h2 className="text-heading-2xs">{title}</h2>
            <p className="text-sm text-muted-foreground mt-2">{description}</p>
            <Button asChild className="mt-6">
              <Link href="/dashboard">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Dashboard
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );

  const {
    data: contract,
    isLoading,
    isLoadingError: isError,
    error,
  } = useQuery({
    ...contractDetailOptions(id),
    enabled: !!id,
  });

  const olderHistoryMutation = useMutation({
    mutationFn: async () =>
      (
        await apiClient.get<ContractDetail>(
          `/contracts/${id}?analysisOffset=${contract?.analyses?.length ?? 0}`,
        )
      ).data,
    onSuccess: (page) =>
      queryClient.setQueryData<ContractDetail>(["contract", id], (current) =>
        current
          ? {
              ...current,
              analysesHasMore: page.analysesHasMore,
              analyses: [
                ...(current.analyses ?? []),
                ...(page.analyses ?? []).filter(
                  (item) =>
                    !current.analyses?.some(
                      (existing) => existing.id === item.id,
                    ),
                ),
              ],
            }
          : current,
      ),
    onError: () => toast.error("Could not load older analyses. Please retry."),
  });

  const analyzeMutation = useMutation({
    mutationFn: async (params?: { force?: boolean }) => {
      const force = params?.force ? "?force=true" : "";
      return analysisOperation.run("preparing", async (options) => {
        let rejection: ReturnType<typeof parseAdmissionRejection> = null;
        try {
          const data = await postOperation(`/contracts/${id}/analyze${force}`, {
            ...options,
            validate: isAnalysisOperationResult,
          });
          // A request can outlive this page. Refresh only its captured identity's cache;
          // the operation hook suppresses stale view callbacks after navigation.
          void invalidateAfterWrite(
            queryClient,
            ["contract", id],
            ["contracts"],
            ["projects"],
            ["project"],
          );
          return data;
        } catch (error) {
          const apiError = error as ApiError;
          if (apiError.response?.status === 429)
            rejection = parseAdmissionRejection(apiError.response.data);
          throw error;
        } finally {
          // Even failed generation can consume allowance after this view has detached.
          void syncUsage(queryClient, rejection?.quota);
        }
      });
    },
    onSuccess: (data) => {
      toast.success(data?.message || "Analysis complete");
    },
    onError: (error: ApiError) => {
      if (isOperationCanceled(error)) return;
      const rejection =
        error.response?.status === 429
          ? parseAdmissionRejection(error.response.data)
          : null;
      toast.error(
        (rejection && admissionRejectionMessage(rejection)) ||
          getApiErrorMessage(error, "Analysis failed to start"),
      );
    },
  });
  const usageQuery = useUsage();
  const analysisUsage = analysisUsageNote(usageQuery.data?.account);

  // Already ordered by the query (created_at desc, id desc); this only guards the shape.
  const sortedAnalyses = useMemo<AnalysisRecord[]>(
    () => (Array.isArray(contract?.analyses) ? contract.analyses : []),
    [contract?.analyses],
  );
  const latestAnalysisRecord = sortedAnalyses[0] ?? null;
  const selectedAnalysis = selectedAnalysisId
    ? (sortedAnalyses.find((a) => a.id === selectedAnalysisId) ?? null)
    : null;
  const viewingOlder = Boolean(
    selectedAnalysis && selectedAnalysis.id !== latestAnalysisRecord?.id,
  );
  const historicalAnalysisQuery = useQuery({
    ...contractAnalysisOptions(id, selectedAnalysisId),
    enabled: viewingOlder,
  });
  const analysis = viewingOlder
    ? (historicalAnalysisQuery.data ?? null)
    : latestAnalysisRecord;
  const olderAnalyses = sortedAnalyses.slice(1);
  const isViewingHistoricalAnalysis = Boolean(
    analysis?.id &&
    latestAnalysisRecord?.id &&
    analysis.id !== latestAnalysisRecord.id,
  );

  const resultJson: Partial<AnalysisResult> | null =
    analysis?.resultJson && typeof analysis.resultJson === "object"
      ? analysis.resultJson
      : null;
  const riskBadge =
    typeof analysis?.riskBadge === "string"
      ? analysis.riskBadge
      : typeof resultJson?.risk_badge === "string"
        ? resultJson.risk_badge
        : "UNKNOWN";

  const extractionWarning =
    typeof contract?.extractionWarning === "string" &&
    contract.extractionWarning.trim()
      ? contract.extractionWarning
      : null;

  const uploadedDateLabel = formatDate(
    contract?.createdAt,
    "MMM d, yyyy",
    "Unknown date",
  );
  const analysisDateLabel = formatDate(
    analysis?.createdAt,
    "MMM d, HH:mm",
    "Unknown time",
  );
  const contractTitle =
    typeof contract?.title === "string" && contract.title.trim()
      ? contract.title
      : "Untitled contract";

  const llmProvider = analysis?.llmProvider;
  const llmModel = analysis?.llmModel;
  const llmProviderLabel =
    llmProvider === "openrouter"
      ? "OpenRouter"
      : llmProvider === "primary-openai-compatible"
        ? "Primary provider"
        : llmProvider === "openai"
          ? "OpenAI"
          : llmProvider;

  const deleteAnalysisMutation = useMutation({
    mutationFn: async (analysisId: string) => {
      await apiClient.delete(`/contracts/${id}/analysis/${analysisId}`);
    },
    onSuccess: () => {
      toast.success("Analysis deleted");
      void invalidateAfterWrite(
        queryClient,
        ["contract", id],
        ["contracts"],
        ["projects"],
        ["project"],
      );
    },
    onError: (error: ApiError) => {
      toast.error(getApiErrorMessage(error, "Failed to delete analysis"));
    },
  });

  const deleteOlderAnalysesMutation = useMutation({
    mutationFn: async () => {
      if (!latestAnalysisRecord) return;
      await apiClient.delete(
        `/contracts/${id}/analysis?keep=${latestAnalysisRecord.id}`,
      );
    },
    onSuccess: () => {
      void invalidateAfterWrite(
        queryClient,
        ["contract", id],
        ["contracts"],
        ["projects"],
        ["project"],
      );
      toast.success("Older analyses deleted");
    },
    onError: (error: ApiError) => {
      toast.error(getApiErrorMessage(error, "Failed to delete older analyses"));
    },
  });

  const deleteContractMutation = useMutation({
    mutationFn: async () => {
      await apiClient.delete(`/contracts/${id}`);
    },
    onSuccess: () => {
      toast.success("Contract deleted");
      void invalidateAfterWrite(
        queryClient,
        ["contracts"],
        ["projects"],
        ["project"],
        ["chat-thread"],
      );
      queryClient.removeQueries({ queryKey: ["contract", id] });
      router.push("/dashboard");
    },
    onError: (error: ApiError) => {
      toast.error(getApiErrorMessage(error, "Failed to delete contract"));
    },
  });

  useEffect(() => {
    setSelectedAnalysisId(null);
  }, [id]);

  useEffect(() => {
    if (!selectedAnalysisId) return;
    const stillExists = sortedAnalyses.some(
      (item) => item.id === selectedAnalysisId,
    );
    if (!stillExists) {
      setSelectedAnalysisId(null);
    }
  }, [selectedAnalysisId, sortedAnalyses]);

  if (isLoading || (viewingOlder && historicalAnalysisQuery.isPending)) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <Skeleton className="h-8 w-48 mb-6" />
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (viewingOlder && historicalAnalysisQuery.isError) {
    return (
      <div className="app-page p-8">
        <p>Could not load this historical analysis.</p>
        <Button variant="outline" onClick={() => setSelectedAnalysisId(null)}>
          Return to latest analysis
        </Button>
      </div>
    );
  }

  if (isError) {
    const { title, description } = getContractErrorDetails(error);
    return renderIssueState(title, description);
  }

  if (!contract) {
    return renderIssueState(
      "Contract not found",
      "We could not find this contract. It may have been deleted or the link is invalid.",
    );
  }

  // A chat reads the extracted text, so asking needs text, not an analysis.
  const chatAvailable = (contract.analysisCoverage?.characterCount ?? 0) > 0;

  const jurisdiction = (
    <ContractJurisdiction
      contractId={id}
      confirmed={
        typeof contract.confirmedJurisdiction === "string"
          ? contract.confirmedJurisdiction
          : null
      }
      report={
        resultJson
          ? {
              proposed:
                typeof resultJson.proposed_jurisdiction?.jurisdiction ===
                "string"
                  ? resultJson.proposed_jurisdiction.jurisdiction
                  : null,
              ranWith:
                typeof resultJson.comparison_jurisdiction === "string"
                  ? resultJson.comparison_jurisdiction
                  : null,
              isLatest: !isViewingHistoricalAnalysis,
            }
          : null
      }
      onRerun={() => analyzeMutation.mutate({ force: true })}
      rerunPending={analyzeMutation.isPending}
    />
  );

  return (
    <ContractSourceProvider key={`${id}:${analysis?.id ?? "none"}:${contract.updatedAt ?? ""}`} contractId={id} analysisId={analysis?.id} result={resultJson}>
    <div className="app-page pb-12">
      <div className="app-header">
        <OperationStatus stage={analysisOperation.stage} className="mx-auto max-w-7xl px-4 pt-4 sm:px-6 lg:px-8" />
        <div className="mx-auto max-w-7xl px-4 pb-6 pt-10 sm:px-6 lg:px-8">
          <Link
            href="/dashboard"
            className="mb-6 inline-flex items-center text-nav-label font-semibold uppercase text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Dashboard
          </Link>
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="app-eyebrow">Contract</p>
              <h1 className="app-title mt-3">{contractTitle}</h1>
              <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                <span>Uploaded {uploadedDateLabel}</span>
                <span>•</span>
                <Badge variant="outline">{contract.status || "UNKNOWN"}</Badge>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Only the id travels in the URL; the chat loads the title itself. */}
              {chatAvailable ? (
                <Button variant="outline" asChild>
                  <Link href={`/dashboard?contract=${encodeURIComponent(id)}`}>
                    <MessagesSquare className="mr-2 h-4 w-4" aria-hidden="true" />
                    Ask about this contract
                  </Link>
                </Button>
              ) : null}
              <OpenContractSource />
              <DownloadBriefButton
                contract={{ ...contract, id }}
                analysis={analysis}
                historical={isViewingHistoricalAnalysis}
              />
              <PrintBrief
                contract={{ ...contract, id }}
                analysis={analysis}
                historical={isViewingHistoricalAnalysis}
              />
              {analysis && (
                <Button
                  onClick={() => analyzeMutation.mutate({ force: true })}
                  disabled={analyzeMutation.isPending}
                >
                  {analyzeMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Working…
                    </>
                  ) : (
                    <>
                      <Play className="mr-2 h-4 w-4" /> Re-run Analysis
                    </>
                  )}
                </Button>
              )}

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive">
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete Contract
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this contract?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete the contract and all
                      associated analyses, and remove the contract text the
                      assistant read in saved chats. Assistant replies that
                      quoted it stay until you delete those chats. This cannot
                      be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel
                      disabled={deleteContractMutation.isPending}
                    >
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={deleteContractMutation.isPending}
                      onClick={() => deleteContractMutation.mutate()}
                    >
                      {deleteContractMutation.isPending
                        ? "Deleting..."
                        : "Delete"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              {analysis && analysisUsage ? (
                <p className="basis-full text-caption text-muted-foreground md:text-right">
                  {analysisUsage}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 space-y-6 sm:px-6 lg:px-8">
        {/* Shown before and after analysis: it describes the text the next analysis will read. */}
        {extractionWarning && (
          <div
            role="status"
            className="rounded-card border border-highlight/40 bg-highlight/[0.06] px-4 py-3 text-sm text-foreground"
          >
            <p className="text-highlight">Text extraction</p>
            <p className="mt-1">{extractionWarning}</p>
          </div>
        )}

        {/* Next to Re-run Analysis; before the first run it sits by Start Analysis instead. */}
        {analysis && (
          <AnalysisCoverageNotice coverage={contract.analysisCoverage} rerun />
        )}

        {/* Analysis Result Section */}
        {analysis ? (
          <>
            {isViewingHistoricalAnalysis && (
              <Card className="border-highlight/40 bg-highlight/[0.06]">
                <CardContent className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center md:justify-between">
                  <p className="text-sm text-foreground/90">
                    Viewing historical analysis from {analysisDateLabel}.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedAnalysisId(null)}
                  >
                    View latest analysis
                  </Button>
                </CardContent>
              </Card>
            )}

            <ContractDecisionSections
              contractId={id}
              analysisId={analysis.id}
              chatAvailable={chatAvailable}
              result={resultJson ?? {}}
              extractionWarning={extractionWarning}
              riskBadge={riskBadge}
              analyzedOn={analysisDateLabel}
              model={
                llmModel
                  ? `${llmProviderLabel ? `${llmProviderLabel} • ` : ""}${llmModel}`
                  : null
              }
              stale={contract.status !== "ANALYZED"}
              jurisdiction={jurisdiction}
            />
          </>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              {analyzeMutation.isPending ? (
                <>
                  <div className="mb-4 rounded-full border p-4">
                    <Loader2 className="h-8 w-8 text-primary animate-spin" />
                  </div>
                  <h3 className="text-heading-2xs">Analysis in progress</h3>
                  <p className="text-sm text-muted-foreground max-w-sm mt-2">
                    This can take a few minutes. We’ll refresh automatically
                    when it’s ready.
                  </p>
                </>
              ) : (
                <>
                  <div className="mb-4 rounded-full border p-4">
                    <Play className="h-8 w-8 text-primary" />
                  </div>
                  <h3 className="text-heading-2xs">No Analysis Yet</h3>
                  <p className="text-sm text-muted-foreground max-w-sm mt-2 mb-6">
                    Run our AI analysis to identify risks, missing clauses, and
                    key obligations in this contract.
                  </p>
                  <AnalysisCoverageNotice
                    coverage={contract.analysisCoverage}
                    className="mb-6 w-full max-w-xl"
                  />
                  <Button
                    onClick={() => analyzeMutation.mutate({})}
                    disabled={analyzeMutation.isPending}
                  >
                    Start Analysis
                  </Button>
                  {analysisUsage ? (
                    <p className="mt-3 text-caption text-muted-foreground">
                      {analysisUsage}
                    </p>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* With an analysis, the Jurisdiction card sits in its decision group, after the Overview. */}
        {!analysis && jurisdiction}

        {/* After the last decision group: the questions asked about this contract and their
            answers, before the owner's own notes, which stay last. */}
        <ContractChats contractId={id} canAsk={chatAvailable} />

        {/* The owner's own writing, after everything generated, so it never reads as analysis. */}
        <ContractNotes contractId={id} />

        {/* Analysis History */}
        {(olderAnalyses.length > 0 || contract.analysesHasMore) && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Analysis History</CardTitle>
                <CardDescription>
                  Manage older analyses for this contract
                </CardDescription>
              </div>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleteOlderAnalysesMutation.isPending}
                onClick={() => {
                  const ok = window.confirm(
                    "Delete all older analyses for this contract? This cannot be undone.",
                  );
                  if (!ok) return;
                  deleteOlderAnalysesMutation.mutate();
                }}
              >
                Delete older analyses
              </Button>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {olderAnalyses.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge
                          className={getRiskColor(a.riskBadge, { hover: true })}
                        >
                          {a.riskBadge || "UNKNOWN"}
                        </Badge>
                        <span className="text-sm text-muted-foreground">
                          {formatDate(a.createdAt, "MMM d, HH:mm")}
                        </span>
                      </div>
                      {!!a.llmModel && (
                        <div className="text-xs text-muted-foreground">
                          Model: {a.llmModel}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant={
                          analysis?.id === a.id ? "secondary" : "outline"
                        }
                        size="sm"
                        onClick={() => setSelectedAnalysisId(a.id)}
                      >
                        {analysis?.id === a.id ? "Viewing" : "View"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={deleteAnalysisMutation.isPending}
                        onClick={() => {
                          const ok = window.confirm(
                            "Delete this analysis? This cannot be undone.",
                          );
                          if (!ok) return;
                          deleteAnalysisMutation.mutate(a.id);
                        }}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
                {contract.analysesHasMore && (
                  <Button
                    variant="outline"
                    disabled={olderHistoryMutation.isPending}
                    onClick={() => olderHistoryMutation.mutate()}
                  >
                    {olderHistoryMutation.isPending
                      ? "Loading…"
                      : "Load older analyses"}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
    </ContractSourceProvider>
  );
};

export default ContractDetails;
