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
    <div className="flex h-screen w-full bg-background overflow-hidden text-foreground">
      <aside
        className={cn(
          "flex h-screen shrink-0 flex-col border-r bg-muted/20 transition-[width] duration-200",
          sidebarOpen ? "w-72" : "w-[60px]"
        )}
      >
        <div className="flex h-14 items-center border-b px-3">
          <div className={cn("flex w-full items-center", sidebarOpen ? "justify-between gap-2" : "justify-center")}>
            {sidebarOpen ? (
              <>
                <div
                  className="flex items-center gap-2 font-semibold tracking-tight cursor-pointer px-1 text-primary"
                  onClick={() => setActiveTab("contracts")}
                >
                  <span className="text-sm font-bold tracking-wide">SignLoop</span>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  onClick={() => setSidebarOpen(false)}
                  aria-label="Collapse sidebar"
                >
                  <PanelLeftClose className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={() => setSidebarOpen(true)}
                aria-label="Expand sidebar"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto w-full">
          <div className="space-y-4 p-2 sm:p-3">
            <Collapsible open={openSections.contracts} onOpenChange={(open) => setSectionOpen("contracts", open)}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  onClick={() => setActiveTab("contracts")}
                  aria-label="Contracts"
                  className={cn(
                    "flex w-full items-center rounded-md px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-muted hover:text-foreground",
                    activeTab === "contracts" ? "bg-muted text-primary" : "text-muted-foreground",
                    !sidebarOpen && "justify-center px-0"
                  )}
                >
                  <span className={cn("flex items-center gap-3", !sidebarOpen && "justify-center")}>
                    <FileText className="h-4 w-4" />
                    {sidebarOpen ? <span>Contracts</span> : null}
                  </span>
                  {sidebarOpen ? (
                    openSections.contracts ? (
                      <ChevronUp className="ml-auto h-4 w-4 opacity-50" />
                    ) : (
                      <ChevronDown className="ml-auto h-4 w-4 opacity-50" />
                    )
                  ) : null}
                </button>
              </CollapsibleTrigger>
              {sidebarOpen ? (
                <CollapsibleContent className="mt-1 space-y-1 pl-[1.65rem] border-l ml-3.5 mb-2">
                  {loadingContracts ? (
                    <p className="px-3 py-1.5 text-xs text-muted-foreground">Loading contracts...</p>
                  ) : standaloneContracts.length === 0 ? (
                    <p className="px-3 py-1.5 text-xs text-muted-foreground">No standalone contracts</p>
                  ) : (
                    standaloneContracts.map((contract) => (
                      <Link
                        key={contract.id}
                        href={`/contracts/${contract.id}`}
                        className="block rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                      >
                        <p className="truncate font-medium">{contract.title}</p>
                        <p className="mt-0.5 text-[10px] opacity-70">{contract.status || "DRAFT"}</p>
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
                  aria-label="Projects"
                  className={cn(
                    "flex w-full items-center rounded-md px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-muted hover:text-foreground",
                    activeTab === "projects" ? "bg-muted text-primary" : "text-muted-foreground",
                    !sidebarOpen && "justify-center px-0"
                  )}
                >
                  <span className={cn("flex items-center gap-3", !sidebarOpen && "justify-center")}>
                    <FolderOpen className="h-4 w-4" />
                    {sidebarOpen ? <span>Projects</span> : null}
                  </span>
                  {sidebarOpen ? (
                    openSections.projects ? (
                      <ChevronUp className="ml-auto h-4 w-4 opacity-50" />
                    ) : (
                      <ChevronDown className="ml-auto h-4 w-4 opacity-50" />
                    )
                  ) : null}
                </button>
              </CollapsibleTrigger>
              {sidebarOpen ? (
                <CollapsibleContent className="mt-1 space-y-1 pl-[1.65rem] border-l ml-3.5 mb-2">
                  {loadingProjects ? (
                    <p className="px-3 py-1.5 text-xs text-muted-foreground">Loading projects...</p>
                  ) : !projects || projects.length === 0 ? (
                    <p className="px-3 py-1.5 text-xs text-muted-foreground">No projects yet</p>
                  ) : (
                    projects.map((project) => (
                      <Link
                        key={project.id}
                        href={`/projects/${project.id}`}
                        className="block rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                      >
                        <p className="truncate font-medium">{project.title}</p>
                        <p className="mt-0.5 text-[10px] opacity-70">
                          {project.contracts?.length || 0} contract{(project.contracts?.length || 0) === 1 ? "" : "s"}
                        </p>
                      </Link>
                    ))
                  )}
                </CollapsibleContent>
              ) : null}
            </Collapsible>

            <Collapsible open={openSections.chat} onOpenChange={(open) => setSectionOpen("chat", open)}>
              <div className={cn("flex items-center gap-1", !sidebarOpen && "justify-center")}>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setActiveTab("chat")}
                    aria-label="Chat"
                    className={cn(
                      "flex items-center rounded-md px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-muted hover:text-foreground",
                      activeTab === "chat" ? "bg-muted text-primary" : "text-muted-foreground",
                      sidebarOpen ? "flex-1" : "w-full justify-center px-0"
                    )}
                  >
                    <span className={cn("flex items-center gap-3", !sidebarOpen && "justify-center")}>
                      <MessagesSquare className="h-4 w-4" />
                      {sidebarOpen ? <span>Chat</span> : null}
                    </span>
                    {sidebarOpen ? (
                      openSections.chat ? (
                        <ChevronUp className="ml-auto h-4 w-4 opacity-50" />
                      ) : (
                        <ChevronDown className="ml-auto h-4 w-4 opacity-50" />
                      )
                    ) : null}
                  </button>
                </CollapsibleTrigger>
                {sidebarOpen ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
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
                <CollapsibleContent className="mt-1 space-y-1 pl-[1.65rem] border-l ml-3.5 mb-2">
                  {loadingChatThreads ? (
                    <p className="px-3 py-1.5 text-xs text-muted-foreground">Loading chats...</p>
                  ) : !chatThreads || chatThreads.length === 0 ? (
                    <p className="px-3 py-1.5 text-xs text-muted-foreground">No chats yet</p>
                  ) : (
                    chatThreads.map((thread) => (
                      <div
                        key={thread.id}
                        className={cn(
                          "group flex items-start justify-between rounded-md px-3 py-2 text-xs transition-colors",
                          selectedChatThreadId === thread.id
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
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
                          <p className="truncate font-medium">{thread.title}</p>
                          <p className="mt-0.5 text-[10px] opacity-70">
                            {thread.messageCount} msg{thread.messageCount !== 1 ? "s" : ""}
                          </p>
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className={cn(
                            "h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity",
                            selectedChatThreadId === thread.id && "opacity-100"
                          )}
                          onClick={() => deleteChatMutation.mutate(thread.id)}
                          disabled={deleteChatMutation.isPending}
                          title="Delete chat"
                          aria-label="Delete chat"
                        >
                          {deleteChatMutation.isPending && deleteChatMutation.variables === thread.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
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

        <div className="border-t p-3">
          <div className="space-y-1">
            <Button asChild variant="ghost" className={cn("w-full text-muted-foreground hover:text-foreground", sidebarOpen ? "justify-start" : "justify-center px-0")}>
              <Link href="/settings" aria-label="Settings">
                <Settings className={cn("h-4 w-4", sidebarOpen && "mr-3")} />
                {sidebarOpen ? <span>Settings</span> : null}
              </Link>
            </Button>
            <Button
              type="button"
              variant="ghost"
              aria-label="Sign out"
              className={cn("w-full text-muted-foreground hover:text-destructive", sidebarOpen ? "justify-start" : "justify-center px-0")}
              onClick={() => signOut()}
            >
              <LogOut className={cn("h-4 w-4", sidebarOpen && "mr-3")} />
              {sidebarOpen ? <span>Sign out</span> : null}
            </Button>
          </div>
        </div>
      </aside>

      <main
        className={cn(
          "min-w-0 flex-1 flex flex-col relative",
          activeTab === "chat" ? "overflow-hidden" : "overflow-y-auto"
        )}
      >
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_60%_60%_at_50%_-20%,rgba(120,119,198,0.1),rgba(255,255,255,0))] dark:bg-[radial-gradient(ellipse_60%_60%_at_50%_-20%,rgba(120,119,198,0.2),rgba(255,255,255,0))]" />
        
        <div className={cn("relative z-10 flex flex-1 flex-col p-6 lg:p-10", activeTab === "chat" && "p-0 lg:p-0")}>
          {activeTab !== "chat" && (
            <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-border/40 pb-6">
              <div>
                <h1 className="text-3xl font-bold tracking-tight">{tabLabels[activeTab]}</h1>
                <p className="mt-1 text-sm text-muted-foreground">Welcome back, {user?.firstName || "there"}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
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
          )}

          {activeTab === "contracts" ? (
            loadingContracts ? (
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {[1, 2, 3].map((item) => (
                  <Skeleton key={item} className="h-44 w-full rounded-xl" />
                ))}
              </div>
            ) : standaloneContracts.length === 0 ? (
              <div className="flex min-h-[400px] flex-col items-center justify-center rounded-xl border border-dashed text-center bg-muted/10 mx-auto w-full max-w-2xl px-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
                  <FileText className="h-8 w-8 text-muted-foreground" />
                </div>
                <h3 className="text-xl font-semibold text-foreground">No contracts found</h3>
                <p className="mt-2 text-sm text-muted-foreground max-w-sm">
                  Upload a contract to begin analyzing it instantly, or create a project for context-aware reviews.
                </p>
                <div className="mt-8 flex flex-wrap justify-center gap-3">
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
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {standaloneContracts.map((contract) => (
                  <Card
                    key={contract.id}
                    className="group relative h-full overflow-hidden border-border/50 bg-background/50 backdrop-blur transition-colors hover:bg-muted/50 hover:border-border"
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute right-4 top-4 z-10 h-8 w-8 text-muted-foreground opacity-100 transition-opacity hover:bg-destructive/10 hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                      title="Delete contract"
                      aria-label={`Delete ${contract.title}`}
                      onClick={() => setContractToDelete(contract)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    <Link href={`/contracts/${contract.id}`} className="block h-full">
                      <CardHeader className="space-y-0 pb-4 pr-12">
                        <CardTitle className="text-base font-semibold leading-tight line-clamp-2">{contract.title}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="mb-4 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Calendar className="h-3.5 w-3.5" />
                          {format(new Date(contract.createdAt), "MMMM d, yyyy")}
                        </div>
                        <div className="flex items-end justify-between">
                          <Badge variant="secondary" className="font-medium bg-secondary/50">
                            {contract.status || "DRAFT"}
                          </Badge>
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                            <ChevronRight className="h-4 w-4" />
                          </div>
                        </div>
                      </CardContent>
                    </Link>
                  </Card>
                ))}
              </div>
            )
          ) : null}

          {activeTab === "projects" ? (
            loadingProjects ? (
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {[1, 2, 3].map((item) => (
                  <Skeleton key={item} className="h-44 w-full rounded-xl" />
                ))}
              </div>
            ) : !projects || projects.length === 0 ? (
              <div className="flex min-h-[400px] flex-col items-center justify-center rounded-xl border border-dashed text-center bg-muted/10 mx-auto w-full max-w-2xl px-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
                  <FolderOpen className="h-8 w-8 text-muted-foreground" />
                </div>
                <h3 className="text-xl font-semibold text-foreground">No projects yet</h3>
                <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
                  Projects let you analyze contracts with legal context. Upload governing laws or reference documents.
                </p>
                <div className="mt-8">
                  <NewProjectDialog>
                    <Button>
                      <Plus className="mr-2 h-4 w-4" />
                      Create your first project
                    </Button>
                  </NewProjectDialog>
                </div>
              </div>
            ) : (
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {projects.map((project) => (
                  <Link key={project.id} href={`/projects/${project.id}`}>
                    <Card className="group h-full cursor-pointer overflow-hidden border-t-2 border-t-primary border-x-border/50 border-b-border/50 bg-background/50 backdrop-blur transition-all hover:bg-muted/50 hover:shadow-sm">
                      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                        <CardTitle className="text-base font-semibold leading-tight line-clamp-2">{project.title}</CardTitle>
                        <FolderOpen className="h-4 w-4 text-primary shrink-0 ml-2" />
                      </CardHeader>
                      <CardContent>
                        {project.description ? (
                          <p className="mb-4 line-clamp-2 text-sm text-muted-foreground leading-relaxed">{project.description}</p>
                        ) : null}
                        <div className="mb-4 flex flex-wrap gap-2">
                          <Badge variant="outline" className="text-xs font-medium border-border/60 bg-background">
                            <FileText className="mr-1.5 h-3 w-3 text-muted-foreground" />
                            {project.contracts?.length || 0} contract
                            {(project.contracts?.length || 0) !== 1 ? "s" : ""}
                          </Badge>
                          <Badge variant="outline" className="text-xs font-medium border-border/60 bg-background">
                            <Book className="mr-1.5 h-3 w-3 text-muted-foreground" />
                            {project.contextDocuments?.length || 0} context
                          </Badge>
                        </div>
                        <div className="flex items-end justify-between pt-1">
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Calendar className="h-3.5 w-3.5" />
                            {format(new Date(project.createdAt), "MMM d, yyyy")}
                          </div>
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                            <ChevronRight className="h-4 w-4" />
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            )
          ) : null}

          {activeTab === "chat" ? (
            <div className="min-h-0 flex-1 overflow-hidden h-full flex flex-col bg-background/50">
              <ChatPanel
                selectedThreadId={selectedChatThreadId}
                onThreadSelected={(threadId) => setSelectedChatThreadId(threadId)}
              />
            </div>
          ) : null}
        </div>
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
              This will permanently delete <span className="font-medium text-foreground">{contractToDelete?.title}</span> and all
              associated analyses. This action cannot be undone.
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
              {deleteContractMutation.isPending ? "Deleting..." : "Delete Contract"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Dashboard;
