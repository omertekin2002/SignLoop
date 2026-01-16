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

    const { data: contract, isLoading } = useQuery({
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

    const getRiskColor = (badge: string) => {
        switch (badge?.toLowerCase()) {
            case "high": return "bg-destructive/15 text-destructive hover:bg-destructive/20";
            case "medium": return "bg-amber-500/15 text-amber-800 hover:bg-amber-500/20 dark:text-amber-200";
            case "low": return "bg-emerald-500/15 text-emerald-800 hover:bg-emerald-500/20 dark:text-emerald-200";
            default: return "bg-muted text-muted-foreground hover:bg-muted";
        }
    };

    const analysis = contract?.latestAnalysis;
    const analysisJobStatus = analysisJob?.status;
    const analyses = Array.isArray(contract?.analyses) ? contract.analyses : [];
    const sortedAnalyses = [...analyses].sort(
        (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const latestAnalysisRecord = sortedAnalyses[0];
    const olderAnalyses = analysis?.id
        ? sortedAnalyses.filter((a: any) => a.id !== analysis.id)
        : sortedAnalyses.slice(1);

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

    if (!contract) return <div>Contract not found</div>;

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
                            <h1 className="text-3xl font-bold text-foreground">{contract.title}</h1>
                            <div className="flex items-center gap-2 mt-2 text-sm text-muted-foreground">
                                <span>Uploaded {format(new Date(contract.createdAt), "MMM d, yyyy")}</span>
                                <span>•</span>
                                <Badge variant="outline">{contract.status}</Badge>
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
                                    <Badge className={`text-lg px-4 py-1 ${getRiskColor(analysis.riskBadge)}`}>
                                        {analysis.riskBadge || "UNKNOWN"}
                                    </Badge>
                                    <p className="mt-4 text-sm text-muted-foreground">
                                        Analyzed on {format(new Date(analysis.createdAt), "MMM d, HH:mm")}
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
                                    {analysis.keyPoints && analysis.keyPoints.length > 0 ? (
                                        <ul className="space-y-4">
                                            {analysis.keyPoints.map((point: string, idx: number) => (
                                                <li key={idx} className="flex items-start gap-3 p-3 rounded-lg bg-muted/60">
                                                    <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                                                    <span className="text-sm text-foreground/90 leading-relaxed">{point}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    ) : (
                                        <div className="text-center py-8 text-muted-foreground">
                                            No key points extracted.
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        </div>

                        {/* Contract Summary Section */}
                        {analysis.resultJson?.summary && (
                            <Card className="mt-6">
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <FileText className="h-5 w-5" />
                                        Contract Summary
                                    </CardTitle>
                                    <CardDescription>Quick overview of the contract terms</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                                        {/* What It Is */}
                                        <div className="p-4 rounded-lg bg-muted/40">
                                            <h4 className="text-sm font-medium text-muted-foreground mb-1">What It Is</h4>
                                            <p className="text-sm">{analysis.resultJson.summary.what_it_is || "Not specified"}</p>
                                        </div>

                                        {/* Payments */}
                                        <div className="p-4 rounded-lg bg-muted/40">
                                            <h4 className="text-sm font-medium text-muted-foreground mb-1 flex items-center gap-1">
                                                <DollarSign className="h-4 w-4" /> Payments
                                            </h4>
                                            <p className="text-sm font-medium">
                                                {analysis.resultJson.summary.payments?.amount || "Not specified"}
                                            </p>
                                            {analysis.resultJson.summary.payments?.frequency && (
                                                <p className="text-xs text-muted-foreground">
                                                    {analysis.resultJson.summary.payments.frequency}
                                                </p>
                                            )}
                                        </div>

                                        {/* Term */}
                                        <div className="p-4 rounded-lg bg-muted/40">
                                            <h4 className="text-sm font-medium text-muted-foreground mb-1 flex items-center gap-1">
                                                <Clock className="h-4 w-4" /> Term
                                            </h4>
                                            <p className="text-sm">
                                                {analysis.resultJson.summary.term?.minimum_term || "Not specified"}
                                            </p>
                                        </div>

                                        {/* Renewal */}
                                        <div className="p-4 rounded-lg bg-muted/40">
                                            <h4 className="text-sm font-medium text-muted-foreground mb-1 flex items-center gap-1">
                                                <RefreshCw className="h-4 w-4" /> Renewal
                                            </h4>
                                            <p className="text-sm">
                                                {analysis.resultJson.summary.renewal?.auto_renew ? "Auto-renews" : "Manual renewal"}
                                            </p>
                                            {analysis.resultJson.summary.renewal?.renewal_period && (
                                                <p className="text-xs text-muted-foreground">
                                                    Period: {analysis.resultJson.summary.renewal.renewal_period}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        )}
                        
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
