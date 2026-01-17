'use client';

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
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
import { format } from "date-fns";

const ContractDetails = () => {
    const params = useParams();
    const id = params?.id as string;
    const queryClient = useQueryClient();
    const router = useRouter();
    const [analysisJobId, setAnalysisJobId] = useState<string | null>(null);
    const [llmUsed, setLlmUsed] = useState<{ provider?: string; model?: string } | null>(null);

    const formatDate = (value: unknown, formatStr: string, fallback: string) => {
        if (!value) return fallback;
        const date = value instanceof Date ? value : new Date(value as string);
        const time = date.getTime();
        if (Number.isNaN(time)) return fallback;
        return format(date, formatStr);
    };

    const getTimestamp = (value: unknown) => {
        if (!value) return 0;
        const date = value instanceof Date ? value : new Date(value as string);
        const time = date.getTime();
        return Number.isNaN(time) ? 0 : time;
    };

    const getContractErrorDetails = (error: unknown) => {
        const response = (error as any)?.response;
        const status = response?.status;
        const message =
            response?.data?.message ||
            response?.data?.error ||
            (error instanceof Error ? error.message : null);

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
        <div className="min-h-screen bg-background">
            <div className="container mx-auto px-4 py-12">
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
            return response.data;
        },
        enabled: !!id,
        refetchInterval: (query) => {
            // Poll if analysis is running (mock logic)
            return 5000;
        }
    });

    const { data: analysisJob } = useQuery({
        queryKey: ["job", analysisJobId],
        queryFn: async () => {
            const response = await apiClient.get(`/jobs/${analysisJobId}`);
            return response.data as {
                status?: string;
                error?: string;
                result?: { provider?: string; llmModel?: string };
            };
        },
        enabled: !!analysisJobId,
        refetchInterval: (query) => {
            const status = query.state.data?.status;
            if (!status) return 2000;
            return status === "SUCCEEDED" || status === "FAILED" ? false : 2000;
        },
    });

    const analyzeMutation = useMutation({
        mutationFn: async (params?: { force?: boolean }) => {
            const force = params?.force ? "?force=true" : "";
            const response = await apiClient.post(`/contracts/${id}/analyze${force}`);
            return response.data as { message?: string; jobId?: string; status?: string };
        },
        onSuccess: (data) => {
            toast.success(data?.message || "Analysis started");
            setLlmUsed(null);
            if (data?.jobId) setAnalysisJobId(data.jobId);
            queryClient.invalidateQueries({ queryKey: ["contract", id] });
        },
        onError: (error: any) => {
            toast.error(
                error.response?.data?.message ||
                error.response?.data?.error ||
                "Analysis failed to start"
            );
        }
    });

    const getRiskColor = (badge: string | null | undefined) => {
        const normalized = typeof badge === "string" ? badge.toLowerCase() : "";
        switch (normalized) {
            case "high": return "bg-destructive/15 text-destructive hover:bg-destructive/20";
            case "medium": return "bg-amber-500/15 text-amber-800 hover:bg-amber-500/20 dark:text-amber-200";
            case "low": return "bg-emerald-500/15 text-emerald-800 hover:bg-emerald-500/20 dark:text-emerald-200";
            default: return "bg-muted text-muted-foreground hover:bg-muted";
        }
    };

    const analysis = contract?.latestAnalysis && typeof contract.latestAnalysis === "object"
        ? contract.latestAnalysis
        : null;
    const analysisJobStatus = analysisJob?.status;
    const analyses = Array.isArray(contract?.analyses) ? contract.analyses : [];
    const sortedAnalyses = [...analyses].sort(
        (a: any, b: any) => getTimestamp(b?.createdAt) - getTimestamp(a?.createdAt)
    );
    const latestAnalysisRecord = sortedAnalyses[0];
    const olderAnalyses = analysis?.id
        ? sortedAnalyses.filter((a: any) => a.id !== analysis.id)
        : sortedAnalyses.slice(1);

    const resultJson = analysis?.resultJson && typeof analysis.resultJson === "object"
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

    const keyPoints = Array.isArray(analysis?.keyPoints)
        ? analysis.keyPoints
        : Array.isArray(resultJson?.key_points)
            ? resultJson.key_points
            : [];
    const redFlags = Array.isArray(resultJson?.red_flags) ? resultJson.red_flags : [];
    const redFlagFindings = redFlags
        .map((flag: any) => {
            const type = typeof flag?.type === "string" ? flag.type.trim() : "";
            const explanation = typeof flag?.explanation === "string" ? flag.explanation.trim() : "";
            if (type && explanation) return `${type}: ${explanation}`;
            return explanation || type || "";
        })
        .filter(Boolean);
    const keyFindings = redFlagFindings.length > 0 ? redFlagFindings : keyPoints;

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

    const llmProvider = llmUsed?.provider ?? analysisJob?.result?.provider;
    const llmModel = llmUsed?.model ?? analysisJob?.result?.llmModel ?? latestAnalysisRecord?.llmModel;
    const llmProviderLabel =
        llmProvider === "openrouter"
            ? "OpenRouter"
            : llmProvider === "openai"
                ? "OpenAI"
                : llmProvider;

    const deleteAnalysisMutation = useMutation({
        mutationFn: async (analysisId: string) => {
            // Mock delete API or implement it
            // await apiClient.delete(`/contracts/${id}/analysis/${analysisId}`);
            toast.success("Analysis deleted (mock)");
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["contract", id] });
        },
    });

    const deleteOlderAnalysesMutation = useMutation({
        mutationFn: async (analysisIds: string[]) => {
             toast.success("Older analyses deleted (mock)");
        },
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
        onError: (error: any) => {
            toast.error(error.response?.data?.message || "Failed to delete contract");
        }
    });

    useEffect(() => {
        setAnalysisJobId(null);
        setLlmUsed(null);
    }, [id]);

    useEffect(() => {
        if (!analysisJobId || !analysisJobStatus) return;

        if (analysisJobStatus === "SUCCEEDED") {
            const provider = analysisJob?.result?.provider;
            const model = analysisJob?.result?.llmModel;
            if (provider || model) {
                setLlmUsed({ provider, model });
            }
            queryClient.invalidateQueries({ queryKey: ["contract", id] });
            setAnalysisJobId(null);
            return;
        }

        if (analysisJobStatus === "FAILED") {
            toast.error(analysisJob?.error || "Analysis failed");
            setAnalysisJobId(null);
        }
    }, [analysisJobId, analysisJobStatus, analysisJob?.error, analysisJob?.result, id, queryClient]);

    if (isLoading) {
        return (
            <div className="container mx-auto px-4 py-8">
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
        <div className="min-h-screen bg-background pb-12">
            <div className="bg-background/60 backdrop-blur border-b">
                <div className="container mx-auto px-4 py-6">
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
                                    disabled={analyzeMutation.isPending || (!!analysisJobId && analysisJobStatus !== "FAILED")}
                                >
                                    {(analyzeMutation.isPending || (!!analysisJobId && analysisJobStatus !== "FAILED")) ? (
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

            <div className="container mx-auto px-4 py-8 space-y-6">
                {/* Analysis Result Section */}
                {analysis ? (
                    <>
                        <div className="grid gap-6 md:grid-cols-3">
                            {/* Risk Score Card */}
                            <Card className="md:col-span-1 border-l-4 border-l-primary">
                                <CardHeader>
                                    <CardTitle className="text-lg">Risk Assessment</CardTitle>
                                    <CardDescription>Overall contract risk level</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <Badge className={`text-lg px-4 py-1 ${getRiskColor(riskBadge)}`}>
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
                        
                        {/* More sections can be added here (Red flags etc) - Truncated for brevity but preserving structure */}
                    </>
                ) : (
                    <Card className="bg-muted/40 border-dashed">
                        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                            {analysisJobId && analysisJobStatus !== "FAILED" ? (
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
            </div>
        </div >
    );
};

export default ContractDetails;
