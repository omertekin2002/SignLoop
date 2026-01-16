'use client';

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useUser, useClerk } from "@clerk/nextjs";
import { apiClient } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { Plus, FileText, Calendar, ChevronRight, Trash2, FolderOpen, Book } from "lucide-react";
import { UploadDialog } from "@/components/upload-dialog";
import { NewProjectDialog } from "@/components/new-project-dialog";
import { format } from "date-fns";

interface Contract {
    id: string;
    title: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    projectId?: string;
}

interface Project {
    id: string;
    title: string;
    description?: string;
    status: string;
    createdAt: string;
    contracts?: Contract[];
    contextDocuments?: { id: string }[];
}

const Dashboard = () => {
    const { user } = useUser();
    const { signOut } = useClerk();
    const queryClient = useQueryClient();
    const [contractToDelete, setContractToDelete] = useState<Contract | null>(null);
    const [activeTab, setActiveTab] = useState("contracts");

    const { data: contracts, isLoading: loadingContracts } = useQuery({
        queryKey: ["contracts"],
        queryFn: async () => {
            const response = await apiClient.get<Contract[]>("/contracts");
            return response.data || [];
        },
    });

    const { data: projects, isLoading: loadingProjects } = useQuery({
        queryKey: ["projects"],
        queryFn: async () => {
            const response = await apiClient.get<{ data: Project[] }>("/projects");
            return response.data.data || [];
        },
    });

    const deleteContractMutation = useMutation({
        mutationFn: async (contractId: string) => {
            await apiClient.delete(`/contracts/${contractId}`);
        },
        onSuccess: () => {
            setContractToDelete(null);
            queryClient.invalidateQueries({ queryKey: ["contracts"] });
        },
        onError: (error: any) => {
            console.error(error);
            setContractToDelete(null);
        }
    });

    // Filter standalone contracts (not part of a project)
    const standaloneContracts = contracts?.filter(c => !c.projectId) || [];

    return (
        <div className="min-h-screen bg-background">
            <header className="bg-background/60 backdrop-blur border-b">
                <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 flex justify-between items-center">
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">
                        Dashboard
                    </h1>
                    <div className="flex items-center gap-4">
                        <span className="text-sm text-muted-foreground">
                            Welcome, {user?.firstName}
                        </span>
                        <Button variant="outline" onClick={() => signOut()}>
                            Sign out
                        </Button>
                    </div>
                </div>
            </header>
            <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                    <div className="flex justify-between items-center mb-6">
                        <TabsList>
                            <TabsTrigger value="contracts" className="gap-2">
                                <FileText className="h-4 w-4" />
                                Contracts
                            </TabsTrigger>
                            <TabsTrigger value="projects" className="gap-2">
                                <FolderOpen className="h-4 w-4" />
                                Projects
                            </TabsTrigger>
                        </TabsList>
                        <div className="flex gap-2">
                            {activeTab === "contracts" ? (
                                <UploadDialog>
                                    <Button>
                                        <Plus className="mr-2 h-4 w-4" />
                                        New Contract
                                    </Button>
                                </UploadDialog>
                            ) : (
                                <NewProjectDialog>
                                    <Button>
                                        <Plus className="mr-2 h-4 w-4" />
                                        New Project
                                    </Button>
                                </NewProjectDialog>
                            )}
                        </div>
                    </div>

                    {/* Contracts Tab */}
                    <TabsContent value="contracts">
                        {loadingContracts ? (
                            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                                {[1, 2, 3].map((i) => (
                                    <Skeleton key={i} className="h-40 w-full" />
                                ))}
                            </div>
                        ) : standaloneContracts.length === 0 ? (
                            <div className="text-center py-12 bg-card rounded-lg shadow border border-dashed border-border">
                                <FileText className="mx-auto h-12 w-12 text-muted-foreground" />
                                <h3 className="mt-2 text-sm font-semibold text-foreground">No contracts</h3>
                                <p className="mt-1 text-sm text-muted-foreground">
                                    Upload a contract for quick analysis, or create a project for context-aware analysis.
                                </p>
                                <div className="mt-6 flex justify-center gap-2">
                                    <UploadDialog>
                                        <Button>
                                            <Plus className="mr-2 h-4 w-4" />
                                            New Contract
                                        </Button>
                                    </UploadDialog>
                                    <NewProjectDialog>
                                        <Button variant="outline">
                                            <FolderOpen className="mr-2 h-4 w-4" />
                                            New Project
                                        </Button>
                                    </NewProjectDialog>
                                </div>
                            </div>
                        ) : (
                            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                                {standaloneContracts.map((contract) => (
                                    <Link key={contract.id} href={`/contracts/${contract.id}`}>
                                        <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
                                            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                                <CardTitle className="text-sm font-medium">
                                                    {contract.title}
                                                </CardTitle>
                                                <div className="flex items-center gap-2">
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-8 w-8"
                                                        title="Delete contract"
                                                        onClick={(e) => {
                                                            e.preventDefault();
                                                            e.stopPropagation();
                                                            setContractToDelete(contract);
                                                        }}
                                                    >
                                                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                                                    </Button>
                                                    <FileText className="h-4 w-4 text-muted-foreground" />
                                                </div>
                                            </CardHeader>
                                            <CardContent>
                                                <div className="flex justify-between items-end mt-4">
                                                    <div className="space-y-1">
                                                        <div className="flex items-center text-xs text-muted-foreground">
                                                            <Calendar className="mr-1 h-3 w-3" />
                                                            {format(new Date(contract.createdAt), "MMM d, yyyy")}
                                                        </div>
                                                        <Badge variant="secondary" className="mt-2">
                                                            {contract.status || "DRAFT"}
                                                        </Badge>
                                                    </div>
                                                    <ChevronRight className="h-5 w-5 text-muted-foreground" />
                                                </div>
                                            </CardContent>
                                        </Card>
                                    </Link>
                                ))}
                            </div>
                        )}
                    </TabsContent>

                    {/* Projects Tab */}
                    <TabsContent value="projects">
                        {loadingProjects ? (
                            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                                {[1, 2, 3].map((i) => (
                                    <Skeleton key={i} className="h-40 w-full" />
                                ))}
                            </div>
                        ) : !projects || projects.length === 0 ? (
                            <div className="text-center py-12 bg-card rounded-lg shadow border border-dashed border-border">
                                <FolderOpen className="mx-auto h-12 w-12 text-muted-foreground" />
                                <h3 className="mt-2 text-sm font-semibold text-foreground">No projects</h3>
                                <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
                                    Projects let you analyze contracts with legal context.
                                    Upload governing laws, prior contracts, or other reference documents.
                                </p>
                                <div className="mt-6">
                                    <NewProjectDialog>
                                        <Button>
                                            <Plus className="mr-2 h-4 w-4" />
                                            New Project
                                        </Button>
                                    </NewProjectDialog>
                                </div>
                            </div>
                        ) : (
                            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                                {projects.map((project) => (
                                    <Link key={project.id} href={`/projects/${project.id}`}>
                                        <Card className="hover:shadow-md transition-shadow cursor-pointer h-full border-l-4 border-l-primary">
                                            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                                <CardTitle className="text-sm font-medium">
                                                    {project.title}
                                                </CardTitle>
                                                <FolderOpen className="h-4 w-4 text-primary" />
                                            </CardHeader>
                                            <CardContent>
                                                {project.description && (
                                                    <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
                                                        {project.description}
                                                    </p>
                                                )}
                                                <div className="flex gap-2 mb-3">
                                                    <Badge variant="outline" className="text-xs">
                                                        <FileText className="mr-1 h-3 w-3" />
                                                        {project.contracts?.length || 0} contract{(project.contracts?.length || 0) !== 1 ? 's' : ''}
                                                    </Badge>
                                                    <Badge variant="outline" className="text-xs">
                                                        <Book className="mr-1 h-3 w-3" />
                                                        {project.contextDocuments?.length || 0} context
                                                    </Badge>
                                                </div>
                                                <div className="flex justify-between items-end">
                                                    <div className="flex items-center text-xs text-muted-foreground">
                                                        <Calendar className="mr-1 h-3 w-3" />
                                                        {format(new Date(project.createdAt), "MMM d, yyyy")}
                                                    </div>
                                                    <ChevronRight className="h-5 w-5 text-muted-foreground" />
                                                </div>
                                            </CardContent>
                                        </Card>
                                    </Link>
                                ))}
                            </div>
                        )}
                    </TabsContent>
                </Tabs>
            </main>

            <AlertDialog
                open={!!contractToDelete}
                onOpenChange={(open) => {
                    if (!open) setContractToDelete(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete contract?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This will permanently delete{" "}
                            <span className="font-medium">{contractToDelete?.title}</span> and all associated analyses.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={deleteContractMutation.isPending}>
                            Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            disabled={deleteContractMutation.isPending || !contractToDelete}
                            onClick={() => {
                                if (!contractToDelete) return;
                                deleteContractMutation.mutate(contractToDelete.id);
                            }}
                        >
                            {deleteContractMutation.isPending ? "Deleting..." : "Delete"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
};

export default Dashboard;
