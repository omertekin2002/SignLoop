"use client";

import { useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient, getApiErrorMessage } from "@/lib/api-client";
import { formatDate, formatFileSize, getRiskColor } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
    ArrowLeft,
    Plus,
    FileText,
    Book,
    Scale,
    Upload,
    Trash2,
    Loader2,
    Play,
    ChevronRight,
    File,
} from "lucide-react";
import { toast } from "sonner";

interface Project {
    id: string;
    title: string;
    description?: string;
    status: string;
    createdAt: string;
    contracts: Array<{
        id: string;
        title: string;
        status: string;
        createdAt: string;
        analyses?: Array<{ id: string; riskBadge: string }>;
    }>;
    contextDocuments: Array<{
        id: string;
        title: string;
        documentType: string;
        originalFilename?: string;
        fileSize?: number;
        wordCount?: number;
        createdAt: string;
    }>;
}
const ProjectDetails = () => {
    const params = useParams<{ id: string }>();
    const id = params?.id as string;
    const router = useRouter();
    const queryClient = useQueryClient();
    const contractFileRef = useRef<HTMLInputElement>(null);
    const contextFileRef = useRef<HTMLInputElement>(null);

    const [contractName, setContractName] = useState("");
    const [selectedContractFile, setSelectedContractFile] = useState<File | null>(null);
    const [contextTitle, setContextTitle] = useState("");
    const [contextType, setContextType] = useState<string>("other");
    const [selectedContextFile, setSelectedContextFile] = useState<File | null>(null);
    const [docToDelete, setDocToDelete] = useState<{ id: string; type: "context" } | null>(null);

    const { data: project, isLoading } = useQuery({
        queryKey: ["project", id],
        queryFn: async () => {
            const response = await apiClient.get(`/projects/${id}`);
            return response.data as Project;
        },
        enabled: !!id,
    });

    const deleteProjectMutation = useMutation({
        mutationFn: async () => {
            await apiClient.delete(`/projects/${id}`);
        },
        onSuccess: () => {
            toast.success("Project deleted");
            queryClient.invalidateQueries({ queryKey: ["projects"] });
            router.push("/dashboard");
        },
    });

    const deleteContextDocMutation = useMutation({
        mutationFn: async (docId: string) => {
            await apiClient.delete(`/projects/${id}/context/${docId}`);
        },
        onSuccess: () => {
            toast.success("Context document deleted");
            queryClient.invalidateQueries({ queryKey: ["project", id] });
            setDocToDelete(null);
        },
    });

    const handleContractFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files?.[0]) {
            setSelectedContractFile(e.target.files[0]);
            setContractName(e.target.files[0].name.replace(/\.[^/.]+$/, ""));
        }
    };

    const handleContextFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files?.[0]) {
            setSelectedContextFile(e.target.files[0]);
            setContextTitle(e.target.files[0].name.replace(/\.[^/.]+$/, ""));
        }
    };

    const uploadContractMutation = useMutation({
        mutationFn: async () => {
            // 1. Create the contract with project association.
            const createRes = await apiClient.post("/contracts", {
                title: contractName,
                projectId: id,
            });
            const contractId = createRes.data.id;

            // 2. Upload the file; if this fails, roll back the just-created contract so we don't
            // leave an empty, file-less contract behind.
            try {
                const formData = new FormData();
                formData.append("file", selectedContractFile as File);
                await apiClient.post(`/contracts/${contractId}/upload`, formData, {
                    headers: { "Content-Type": "multipart/form-data" },
                });
            } catch (uploadError) {
                await apiClient.delete(`/contracts/${contractId}`).catch(() => {});
                throw uploadError;
            }
        },
        onSuccess: () => {
            toast.success("Contract uploaded successfully");
            setSelectedContractFile(null);
            setContractName("");
            if (contractFileRef.current) contractFileRef.current.value = "";
            queryClient.invalidateQueries({ queryKey: ["project", id] });
        },
        onError: (error: unknown) => {
            toast.error(getApiErrorMessage(error, "Failed to upload contract"));
        },
    });

    const uploadContextMutation = useMutation({
        mutationFn: async () => {
            const formData = new FormData();
            formData.append("file", selectedContextFile as File);
            formData.append("title", contextTitle);
            formData.append("documentType", contextType);

            await apiClient.post(`/projects/${id}/context`, formData, {
                headers: { "Content-Type": "multipart/form-data" },
            });
        },
        onSuccess: () => {
            toast.success("Context document uploaded");
            setSelectedContextFile(null);
            setContextTitle("");
            setContextType("other");
            if (contextFileRef.current) contextFileRef.current.value = "";
            queryClient.invalidateQueries({ queryKey: ["project", id] });
        },
        onError: (error: unknown) => {
            toast.error(getApiErrorMessage(error, "Failed to upload context"));
        },
    });

    const handleUploadContract = () => {
        if (!selectedContractFile || !contractName) return;
        uploadContractMutation.mutate();
    };

    const handleUploadContext = () => {
        if (!selectedContextFile || !contextTitle) return;
        uploadContextMutation.mutate();
    };

    const getDocTypeIcon = (type: string) => {
        switch (type) {
            case "legal_text":
                return <Scale className="h-4 w-4 text-blue-500" />;
            case "prior_contract":
                return <FileText className="h-4 w-4 text-green-500" />;
            case "regulation":
                return <Book className="h-4 w-4 text-purple-500" />;
            default:
                return <File className="h-4 w-4 text-gray-500" />;
        }
    };

    if (isLoading) {
        return (
            <div className="min-h-screen bg-transparent">
                <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
                    <Skeleton className="h-8 w-64 mb-4" />
                    <Skeleton className="h-96 w-full" />
                </div>
            </div>
        );
    }

    if (!project) {
        return (
            <div className="min-h-screen bg-transparent flex items-center justify-center">
                <div className="text-center">
                    <h2 className="text-lg font-semibold">Project not found</h2>
                    <Link href="/dashboard" className="text-primary hover:underline">
                        Back to Dashboard
                    </Link>
                </div>
            </div>
        );
    }

    const firstProjectContract = project.contracts[0];

    return (
        <div className="app-page">
            {/* Header */}
            <div className="app-header">
                <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
                    <div className="flex items-center gap-2 mb-4">
                        <Link
                            href="/dashboard"
                            className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Back to Dashboard
                        </Link>
                    </div>
                    <div className="flex justify-between items-start">
                        <div>
                            <h1 className="text-3xl font-bold">{project.title}</h1>
                            {project.description && (
                                <p className="text-muted-foreground mt-1">{project.description}</p>
                            )}
                            <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
                                <span>Created {formatDate(project.createdAt, "MMM d, yyyy")}</span>
                                <Badge variant="secondary">{project.status}</Badge>
                            </div>
                        </div>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => deleteProjectMutation.mutate()}
                            disabled={deleteProjectMutation.isPending}
                        >
                            <Trash2 className="h-4 w-4 mr-1" />
                            Delete Project
                        </Button>
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
                <div className="grid gap-6 lg:grid-cols-2">
                    {/* Left: Contract Section */}
                    <div>
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <FileText className="h-5 w-5" />
                                    Contract to Analyze
                                </CardTitle>
                                <CardDescription>
                                    Upload the contract you want to analyze with legal context
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                {/* Existing Contracts */}
                                {project.contracts.length > 0 && (
                                    <div className="mb-4 space-y-2">
                                        {project.contracts.map((contract) => (
                                            <Link
                                                key={contract.id}
                                                href={`/contracts/${contract.id}`}
                                                className="flex items-center justify-between border border-[var(--surface-stroke-soft)] bg-[var(--surface-elevated)] p-3 transition-colors hover:border-[var(--surface-stroke)] hover:bg-[var(--surface-base)]"
                                            >
                                                <div className="flex items-center gap-3">
                                                    <FileText className="h-5 w-5 text-primary" />
                                                    <div>
                                                        <p className="font-medium">{contract.title}</p>
                                                        <p className="text-xs text-muted-foreground">
                                                            {formatDate(contract.createdAt, "MMM d, yyyy")}
                                                        </p>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    {contract.analyses?.[0]?.riskBadge && (
                                                        <Badge className={getRiskColor(contract.analyses[0].riskBadge)}>
                                                            {contract.analyses[0].riskBadge}
                                                        </Badge>
                                                    )}
                                                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                                </div>
                                            </Link>
                                        ))}
                                    </div>
                                )}

                                {/* Upload New Contract */}
                                <div className="border border-dashed border-[var(--surface-stroke)] bg-[var(--surface-base)] p-4">
                                    <div className="space-y-3">
                                        <div>
                                            <Label htmlFor="contract-name">Contract Name</Label>
                                            <Input
                                                id="contract-name"
                                                value={contractName}
                                                onChange={(e) => setContractName(e.target.value)}
                                                placeholder="e.g., Vendor Agreement Q1"
                                            />
                                        </div>
                                        <div
                                            className="cursor-pointer border border-[var(--surface-stroke-soft)] bg-[var(--surface-inset)] p-4 text-center transition-colors hover:border-[var(--surface-stroke)] hover:bg-[var(--surface-base)]"
                                            onClick={() => contractFileRef.current?.click()}
                                        >
                                            {selectedContractFile ? (
                                                <div>
                                                    <File className="h-8 w-8 mx-auto text-primary mb-2" />
                                                    <p className="text-sm font-medium">{selectedContractFile.name}</p>
                                                    <p className="text-xs text-muted-foreground">
                                                        {formatFileSize(selectedContractFile.size)}
                                                    </p>
                                                </div>
                                            ) : (
                                                <div>
                                                    <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                                                    <p className="text-sm">Click to select contract file</p>
                                                    <p className="text-xs text-muted-foreground">PDF, DOC, DOCX, TXT, or images</p>
                                                </div>
                                            )}
                                            <input
                                                ref={contractFileRef}
                                                type="file"
                                                accept=".pdf,.txt,.doc,.docx,image/*"
                                                className="hidden"
                                                onChange={handleContractFileChange}
                                            />
                                        </div>
                                        <Button
                                            onClick={handleUploadContract}
                                            disabled={!selectedContractFile || !contractName || uploadContractMutation.isPending}
                                            className="w-full"
                                        >
                                            {uploadContractMutation.isPending ? (
                                                <>
                                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                                    Uploading...
                                                </>
                                            ) : (
                                                <>
                                                    <Plus className="mr-2 h-4 w-4" />
                                                    Add Contract
                                                </>
                                            )}
                                        </Button>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Right: Context Documents Section */}
                    <div>
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <Book className="h-5 w-5" />
                                    Legal Context
                                </CardTitle>
                                <CardDescription>
                                    Upload reference documents: governing laws, regulations, prior contracts, or other legal context
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                {/* Existing Context Docs */}
                                {project.contextDocuments.length > 0 && (
                                    <div className="mb-4 space-y-2">
                                        {project.contextDocuments.map((doc) => (
                                            <div
                                                key={doc.id}
                                                className="flex items-center justify-between border border-[var(--surface-stroke-soft)] bg-[var(--surface-elevated)] p-3"
                                            >
                                                <div className="flex items-center gap-3">
                                                    {getDocTypeIcon(doc.documentType)}
                                                    <div>
                                                        <p className="font-medium text-sm">{doc.title}</p>
                                                        <p className="text-xs text-muted-foreground">
                                                            {doc.documentType.replace("_", " ")}
                                                            {doc.wordCount && ` • ${doc.wordCount.toLocaleString()} words`}
                                                        </p>
                                                    </div>
                                                </div>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => setDocToDelete({ id: doc.id, type: "context" })}
                                                >
                                                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                                                </Button>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Upload New Context */}
                                <div className="border border-dashed border-[var(--surface-stroke)] bg-[var(--surface-base)] p-4">
                                    <div className="space-y-3">
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <Label htmlFor="context-title">Title</Label>
                                                <Input
                                                    id="context-title"
                                                    value={contextTitle}
                                                    onChange={(e) => setContextTitle(e.target.value)}
                                                    placeholder="e.g., GDPR Article 6"
                                                />
                                            </div>
                                            <div>
                                                <Label htmlFor="context-type">Type</Label>
                                                <Select value={contextType} onValueChange={setContextType}>
                                                    <SelectTrigger>
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="legal_text">Legal Text</SelectItem>
                                                        <SelectItem value="regulation">Regulation</SelectItem>
                                                        <SelectItem value="prior_contract">Prior Contract</SelectItem>
                                                        <SelectItem value="other">Other</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                        </div>
                                        <div
                                            className="cursor-pointer border border-[var(--surface-stroke-soft)] bg-[var(--surface-inset)] p-4 text-center transition-colors hover:border-[var(--surface-stroke)] hover:bg-[var(--surface-base)]"
                                            onClick={() => contextFileRef.current?.click()}
                                        >
                                            {selectedContextFile ? (
                                                <div>
                                                    <File className="h-8 w-8 mx-auto text-primary mb-2" />
                                                    <p className="text-sm font-medium">{selectedContextFile.name}</p>
                                                </div>
                                            ) : (
                                                <div>
                                                    <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                                                    <p className="text-sm">Click to select context file</p>
                                                </div>
                                            )}
                                            <input
                                                ref={contextFileRef}
                                                type="file"
                                                accept=".pdf,.txt,.doc,.docx"
                                                className="hidden"
                                                onChange={handleContextFileChange}
                                            />
                                        </div>
                                        <Button
                                            onClick={handleUploadContext}
                                            disabled={!selectedContextFile || !contextTitle || uploadContextMutation.isPending}
                                            className="w-full"
                                            variant="outline"
                                        >
                                            {uploadContextMutation.isPending ? (
                                                <>
                                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                                    Uploading...
                                                </>
                                            ) : (
                                                <>
                                                    <Plus className="mr-2 h-4 w-4" />
                                                    Add Context Document
                                                </>
                                            )}
                                        </Button>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        {/* Run Analysis CTA */}
                        {firstProjectContract && (
                            <Card className="mt-4 border-primary/30 bg-primary/5">
                                <CardContent className="py-4">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <p className="font-medium">Ready to analyze?</p>
                                            <p className="text-sm text-muted-foreground">
                                                Go to your contract to run analysis with context
                                            </p>
                                        </div>
                                        <Link href={`/contracts/${firstProjectContract.id}`}>
                                            <Button>
                                                <Play className="mr-2 h-4 w-4" />
                                                View Contract
                                            </Button>
                                        </Link>
                                    </div>
                                </CardContent>
                            </Card>
                        )}
                    </div>
                </div>
            </div>

            {/* Delete Confirmation Dialog */}
            <AlertDialog open={!!docToDelete} onOpenChange={() => setDocToDelete(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete document?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This will permanently delete this {docToDelete?.type} document.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground"
                            onClick={() => {
                                if (docToDelete?.type === "context") {
                                    deleteContextDocMutation.mutate(docToDelete.id);
                                }
                            }}
                        >
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
};

export default ProjectDetails;
