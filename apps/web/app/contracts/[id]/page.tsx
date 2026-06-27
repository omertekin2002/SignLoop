'use client';

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient, getApiErrorMessage, type ApiError } from "@/lib/api-client";
import { coerceDate, formatDate, getRiskColor } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
import { ArrowLeft, Play, AlertTriangle, Loader2, Trash2, Calendar, FileText, HelpCircle, Mail, Shield, Clock, DollarSign, RefreshCw, XCircle } from "lucide-react";
import { toast } from "sonner";
import type { AnalysisResult } from "@/lib/schemas";

type AnalysisRecord = {
    id: string;
    riskBadge?: string | null;
    resultJson?: Partial<AnalysisResult> | null;
    keyPoints?: string[] | null;
    llmProvider?: string | null;
    llmModel?: string | null;
    createdAt?: string | Date | null;
};

type ContractDetail = {
    title?: string | null;
    status?: string | null;
    createdAt?: string | Date | null;
    analyses?: AnalysisRecord[] | null;
};

const ContractDetails = () => {
    const params = useParams();
    const id = params?.id as string;
    const queryClient = useQueryClient();
    const router = useRouter();
    const [selectedAnalysisId, setSelectedAnalysisId] = useState<string | null>(null);

    const getContractErrorDetails = (error: unknown) => {
        const status = (error as ApiError).response?.status;
        const message = getApiErrorMessage(error, error instanceof Error ? error.message : "");

        if (status === 404) {
            return {
                title: "Contract not found",
                description: "We could not find this contract. It may have been deleted or the link is invalid.",
            };
        }

        if (typeof status === "number" && status >= 500) {
            return {
                title: "Server error",
                description: "We hit a server error while loading this contract. Please try again soon.",
            };
        }

        return {
            title: "Unable to load contract",
            description: message || "We could not load this contract right now. Please try again later.",
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
                        <h2 className="text-xl font-semibold text-foreground">{title}</h2>
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

    const { data: contract, isLoading, isError, error } = useQuery({
        queryKey: ["contract", id],
        queryFn: async () => {
            const response = await apiClient.get(`/contracts/${id}`);
            return response.data as ContractDetail;
        },
        enabled: !!id,
    });

    const analyzeMutation = useMutation({
        mutationFn: async (params?: { force?: boolean }) => {
            const force = params?.force ? "?force=true" : "";
            const response = await apiClient.post(`/contracts/${id}/analyze${force}`);
            return response.data as { message?: string; jobId?: string; status?: string };
        },
        onSuccess: (data) => {
            toast.success(data?.message || "Analysis complete");
            queryClient.invalidateQueries({ queryKey: ["contract", id] });
            queryClient.invalidateQueries({ queryKey: ["contracts"] });
        },
        onError: (error: ApiError) => {
            toast.error(getApiErrorMessage(error, "Analysis failed to start"));
        }
    });

    const sortedAnalyses = useMemo<AnalysisRecord[]>(() => {
        const list = Array.isArray(contract?.analyses) ? contract.analyses : [];
        const ts = (value: unknown) => coerceDate(value)?.getTime() ?? 0;
        return [...list].sort((a, b) => ts(b?.createdAt) - ts(a?.createdAt));
    }, [contract?.analyses]);
    const latestAnalysisRecord = sortedAnalyses[0] ?? null;
    const selectedAnalysis = selectedAnalysisId
        ? sortedAnalyses.find((a) => a.id === selectedAnalysisId) ?? null
        : null;
    const analysis = selectedAnalysis ?? latestAnalysisRecord;
    const olderAnalyses = sortedAnalyses.slice(1);
    const isViewingHistoricalAnalysis = Boolean(
        analysis?.id &&
        latestAnalysisRecord?.id &&
        analysis.id !== latestAnalysisRecord.id
    );

    const resultJson: Partial<AnalysisResult> | null = analysis?.resultJson && typeof analysis.resultJson === "object"
        ? analysis.resultJson
        : null;
    const summary = resultJson?.summary && typeof resultJson.summary === "object"
        ? resultJson.summary
        : null;
    const summaryPayments = summary?.payments && typeof summary.payments === "object"
        ? summary.payments
        : null;
    const summaryTerm = summary?.term && typeof summary.term === "object"
        ? summary.term
        : null;
    const summaryRenewal = summary?.renewal && typeof summary.renewal === "object"
        ? summary.renewal
        : null;

    const riskBadge = typeof analysis?.riskBadge === "string"
        ? analysis.riskBadge
        : typeof resultJson?.risk_badge === "string"
            ? resultJson.risk_badge
            : "UNKNOWN";

    const keyPoints: string[] = Array.isArray(analysis?.keyPoints)
        ? analysis.keyPoints
        : Array.isArray(resultJson?.key_points)
            ? resultJson.key_points
            : [];
    const redFlags: AnalysisResult["red_flags"] = Array.isArray(resultJson?.red_flags) ? resultJson.red_flags : [];
    const redFlagFindings = redFlags
        .map((flag) => {
            const type = typeof flag?.type === "string" ? flag.type.trim() : "";
            const explanation = typeof flag?.explanation === "string" ? flag.explanation.trim() : "";
            if (type && explanation) return `${type}: ${explanation}`;
            return explanation || type || "";
        })
        .filter(Boolean);
    const keyFindings = redFlagFindings.length > 0 ? redFlagFindings : keyPoints;
    const summaryCancellation = summary?.cancellation && typeof summary.cancellation === "object"
        ? summary.cancellation
        : null;
    const keyDates: AnalysisResult["key_dates"] = Array.isArray(resultJson?.key_dates) ? resultJson.key_dates : [];
    const nextActions = resultJson?.next_actions && typeof resultJson.next_actions === "object"
        ? resultJson.next_actions
        : null;
    const questionsToAsk: string[] = Array.isArray(nextActions?.questions_to_ask)
        ? nextActions.questions_to_ask
        : [];
    const emailTemplates: AnalysisResult["next_actions"]["email_templates"] = Array.isArray(nextActions?.email_templates)
        ? nextActions.email_templates
        : [];

    const uploadedDateLabel = formatDate(contract?.createdAt, "MMM d, yyyy", "Unknown date");
    const analysisDateLabel = formatDate(analysis?.createdAt, "MMM d, HH:mm", "Unknown time");
    const renewalLabel = summaryRenewal
        ? summaryRenewal.auto_renew
            ? "Auto-renews"
            : "Manual renewal"
        : "Not specified";
    const contractTitle = typeof contract?.title === "string" && contract.title.trim()
        ? contract.title
        : "Untitled contract";

    const llmProvider = analysis?.llmProvider;
    const llmModel = analysis?.llmModel;
    const llmProviderLabel =
        llmProvider === "openrouter"
            ? "OpenRouter"
            : llmProvider === "openai"
                ? "OpenAI"
                : llmProvider;

    const deleteAnalysisMutation = useMutation({
        mutationFn: async (analysisId: string) => {
            await apiClient.delete(`/contracts/${id}/analysis/${analysisId}`);
        },
        onSuccess: () => {
            toast.success("Analysis deleted");
            queryClient.invalidateQueries({ queryKey: ["contract", id] });
            queryClient.invalidateQueries({ queryKey: ["contracts"] });
        },
        onError: (error: ApiError) => {
            toast.error(getApiErrorMessage(error, "Failed to delete analysis"));
        },
    });

    const deleteOlderAnalysesMutation = useMutation({
        mutationFn: async (analysisIds: string[]) => {
            const results = await Promise.allSettled(
                analysisIds.map((analysisId) =>
                    apiClient.delete(`/contracts/${id}/analysis/${analysisId}`)
                )
            );
            const failed = results.filter((r) => r.status === "rejected").length;
            return { total: analysisIds.length, failed };
        },
        onSuccess: ({ total, failed }) => {
            // Always refresh — some deletes may have succeeded even if others failed.
            queryClient.invalidateQueries({ queryKey: ["contract", id] });
            queryClient.invalidateQueries({ queryKey: ["contracts"] });
            if (failed > 0) {
                toast.error(`Deleted ${total - failed} of ${total}; ${failed} could not be deleted.`);
            } else {
                toast.success("Older analyses deleted");
            }
        },
        onError: (error: ApiError) => {
            toast.error(getApiErrorMessage(error, "Failed to delete older analyses"));
        }
    });

    const deleteContractMutation = useMutation({
        mutationFn: async () => {
            await apiClient.delete(`/contracts/${id}`);
        },
        onSuccess: () => {
            toast.success("Contract deleted");
            queryClient.invalidateQueries({ queryKey: ["contracts"] });
            router.push("/dashboard");
        },
        onError: (error: ApiError) => {
            toast.error(getApiErrorMessage(error, "Failed to delete contract"));
        }
    });

    useEffect(() => {
        setSelectedAnalysisId(null);
    }, [id]);

    useEffect(() => {
        if (!selectedAnalysisId) return;
        const stillExists = sortedAnalyses.some((item) => item.id === selectedAnalysisId);
        if (!stillExists) {
            setSelectedAnalysisId(null);
        }
    }, [selectedAnalysisId, sortedAnalyses]);

    if (isLoading) {
        return (
            <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
                <Skeleton className="h-8 w-48 mb-6" />
                <Card>
                    <CardHeader><Skeleton className="h-6 w-32" /></CardHeader>
                    <CardContent><Skeleton className="h-24 w-full" /></CardContent>
                </Card>
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
            "We could not find this contract. It may have been deleted or the link is invalid."
        );
    }

    return (
        <div className="app-page pb-12">
            <div className="app-header">
                <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
                    <Link href="/dashboard" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors">
                        <ArrowLeft className="mr-2 h-4 w-4" />
                        Back to Dashboard
                    </Link>
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                        <div>
                            <h1 className="text-3xl font-bold text-foreground">{contractTitle}</h1>
                            <div className="flex items-center gap-2 mt-2 text-sm text-muted-foreground">
                                <span>Uploaded {uploadedDateLabel}</span>
                                <span>•</span>
                                <Badge variant="outline">{contract.status || "UNKNOWN"}</Badge>
                            </div>
                        </div>

                        <div className="flex items-center gap-2">
                            {analysis && (
                                <Button
                                    onClick={() => analyzeMutation.mutate({ force: true })}
                                    disabled={analyzeMutation.isPending}
                                >
                                    {analyzeMutation.isPending ? (
                                        <>
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                            Analyzing...
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
                                            This will permanently delete the contract and all associated analyses. This cannot be undone.
                                        </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                        <AlertDialogCancel disabled={deleteContractMutation.isPending}>Cancel</AlertDialogCancel>
                                        <AlertDialogAction
                                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                            disabled={deleteContractMutation.isPending}
                                            onClick={() => deleteContractMutation.mutate()}
                                        >
                                            {deleteContractMutation.isPending ? "Deleting..." : "Delete"}
                                        </AlertDialogAction>
                                    </AlertDialogFooter>
                                </AlertDialogContent>
                            </AlertDialog>
                        </div>
                    </div>
                </div>
            </div>

            <div className="mx-auto max-w-7xl px-4 py-8 space-y-6 sm:px-6 lg:px-8">
                {/* Analysis Result Section */}
                {analysis ? (
                    <>
                        {isViewingHistoricalAnalysis && (
                            <Card className="border-amber-500/50 bg-amber-500/5">
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

                        <div className="grid gap-6 md:grid-cols-3">
                            {/* Risk Score Card */}
                            <Card className="md:col-span-1 border-l-4 border-l-primary">
                                <CardHeader>
                                    <CardTitle className="text-lg">Risk Assessment</CardTitle>
                                    <CardDescription>Overall contract risk level</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <Badge className={`text-lg px-4 py-1 ${getRiskColor(riskBadge, { hover: true })}`}>
                                        {riskBadge || "UNKNOWN"}
                                    </Badge>
                                    <p className="mt-4 text-sm text-muted-foreground">
                                        Analyzed on {analysisDateLabel}
                                    </p>
                                    {!!llmModel && (
                                        <p className="mt-2 text-xs text-muted-foreground">
                                            LLM: {llmProviderLabel ? `${llmProviderLabel} • ` : ""}{llmModel}
                                        </p>
                                    )}
                                </CardContent>
                            </Card>

                            {/* Key Risks / Points */}
                            <Card className="md:col-span-2">
                                <CardHeader>
                                    <CardTitle>Key Findings</CardTitle>
                                    <CardDescription>Important points extracted from the contract</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    {keyFindings.length > 0 ? (
                                        <ul className="space-y-4">
                                            {keyFindings.map((point: string, idx: number) => (
                                                <li key={idx} className="flex items-start gap-3 p-3 rounded-lg bg-muted/60">
                                                    <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                                                    <span className="text-sm text-foreground/90 leading-relaxed">{point}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    ) : (
                                        <div className="text-center py-8 text-muted-foreground">
                                            No key findings yet. Re-run analysis to extract highlights.
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        </div>

                        {/* Contract Summary Section */}
                        <Card className="mt-6">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <FileText className="h-5 w-5" />
                                    Contract Summary
                                </CardTitle>
                                <CardDescription>Quick overview of the contract terms</CardDescription>
                            </CardHeader>
                            <CardContent>
                                {summary ? (
                                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                                        {/* What It Is */}
                                        <div className="p-4 rounded-lg bg-muted/40">
                                            <h4 className="text-sm font-medium text-muted-foreground mb-1">What It Is</h4>
                                            <p className="text-sm">{summary.what_it_is || "Not specified"}</p>
                                        </div>

                                        {/* Payments */}
                                        <div className="p-4 rounded-lg bg-muted/40">
                                            <h4 className="text-sm font-medium text-muted-foreground mb-1 flex items-center gap-1">
                                                <DollarSign className="h-4 w-4" /> Payments
                                            </h4>
                                            <p className="text-sm font-medium">
                                                {summaryPayments?.amount || "Not specified"}
                                            </p>
                                            {summaryPayments?.frequency && (
                                                <p className="text-xs text-muted-foreground">
                                                    {summaryPayments.frequency}
                                                </p>
                                            )}
                                        </div>

                                        {/* Term */}
                                        <div className="p-4 rounded-lg bg-muted/40">
                                            <h4 className="text-sm font-medium text-muted-foreground mb-1 flex items-center gap-1">
                                                <Clock className="h-4 w-4" /> Term
                                            </h4>
                                            <p className="text-sm">
                                                {summaryTerm?.minimum_term || "Not specified"}
                                            </p>
                                        </div>

                                        {/* Renewal */}
                                        <div className="p-4 rounded-lg bg-muted/40">
                                            <h4 className="text-sm font-medium text-muted-foreground mb-1 flex items-center gap-1">
                                                <RefreshCw className="h-4 w-4" /> Renewal
                                            </h4>
                                            <p className="text-sm">{renewalLabel}</p>
                                            {summaryRenewal?.renewal_period && (
                                                <p className="text-xs text-muted-foreground">
                                                    Period: {summaryRenewal.renewal_period}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                ) : (
                                    <div className="text-center py-8 text-muted-foreground">
                                        Summary unavailable. Re-run analysis to generate the contract overview.
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        {/* Cancellation Terms */}
                        {summaryCancellation && (
                            <Card className="mt-6">
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <XCircle className="h-5 w-5" />
                                        Cancellation Terms
                                    </CardTitle>
                                    <CardDescription>How this agreement can be ended</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="grid gap-4 md:grid-cols-3">
                                        <div className="p-4 rounded-lg bg-muted/40">
                                            <h4 className="text-sm font-medium text-muted-foreground mb-1">How to cancel</h4>
                                            <p className="text-sm">{summaryCancellation.how || "Not specified"}</p>
                                        </div>
                                        <div className="p-4 rounded-lg bg-muted/40">
                                            <h4 className="text-sm font-medium text-muted-foreground mb-1">Notice period</h4>
                                            <p className="text-sm">
                                                {typeof summaryCancellation.notice_period_days === "number"
                                                    ? `${summaryCancellation.notice_period_days} days`
                                                    : "Not specified"}
                                            </p>
                                        </div>
                                        <div className="p-4 rounded-lg bg-muted/40">
                                            <h4 className="text-sm font-medium text-muted-foreground mb-1">Penalties</h4>
                                            {Array.isArray(summaryCancellation.penalties) && summaryCancellation.penalties.length > 0 ? (
                                                <ul className="text-sm list-disc list-inside space-y-1">
                                                    {summaryCancellation.penalties.map((penalty: string, idx: number) => (
                                                        <li key={idx}>{penalty}</li>
                                                    ))}
                                                </ul>
                                            ) : (
                                                <p className="text-sm">None listed</p>
                                            )}
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        )}

                        {/* Red Flags */}
                        {redFlags.length > 0 && (
                            <Card className="mt-6 border-l-4 border-l-destructive">
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2 text-destructive">
                                        <Shield className="h-5 w-5" />
                                        Red Flags ({redFlags.length})
                                    </CardTitle>
                                    <CardDescription>Potential issues identified in the contract</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="space-y-4">
                                        {redFlags.map((flag, idx) => {
                                            const type = typeof flag?.type === "string" ? flag.type : "Risk";
                                            const explanation = typeof flag?.explanation === "string" ? flag.explanation : "";
                                            const confidence =
                                                typeof flag?.confidence === "number" ? `${flag.confidence}%` : "Not provided";
                                            const severity =
                                                typeof flag?.severity === "number" && Number.isFinite(flag.severity)
                                                    ? Math.max(0, Math.min(10, flag.severity))
                                                    : null;
                                            const where = typeof flag?.where === "string" ? flag.where : "";

                                            return (
                                                <div key={idx} className="p-4 rounded-lg border bg-card">
                                                    <div className="flex items-start justify-between gap-4">
                                                        <div className="flex-1">
                                                            <div className="flex items-center gap-2 mb-2">
                                                                <Badge variant="outline" className="text-xs">
                                                                    {type}
                                                                </Badge>
                                                                <span className="text-xs text-muted-foreground">
                                                                    Confidence: {confidence}
                                                                </span>
                                                            </div>
                                                            <p className="text-sm">{explanation || "No explanation provided."}</p>
                                                            {where && (
                                                                <p className="text-xs text-muted-foreground mt-1">
                                                                    Found in: {where}
                                                                </p>
                                                            )}
                                                        </div>
                                                        <div className="flex flex-col items-end gap-1">
                                                            <span className="text-xs text-muted-foreground">Severity</span>
                                                            {severity !== null ? (
                                                                <div className="flex items-center gap-1">
                                                                    <div className="w-16 h-2 rounded-full bg-muted overflow-hidden">
                                                                        <div
                                                                            className={`h-full rounded-full ${severity >= 7 ? "bg-destructive" :
                                                                                severity >= 4 ? "bg-amber-500" : "bg-emerald-500"
                                                                                }`}
                                                                            style={{ width: `${severity * 10}%` }}
                                                                        />
                                                                    </div>
                                                                    <span className="text-xs font-medium">{severity}/10</span>
                                                                </div>
                                                            ) : (
                                                                <span className="text-xs font-medium text-muted-foreground">Not provided</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </CardContent>
                            </Card>
                        )}

                        {/* Key Dates */}
                        {keyDates.length > 0 && (
                            <Card className="mt-6">
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <Calendar className="h-5 w-5" />
                                        Key Dates
                                    </CardTitle>
                                    <CardDescription>Important dates to track</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                                        {keyDates.map((date, idx) => (
                                            <div key={idx} className="flex items-center gap-3 p-3 rounded-lg border bg-card">
                                                <div className="rounded-full p-2 bg-primary/10">
                                                    <Calendar className="h-4 w-4 text-primary" />
                                                </div>
                                                <div>
                                                    <p className="text-sm font-medium">
                                                        {typeof date?.type === "string" ? date.type.replace(/_/g, " ") : "DATE"}
                                                    </p>
                                                    <p className="text-xs text-muted-foreground">
                                                        {typeof date?.date === "string" ? date.date : "Unknown"}
                                                    </p>
                                                    {typeof date?.derived_from === "string" && date.derived_from && (
                                                        <p className="text-xs text-muted-foreground italic">From: {date.derived_from}</p>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </CardContent>
                            </Card>
                        )}

                        {/* Next Actions */}
                        {(questionsToAsk.length > 0 || emailTemplates.length > 0) && (
                            <Card className="mt-6">
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <HelpCircle className="h-5 w-5" />
                                        Recommended Actions
                                    </CardTitle>
                                    <CardDescription>Suggested follow-up based on the analysis</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    {questionsToAsk.length > 0 && (
                                        <div className="mb-6">
                                            <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                                                <HelpCircle className="h-4 w-4 text-primary" />
                                                Questions to Ask
                                            </h4>
                                            <ul className="space-y-2">
                                                {questionsToAsk.map((question: string, idx: number) => (
                                                    <li key={idx} className="flex items-start gap-2 text-sm">
                                                        <span className="text-primary font-medium">{idx + 1}.</span>
                                                        <span>{question}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}

                                    {emailTemplates.length > 0 && (
                                        <div>
                                            <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                                                <Mail className="h-4 w-4 text-primary" />
                                                Email Templates
                                            </h4>
                                            <div className="space-y-3">
                                                {emailTemplates.map((template, idx) => (
                                                    <div key={idx} className="p-3 rounded-lg border bg-muted/30">
                                                        <p className="text-sm font-medium mb-1">
                                                            Subject: {typeof template?.subject === "string" ? template.subject : "Untitled"}
                                                        </p>
                                                        <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                                                            {typeof template?.body === "string" ? template.body : ""}
                                                        </p>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        )}
                    </>
                ) : (
                    <Card className="bg-muted/40 border-dashed">
                        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                            {analyzeMutation.isPending ? (
                                <>
                                    <div className="rounded-full bg-card p-4 shadow-sm mb-4">
                                        <Loader2 className="h-8 w-8 text-primary animate-spin" />
                                    </div>
                                    <h3 className="text-lg font-semibold text-foreground">Analysis in progress</h3>
                                    <p className="text-sm text-muted-foreground max-w-sm mt-2">
                                        This can take up to a minute. We’ll refresh automatically when it’s ready.
                                    </p>
                                </>
                            ) : (
                                <>
                                    <div className="rounded-full bg-card p-4 shadow-sm mb-4">
                                        <Play className="h-8 w-8 text-primary" />
                                    </div>
                                    <h3 className="text-lg font-semibold text-foreground">No Analysis Yet</h3>
                                    <p className="text-sm text-muted-foreground max-w-sm mt-2 mb-6">
                                        Run our AI analysis to identify risks, missing clauses, and key obligations in this contract.
                                    </p>
                                    <Button onClick={() => analyzeMutation.mutate({})} disabled={analyzeMutation.isPending}>
                                        Start Analysis
                                    </Button>
                                </>
                            )}
                        </CardContent>
                    </Card>
                )}

                {/* Analysis History */}
                {olderAnalyses.length > 0 && (
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0">
                            <div>
                                <CardTitle>Analysis History</CardTitle>
                                <CardDescription>Manage older analyses for this contract</CardDescription>
                            </div>
                            <Button
                                variant="destructive"
                                size="sm"
                                disabled={deleteOlderAnalysesMutation.isPending}
                                onClick={() => {
                                    const ok = window.confirm(
                                        `Delete ${olderAnalyses.length} older analysis(es)? This cannot be undone.`
                                    );
                                    if (!ok) return;
                                    deleteOlderAnalysesMutation.mutate(olderAnalyses.map((a) => a.id));
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
                                                <Badge className={getRiskColor(a.riskBadge, { hover: true })}>
                                                    {a.riskBadge || "UNKNOWN"}
                                                </Badge>
                                                <span className="text-sm text-muted-foreground">
                                                    {formatDate(a.createdAt, "MMM d, HH:mm")}
                                                </span>
                                            </div>
                                            <div className="text-xs text-muted-foreground">
                                                {a.resultJson?.key_points?.length
                                                    ? `${a.resultJson.key_points.length} key point(s)`
                                                    : "No key points"}
                                            </div>
                                            {!!a.llmModel && (
                                                <div className="text-xs text-muted-foreground">
                                                    Model: {a.llmModel}
                                                </div>
                                            )}
                                        </div>

                                        <div className="flex items-center gap-2">
                                            <Button
                                                variant={analysis?.id === a.id ? "secondary" : "outline"}
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
                                                        "Delete this analysis? This cannot be undone."
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
                            </div>
                        </CardContent>
                    </Card>
                )}
            </div>
        </div >
    );
};

export default ContractDetails;
