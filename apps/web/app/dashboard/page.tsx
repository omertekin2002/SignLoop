'use client';

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useUser, useClerk } from "@clerk/nextjs";
import { format } from "date-fns";
import {
  Book,
  Calendar,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  FolderOpen,
  Loader2,
  LogOut,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { UploadDialog } from "@/components/upload-dialog";
import { NewProjectDialog } from "@/components/new-project-dialog";
import { ChatPanel } from "@/components/chat-panel";

type DashboardTab = "contracts" | "projects" | "chat";

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

interface ChatThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
  lastMessagePreview: string | null;
  messageCount: number;
}

type SidebarOpenState = Record<DashboardTab, boolean>;

const tabLabels: Record<DashboardTab, string> = {
  contracts: "Contracts",
  projects: "Projects",
  chat: "Chat",
};

const Dashboard = () => {
  const { user } = useUser();
  const { signOut } = useClerk();
  const queryClient = useQueryClient();
  const [contractToDelete, setContractToDelete] = useState<Contract | null>(null);
  const [activeTab, setActiveTab] = useState<DashboardTab>("contracts");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [openSections, setOpenSections] = useState<SidebarOpenState>({
    contracts: true,
    projects: false,
    chat: false,
  });
  const [selectedChatThreadId, setSelectedChatThreadId] = useState<string | null>(null);

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

  const { data: chatThreads, isLoading: loadingChatThreads } = useQuery({
    queryKey: ["chat-threads"],
    queryFn: async () => {
      const response = await fetch("/api/chat/threads");
      const payload = (await response.json().catch(() => null)) as
        | { data?: ChatThreadSummary[]; error?: string }
        | null;

      if (!response.ok) {
        throw new Error(payload?.error || "Failed to fetch chat threads.");
      }

      return payload?.data || [];
    },
  });

  useEffect(() => {
    if (!chatThreads?.length) return;
    if (selectedChatThreadId) return;
    setSelectedChatThreadId(chatThreads[0]!.id);
  }, [chatThreads, selectedChatThreadId]);

  const createChatMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/chat/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = (await response.json().catch(() => null)) as
        | { data?: ChatThreadSummary; error?: string }
        | null;

      if (!response.ok || !payload?.data) {
        throw new Error(payload?.error || "Failed to create chat thread.");
      }

      return payload.data;
    },
    onSuccess: (thread) => {
      setSelectedChatThreadId(thread.id);
      setActiveTab("chat");
      setOpenSections((previous) => ({ ...previous, chat: true }));
      queryClient.invalidateQueries({ queryKey: ["chat-threads"] });
    },
  });

  const deleteChatMutation = useMutation({
    mutationFn: async (threadId: string) => {
      const response = await fetch(`/api/chat/threads/${threadId}`, {
        method: "DELETE",
      });
      const payload = (await response.json().catch(() => null)) as
        | { success?: boolean; error?: string }
        | null;

      if (!response.ok) {
        throw new Error(payload?.error || "Failed to delete chat thread.");
      }
    },
    onSuccess: (_result, deletedThreadId) => {
      queryClient.invalidateQueries({ queryKey: ["chat-threads"] });
      queryClient.removeQueries({ queryKey: ["chat-thread", deletedThreadId] });
      setSelectedChatThreadId((current) => (current === deletedThreadId ? null : current));
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
    onError: (error: unknown) => {
      console.error(error);
      setContractToDelete(null);
    },
  });

  const standaloneContracts = contracts?.filter((contract) => !contract.projectId) || [];

  const setSectionOpen = (section: DashboardTab, open: boolean) => {
    setOpenSections((previous) => ({
      ...previous,
      [section]: open,
    }));
  };

  return (
    <div className="app-page">
      <div className="flex min-h-screen">
        <aside
          className={cn(
            "m-4 mr-0 flex shrink-0 flex-col overflow-hidden rounded-[var(--radius)] border-2 border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-[var(--card-shadow)] transition-[width] duration-200",
            sidebarOpen ? "w-80" : "w-20",
          )}
        >
          <div className="border-b-2 border-[hsl(var(--border))] p-2.5">
            <div className={cn("flex items-center", sidebarOpen ? "justify-between gap-2" : "justify-center")}>
              {sidebarOpen ? (
                <>
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 rounded-[var(--radius)] border-2 border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-1.5"
                    onClick={() => setActiveTab("contracts")}
                  >
                    <span className="text-xs font-semibold uppercase tracking-[0.12em]">SignLoop</span>
                  </button>

                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => setSidebarOpen(false)}
                    aria-label="Collapse sidebar"
                  >
                    <PanelLeftClose className="h-4 w-4" />
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  onClick={() => setSidebarOpen(true)}
                  aria-label="Expand sidebar"
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            <div className="space-y-2">
              <Collapsible open={openSections.contracts} onOpenChange={(open) => setSectionOpen("contracts", open)}>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setActiveTab("contracts")}
                    className={cn(
                      "flex w-full items-center rounded-[var(--radius)] border-2 border-[hsl(var(--border))] px-2 py-2 text-left text-sm font-semibold transition-colors",
                      activeTab === "contracts" ? "bg-[hsl(var(--accent)/0.22)]" : "bg-[hsl(var(--background))]",
                      !sidebarOpen && "justify-center",
                    )}
                  >
                    <span className={cn("flex items-center gap-2", !sidebarOpen && "justify-center")}>
                      <FileText className="h-4 w-4" />
                      {sidebarOpen ? <span>Contracts</span> : null}
                    </span>
                    {sidebarOpen ? (
                      openSections.contracts ? (
                        <ChevronUp className="ml-auto h-4 w-4" />
                      ) : (
                        <ChevronDown className="ml-auto h-4 w-4" />
                      )
                    ) : null}
                  </button>
                </CollapsibleTrigger>
                {sidebarOpen ? (
                  <CollapsibleContent className="mt-1 space-y-1 pl-2">
                    {loadingContracts ? (
                      <p className="px-2 py-1 text-xs text-muted-foreground">Loading contracts...</p>
                    ) : standaloneContracts.length === 0 ? (
                      <p className="px-2 py-1 text-xs text-muted-foreground">No standalone contracts</p>
                    ) : (
                      standaloneContracts.map((contract) => (
                        <Link
                          key={contract.id}
                          href={`/contracts/${contract.id}`}
                          className="block rounded-[calc(var(--radius)-0.05rem)] border border-[hsl(var(--border)/0.35)] bg-[hsl(var(--background)/0.75)] px-2 py-1.5 text-xs hover:border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))]"
                        >
                          <p className="truncate font-medium text-foreground">{contract.title}</p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">{contract.status || "DRAFT"}</p>
                        </Link>
                      ))
                    )}
                  </CollapsibleContent>
                ) : null}
              </Collapsible>

              <Collapsible open={openSections.projects} onOpenChange={(open) => setSectionOpen("projects", open)}>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setActiveTab("projects")}
                    className={cn(
                      "flex w-full items-center rounded-[var(--radius)] border-2 border-[hsl(var(--border))] px-2 py-2 text-left text-sm font-semibold transition-colors",
                      activeTab === "projects" ? "bg-[hsl(var(--accent)/0.22)]" : "bg-[hsl(var(--background))]",
                      !sidebarOpen && "justify-center",
                    )}
                  >
                    <span className={cn("flex items-center gap-2", !sidebarOpen && "justify-center")}>
                      <FolderOpen className="h-4 w-4" />
                      {sidebarOpen ? <span>Projects</span> : null}
                    </span>
                    {sidebarOpen ? (
                      openSections.projects ? (
                        <ChevronUp className="ml-auto h-4 w-4" />
                      ) : (
                        <ChevronDown className="ml-auto h-4 w-4" />
                      )
                    ) : null}
                  </button>
                </CollapsibleTrigger>
                {sidebarOpen ? (
                  <CollapsibleContent className="mt-1 space-y-1 pl-2">
                    {loadingProjects ? (
                      <p className="px-2 py-1 text-xs text-muted-foreground">Loading projects...</p>
                    ) : !projects || projects.length === 0 ? (
                      <p className="px-2 py-1 text-xs text-muted-foreground">No projects yet</p>
                    ) : (
                      projects.map((project) => (
                        <Link
                          key={project.id}
                          href={`/projects/${project.id}`}
                          className="block rounded-[calc(var(--radius)-0.05rem)] border border-[hsl(var(--border)/0.35)] bg-[hsl(var(--background)/0.75)] px-2 py-1.5 text-xs hover:border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))]"
                        >
                          <p className="truncate font-medium text-foreground">{project.title}</p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {project.contracts?.length || 0} contract{(project.contracts?.length || 0) === 1 ? "" : "s"}
                          </p>
                        </Link>
                      ))
                    )}
                  </CollapsibleContent>
                ) : null}
              </Collapsible>

              <Collapsible open={openSections.chat} onOpenChange={(open) => setSectionOpen("chat", open)}>
                <div className={cn("flex items-center gap-1.5", !sidebarOpen && "justify-center")}>
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setActiveTab("chat")}
                      className={cn(
                        "flex items-center rounded-[var(--radius)] border-2 border-[hsl(var(--border))] px-2 py-2 text-left text-sm font-semibold transition-colors",
                        activeTab === "chat" ? "bg-[hsl(var(--accent)/0.22)]" : "bg-[hsl(var(--background))]",
                        sidebarOpen ? "flex-1" : "w-full justify-center",
                      )}
                    >
                      <span className={cn("flex items-center gap-2", !sidebarOpen && "justify-center")}>
                        <MessagesSquare className="h-4 w-4" />
                        {sidebarOpen ? <span>Chat</span> : null}
                      </span>
                      {sidebarOpen ? (
                        openSections.chat ? (
                          <ChevronUp className="ml-auto h-4 w-4" />
                        ) : (
                          <ChevronDown className="ml-auto h-4 w-4" />
                        )
                      ) : null}
                    </button>
                  </CollapsibleTrigger>
                  {sidebarOpen ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      onClick={() => createChatMutation.mutate()}
                      disabled={createChatMutation.isPending}
                      title="New chat"
                      aria-label="New chat"
                    >
                      {createChatMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Plus className="h-4 w-4" />
                      )}
                    </Button>
                  ) : null}
                </div>
                {sidebarOpen ? (
                  <CollapsibleContent className="mt-1 space-y-1 pl-2">
                    {loadingChatThreads ? (
                      <p className="px-2 py-1 text-xs text-muted-foreground">Loading chats...</p>
                    ) : !chatThreads || chatThreads.length === 0 ? (
                      <p className="px-2 py-1 text-xs text-muted-foreground">No chats yet</p>
                    ) : (
                      chatThreads.map((thread) => (
                        <div
                          key={thread.id}
                          className={cn(
                            "flex items-start gap-1 rounded-[calc(var(--radius)-0.05rem)] border px-1.5 py-1.5 text-xs",
                            selectedChatThreadId === thread.id
                              ? "border-[hsl(var(--accent)/0.65)] bg-[hsl(var(--accent)/0.2)]"
                              : "border-[hsl(var(--border)/0.35)] bg-[hsl(var(--background)/0.75)] hover:border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))]",
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setActiveTab("chat");
                              setSelectedChatThreadId(thread.id);
                            }}
                            className="min-w-0 flex-1 text-left"
                          >
                            <p className="truncate font-medium text-foreground">{thread.title}</p>
                            <p className="mt-0.5 text-[11px] text-muted-foreground">
                              {thread.messageCount} message{thread.messageCount === 1 ? "" : "s"}
                            </p>
                          </button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0"
                            onClick={() => deleteChatMutation.mutate(thread.id)}
                            disabled={deleteChatMutation.isPending}
                            title="Delete chat"
                            aria-label="Delete chat"
                          >
                            {deleteChatMutation.isPending && deleteChatMutation.variables === thread.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      ))
                    )}
                  </CollapsibleContent>
                ) : null}
              </Collapsible>
            </div>
          </div>

          <div className="border-t-2 border-[hsl(var(--border))] p-2">
            <div className="space-y-2">
              <Button asChild variant="outline" className={cn("w-full", sidebarOpen ? "justify-start" : "justify-center px-0")}>
                <Link href="/settings">
                  <Settings className="h-4 w-4" />
                  {sidebarOpen ? <span>Settings</span> : null}
                </Link>
              </Button>
              <Button
                type="button"
                variant="outline"
                className={cn("w-full", sidebarOpen ? "justify-start" : "justify-center px-0")}
                onClick={() => signOut()}
              >
                <LogOut className="h-4 w-4" />
                {sidebarOpen ? <span>Sign out</span> : null}
              </Button>
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex flex-1 flex-col p-4 sm:p-6">
          <div className="chrome-pane mb-6 shrink-0 flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div>
              <h1 className="app-title text-2xl md:text-3xl">{tabLabels[activeTab]}</h1>
              <p className="text-xs text-muted-foreground">Welcome, {user?.firstName || "there"}</p>
            </div>
            <div className="flex gap-2">
              {activeTab === "contracts" ? (
                <UploadDialog>
                  <Button>
                    <Plus className="mr-2 h-4 w-4" />
                    New Contract
                  </Button>
                </UploadDialog>
              ) : activeTab === "projects" ? (
                <NewProjectDialog>
                  <Button>
                    <Plus className="mr-2 h-4 w-4" />
                    New Project
                  </Button>
                </NewProjectDialog>
              ) : null}
            </div>
          </div>

          {activeTab === "contracts" ? (
            loadingContracts ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {[1, 2, 3].map((item) => (
                  <Skeleton key={item} className="h-40 w-full" />
                ))}
              </div>
            ) : standaloneContracts.length === 0 ? (
              <div className="chrome-pane py-12 text-center">
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
                    <Card className="h-full cursor-pointer">
                      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">{contract.title}</CardTitle>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            title="Delete contract"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setContractToDelete(contract);
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                          <FileText className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </CardHeader>
                      <CardContent>
                        <div className="mt-4 flex items-end justify-between">
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
            )
          ) : null}

          {activeTab === "projects" ? (
            loadingProjects ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {[1, 2, 3].map((item) => (
                  <Skeleton key={item} className="h-40 w-full" />
                ))}
              </div>
            ) : !projects || projects.length === 0 ? (
              <div className="chrome-pane py-12 text-center">
                <FolderOpen className="mx-auto h-12 w-12 text-muted-foreground" />
                <h3 className="mt-2 text-sm font-semibold text-foreground">No projects</h3>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                  Projects let you analyze contracts with legal context. Upload governing laws, prior contracts, or
                  other reference documents.
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
                    <Card className="h-full cursor-pointer border-l-2 border-l-[hsl(var(--accent)/0.8)]">
                      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">{project.title}</CardTitle>
                        <FolderOpen className="h-4 w-4 text-primary" />
                      </CardHeader>
                      <CardContent>
                        {project.description ? (
                          <p className="mb-3 line-clamp-2 text-xs text-muted-foreground">{project.description}</p>
                        ) : null}
                        <div className="mb-3 flex gap-2">
                          <Badge variant="outline" className="text-xs">
                            <FileText className="mr-1 h-3 w-3" />
                            {project.contracts?.length || 0} contract
                            {(project.contracts?.length || 0) !== 1 ? "s" : ""}
                          </Badge>
                          <Badge variant="outline" className="text-xs">
                            <Book className="mr-1 h-3 w-3" />
                            {project.contextDocuments?.length || 0} context
                          </Badge>
                        </div>
                        <div className="flex items-end justify-between">
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
            )
          ) : null}

          {activeTab === "chat" ? (
            <div className="min-h-0 flex-1">
              <ChatPanel
                selectedThreadId={selectedChatThreadId}
                onThreadSelected={(threadId) => setSelectedChatThreadId(threadId)}
              />
            </div>
          ) : null}
        </main>
      </div>

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
              This will permanently delete <span className="font-medium">{contractToDelete?.title}</span> and all
              associated analyses.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteContractMutation.isPending}>Cancel</AlertDialogCancel>
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
