"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useUser, useClerk } from "@clerk/nextjs";
import {
  Book,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  FileText,
  FolderOpen,
  Loader2,
  LogIn,
  LogOut,
  MessagesSquare,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { apiClient, getApiErrorMessage } from "@/lib/api-client";
import { cn, formatDate } from "@/lib/utils";
import { getSettingsErrorMessage, type SettingsResponse } from "@/lib/settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  contractCount: number;
  contextDocumentCount: number;
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

type ModelSelectorProps = {
  activeModel: string;
  availableModels: string[];
  disabled: boolean;
  onSelect: (model: string) => void;
  showBrand?: boolean;
};

function SignLoopWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-semibold tracking-tight text-foreground/90",
        className,
      )}
    >
      SignLoop
    </span>
  );
}

function ModelSelector({
  activeModel,
  availableModels,
  disabled,
  onSelect,
  showBrand = false,
}: ModelSelectorProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "group flex items-center gap-1.5 rounded-xl px-3 py-2 text-lg font-semibold transition-colors hover:bg-muted/50",
            !showBrand && "text-base",
            disabled && "cursor-default opacity-80 hover:bg-transparent",
          )}
        >
          {showBrand ? <SignLoopWordmark /> : null}
          <span className="max-w-[180px] truncate font-medium text-muted-foreground">
            {activeModel}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="mt-1 w-64 border border-border/50 bg-background/95 backdrop-blur-sm"
      >
        {availableModels.length > 0 ? (
          availableModels.map((model: string) => (
            <DropdownMenuItem
              key={model}
              onClick={() => onSelect(model)}
              disabled={disabled}
              className="flex items-center justify-between px-3 py-2 focus:bg-muted/80"
            >
              <span className="truncate pr-4">{model}</span>
              {activeModel === model ? (
                <Check className="h-4 w-4 shrink-0 text-primary" />
              ) : null}
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled className="px-3 py-2">
            <span className="text-muted-foreground">OpenRouter</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type DashboardProps = {
  landingHero?: boolean;
  startTemporary?: boolean;
  initialTemporaryPrompt?: string;
};

const Dashboard = ({
  landingHero = false,
  startTemporary = false,
  initialTemporaryPrompt,
}: DashboardProps) => {
  const { user, isSignedIn } = useUser();
  const { signOut } = useClerk();
  const queryClient = useQueryClient();
  const canUseSavedWorkspace = isSignedIn === true;
  const [contractToDelete, setContractToDelete] = useState<Contract | null>(
    null,
  );
  const [chatThreadToDelete, setChatThreadToDelete] =
    useState<ChatThreadSummary | null>(null);
  const [activeTab, setActiveTab] = useState<DashboardTab>("chat");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [openSections, setOpenSections] = useState<SidebarOpenState>({
    contracts: false,
    projects: false,
    chat: true,
  });
  const [selectedChatThreadId, setSelectedChatThreadId] = useState<
    string | null
  >(null);
  const [recentlyCreatedChatThreadId, setRecentlyCreatedChatThreadId] =
    useState<string | null>(null);
  const [recentlyDeletedChatThreadId, setRecentlyDeletedChatThreadId] =
    useState<string | null>(null);
  const [isTemporaryChatSelected, setIsTemporaryChatSelected] =
    useState(startTemporary);
  const [temporaryChatKey, setTemporaryChatKey] = useState(0);

  const {
    data: contracts,
    isLoading: loadingContracts,
    isLoadingError: contractsFailed,
    refetch: refetchContracts,
  } = useQuery({
    queryKey: ["contracts"],
    queryFn: async () => {
      const response = await apiClient.get<{ data: Contract[] }>(
        "/contracts?limit=200",
      );
      return response.data.data || [];
    },
    enabled: canUseSavedWorkspace,
  });

  const {
    data: projects,
    isLoading: loadingProjects,
    isLoadingError: projectsFailed,
    refetch: refetchProjects,
  } = useQuery({
    queryKey: ["projects"],
    queryFn: async () => {
      const response = await apiClient.get<{ data: Project[] }>(
        "/projects?limit=200",
      );
      return response.data.data || [];
    },
    enabled: canUseSavedWorkspace,
  });

  const {
    data: chatThreads,
    isLoading: loadingChatThreads,
    isLoadingError: chatThreadsFailed,
    refetch: refetchChatThreads,
  } = useQuery({
    queryKey: ["chat-threads"],
    queryFn: async () => {
      const response = await apiClient.get<{ data?: ChatThreadSummary[] }>(
        "/chat/threads?limit=200",
      );
      return response.data.data || [];
    },
    enabled: canUseSavedWorkspace,
  });

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const response = await apiClient.get<SettingsResponse>("/settings");
      return response.data;
    },
    enabled: canUseSavedWorkspace,
  });

  const availableModels = settingsData?.availablePrimaryModels || [];
  const activeModel = canUseSavedWorkspace
    ? settingsData?.primaryModel || availableModels[0] || "OpenRouter"
    : "Temporary chat";

  const selectSavedChatThread = (threadId: string) => {
    setIsTemporaryChatSelected(false);
    setSelectedChatThreadId(threadId);
  };

  const selectNewChatThread = (threadId: string) => {
    setIsTemporaryChatSelected(false);
    setRecentlyCreatedChatThreadId(threadId);
    setSelectedChatThreadId(threadId);
  };

  const selectTemporaryChat = () => {
    setActiveTab("chat");
    setOpenSections((previous) => ({ ...previous, chat: true }));
    setRecentlyCreatedChatThreadId(null);
    setRecentlyDeletedChatThreadId(null);
    setSelectedChatThreadId(null);
    setIsTemporaryChatSelected(true);
    setTemporaryChatKey((key) => key + 1);
  };

  const addChatThreadToCache = (thread: ChatThreadSummary) => {
    queryClient.setQueryData<ChatThreadSummary[]>(
      ["chat-threads"],
      (current) => {
        const existingThreads = current || [];
        return [
          thread,
          ...existingThreads.filter(
            (existingThread) => existingThread.id !== thread.id,
          ),
        ];
      },
    );
  };

  const renderLoginRequired = (resource: "contracts" | "projects") => {
    const isContracts = resource === "contracts";

    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center rounded-xl border border-dashed bg-muted/10 px-4 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          {isContracts ? (
            <FileText className="h-8 w-8 text-muted-foreground" />
          ) : (
            <FolderOpen className="h-8 w-8 text-muted-foreground" />
          )}
        </div>
        <h3 className="text-xl font-semibold text-foreground">
          Log in to use {isContracts ? "contracts" : "projects"}
        </h3>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          Temporary chat works without an account. Saved{" "}
          {isContracts ? "contract analysis" : "project workspaces"} require
          login.
        </p>
        <Button asChild className="mt-8">
          <Link href="/sign-in">
            <LogIn className="mr-2 h-4 w-4" />
            Log in
          </Link>
        </Button>
      </div>
    );
  };

  const renderLoadError = (
    resource: "contracts" | "projects",
    retry: () => void,
  ) => (
    <div
      className="mx-auto flex min-h-[400px] w-full max-w-2xl flex-col items-center justify-center rounded-xl border border-destructive/30 bg-destructive/5 px-4 text-center"
      role="alert"
    >
      <h3 className="text-xl font-semibold text-foreground">
        Couldn&apos;t load {resource}
      </h3>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        Check your connection and try again. Your saved data has not been
        changed.
      </p>
      <Button type="button" variant="outline" className="mt-6" onClick={retry}>
        Try again
      </Button>
    </div>
  );

  const updateModelMutation = useMutation({
    mutationFn: async (primaryModel: string) => {
      const response = await apiClient.put("/settings", { primaryModel });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (error: unknown) => {
      toast.error(getSettingsErrorMessage(error));
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  useEffect(() => {
    if (isTemporaryChatSelected) {
      return;
    }

    const candidateThreads =
      chatThreads?.filter(
        (thread) => thread.id !== recentlyDeletedChatThreadId,
      ) || [];
    const hasSelectedCandidate = selectedChatThreadId
      ? candidateThreads.some((thread) => thread.id === selectedChatThreadId)
      : false;

    if (hasSelectedCandidate) {
      if (selectedChatThreadId === recentlyCreatedChatThreadId) {
        setRecentlyCreatedChatThreadId(null);
      }
      return;
    }

    if (
      selectedChatThreadId &&
      selectedChatThreadId === recentlyCreatedChatThreadId
    ) {
      return;
    }

    const fallbackThreadId = candidateThreads[0]?.id ?? null;
    if (selectedChatThreadId !== fallbackThreadId) {
      setSelectedChatThreadId(fallbackThreadId);
    }
  }, [
    chatThreads,
    isTemporaryChatSelected,
    recentlyCreatedChatThreadId,
    recentlyDeletedChatThreadId,
    selectedChatThreadId,
  ]);

  const createChatMutation = useMutation({
    mutationFn: async () => {
      const response = await apiClient.post<{ data?: ChatThreadSummary }>(
        "/chat/threads",
        {},
      );
      const thread = response.data.data;
      if (!thread) {
        throw new Error("Failed to create chat thread.");
      }
      return thread;
    },
    onSuccess: (thread) => {
      setRecentlyDeletedChatThreadId(null);
      addChatThreadToCache(thread);
      selectNewChatThread(thread.id);
      setActiveTab("chat");
      setOpenSections((previous) => ({ ...previous, chat: true }));
      queryClient.invalidateQueries({ queryKey: ["chat-threads"] });
    },
    onError: (error: unknown) => {
      toast.error(getApiErrorMessage(error, "Failed to create chat"));
    },
  });

  const deleteChatMutation = useMutation({
    mutationFn: async (threadId: string) => {
      await apiClient.delete(`/chat/threads/${threadId}`);
    },
    onSuccess: (_result, deletedThreadId) => {
      const fallbackThreadId =
        chatThreads?.find((thread) => thread.id !== deletedThreadId)?.id ??
        null;
      setRecentlyDeletedChatThreadId(deletedThreadId);
      queryClient.invalidateQueries({ queryKey: ["chat-threads"] });
      queryClient.removeQueries({ queryKey: ["chat-thread", deletedThreadId] });
      setSelectedChatThreadId((current) =>
        current === deletedThreadId ? fallbackThreadId : current,
      );
      setChatThreadToDelete(null);
    },
    onError: (error: unknown) => {
      toast.error(getApiErrorMessage(error, "Failed to delete chat"));
      setChatThreadToDelete(null);
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
      toast.error(getApiErrorMessage(error, "Failed to delete contract"));
      setContractToDelete(null);
    },
  });

  const standaloneContracts =
    contracts?.filter((contract) => !contract.projectId) || [];

  const setSectionOpen = (section: DashboardTab, open: boolean) => {
    setOpenSections((previous) => ({
      ...previous,
      [section]: open,
    }));
  };

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      <aside
        aria-hidden={!sidebarOpen}
        className={cn(
          "flex h-dvh shrink-0 flex-col overflow-hidden border-r bg-muted/20 transition-[width] duration-200",
          sidebarOpen ? "w-72" : "w-0 border-r-0",
        )}
      >
        {sidebarOpen ? (
          <>
            <div className="flex h-14 items-center border-b px-3">
              <div className="flex w-full items-center justify-between gap-2">
                <button
                  type="button"
                  className="flex items-center rounded-xl px-2 py-1 text-left transition-colors hover:bg-muted/50"
                  onClick={() => {
                    setActiveTab("chat");
                    if (!canUseSavedWorkspace) {
                      selectTemporaryChat();
                    }
                  }}
                  aria-label="Open chat"
                >
                  <SignLoopWordmark className="text-lg" />
                </button>

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
              </div>
            </div>

            <div className="flex-1 overflow-y-auto w-72">
              <div className="space-y-4 p-2 sm:p-3">
                <Collapsible
                  open={openSections.contracts}
                  onOpenChange={(open) => setSectionOpen("contracts", open)}
                >
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setActiveTab("contracts")}
                      aria-label="Contracts"
                      className={cn(
                        "flex w-full items-center rounded-md px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-muted hover:text-foreground",
                        activeTab === "contracts"
                          ? "bg-muted text-primary"
                          : "text-muted-foreground",
                      )}
                    >
                      <span className="flex items-center gap-3">
                        <FileText className="h-4 w-4" />
                        <span>Contracts</span>
                      </span>
                      {openSections.contracts ? (
                        <ChevronUp className="ml-auto h-4 w-4 opacity-50" />
                      ) : (
                        <ChevronDown className="ml-auto h-4 w-4 opacity-50" />
                      )}
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-1 ml-3.5 mb-2 space-y-1 border-l pl-[1.65rem]">
                    {!canUseSavedWorkspace ? (
                      <p className="px-3 py-1.5 text-xs text-muted-foreground">
                        Log in to view contracts
                      </p>
                    ) : loadingContracts ? (
                      <p className="px-3 py-1.5 text-xs text-muted-foreground">
                        Loading contracts...
                      </p>
                    ) : contractsFailed ? (
                      <button
                        type="button"
                        className="px-3 py-1.5 text-left text-xs text-destructive hover:underline"
                        onClick={() => void refetchContracts()}
                      >
                        Couldn&apos;t load contracts. Retry
                      </button>
                    ) : standaloneContracts.length === 0 ? (
                      <p className="px-3 py-1.5 text-xs text-muted-foreground">
                        No standalone contracts
                      </p>
                    ) : (
                      standaloneContracts.map((contract) => (
                        <Link
                          key={contract.id}
                          href={`/contracts/${contract.id}`}
                          className="block rounded-md px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <p className="truncate font-medium">
                            {contract.title}
                          </p>
                          <p className="mt-0.5 text-[10px] opacity-70">
                            {contract.status || "DRAFT"}
                          </p>
                        </Link>
                      ))
                    )}
                  </CollapsibleContent>
                </Collapsible>

                <Collapsible
                  open={openSections.projects}
                  onOpenChange={(open) => setSectionOpen("projects", open)}
                >
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setActiveTab("projects")}
                      aria-label="Projects"
                      className={cn(
                        "flex w-full items-center rounded-md px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-muted hover:text-foreground",
                        activeTab === "projects"
                          ? "bg-muted text-primary"
                          : "text-muted-foreground",
                      )}
                    >
                      <span className="flex items-center gap-3">
                        <FolderOpen className="h-4 w-4" />
                        <span>Projects</span>
                      </span>
                      {openSections.projects ? (
                        <ChevronUp className="ml-auto h-4 w-4 opacity-50" />
                      ) : (
                        <ChevronDown className="ml-auto h-4 w-4 opacity-50" />
                      )}
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-1 ml-3.5 mb-2 space-y-1 border-l pl-[1.65rem]">
                    {!canUseSavedWorkspace ? (
                      <p className="px-3 py-1.5 text-xs text-muted-foreground">
                        Log in to view projects
                      </p>
                    ) : loadingProjects ? (
                      <p className="px-3 py-1.5 text-xs text-muted-foreground">
                        Loading projects...
                      </p>
                    ) : projectsFailed ? (
                      <button
                        type="button"
                        className="px-3 py-1.5 text-left text-xs text-destructive hover:underline"
                        onClick={() => void refetchProjects()}
                      >
                        Couldn&apos;t load projects. Retry
                      </button>
                    ) : !projects || projects.length === 0 ? (
                      <p className="px-3 py-1.5 text-xs text-muted-foreground">
                        No projects yet
                      </p>
                    ) : (
                      projects.map((project) => (
                        <Link
                          key={project.id}
                          href={`/projects/${project.id}`}
                          className="block rounded-md px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <p className="truncate font-medium">
                            {project.title}
                          </p>
                          <p className="mt-0.5 text-[10px] opacity-70">
                            {project.contractCount || 0} contract
                            {project.contractCount === 1 ? "" : "s"}
                          </p>
                        </Link>
                      ))
                    )}
                  </CollapsibleContent>
                </Collapsible>

                <Collapsible
                  open={openSections.chat}
                  onOpenChange={(open) => setSectionOpen("chat", open)}
                >
                  <div className="flex items-center gap-1">
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setActiveTab("chat")}
                        aria-label="Chat"
                        className={cn(
                          "flex flex-1 items-center rounded-md px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-muted hover:text-foreground",
                          activeTab === "chat"
                            ? "bg-muted text-primary"
                            : "text-muted-foreground",
                        )}
                      >
                        <span className="flex items-center gap-3">
                          <MessagesSquare className="h-4 w-4" />
                          <span>Chat</span>
                        </span>
                        {openSections.chat ? (
                          <ChevronUp className="ml-auto h-4 w-4 opacity-50" />
                        ) : (
                          <ChevronDown className="ml-auto h-4 w-4 opacity-50" />
                        )}
                      </button>
                    </CollapsibleTrigger>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => {
                        if (canUseSavedWorkspace) {
                          createChatMutation.mutate();
                          return;
                        }

                        selectTemporaryChat();
                      }}
                      disabled={
                        canUseSavedWorkspace && createChatMutation.isPending
                      }
                      title="New chat"
                      aria-label="New chat"
                    >
                      {canUseSavedWorkspace && createChatMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Plus className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={selectTemporaryChat}
                      title="Temporary chat"
                      aria-label="Temporary chat"
                    >
                      <Clock className="h-4 w-4" />
                    </Button>
                  </div>
                  <CollapsibleContent className="mt-1 ml-3.5 mb-2 space-y-1 border-l pl-[1.65rem]">
                    <button
                      type="button"
                      onClick={selectTemporaryChat}
                      className={cn(
                        "block w-full rounded-md px-3 py-2 text-left text-xs transition-colors",
                        isTemporaryChatSelected
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <p className="flex items-center gap-1.5 truncate font-medium">
                        <Clock className="h-3 w-3 shrink-0" />
                        <span>Temporary chat</span>
                      </p>
                      <p className="mt-0.5 text-[10px] opacity-70">Not saved</p>
                    </button>
                    {!canUseSavedWorkspace ? (
                      <p className="px-3 py-1.5 text-xs text-muted-foreground">
                        Log in to save chats
                      </p>
                    ) : loadingChatThreads ? (
                      <p className="px-3 py-1.5 text-xs text-muted-foreground">
                        Loading chats...
                      </p>
                    ) : chatThreadsFailed ? (
                      <button
                        type="button"
                        className="px-3 py-1.5 text-left text-xs text-destructive hover:underline"
                        onClick={() => void refetchChatThreads()}
                      >
                        Couldn&apos;t load chats. Retry
                      </button>
                    ) : !chatThreads || chatThreads.length === 0 ? (
                      <p className="px-3 py-1.5 text-xs text-muted-foreground">
                        No chats yet
                      </p>
                    ) : (
                      chatThreads.map((thread) => (
                        <div
                          key={thread.id}
                          className={cn(
                            "group flex items-start justify-between rounded-md px-3 py-2 text-xs transition-colors",
                            selectedChatThreadId === thread.id
                              ? "bg-accent text-accent-foreground"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setActiveTab("chat");
                              selectSavedChatThread(thread.id);
                            }}
                            className="min-w-0 flex-1 text-left"
                          >
                            <p className="truncate font-medium">
                              {thread.title}
                            </p>
                            <p className="mt-0.5 text-[10px] opacity-70">
                              {thread.messageCount} msg
                              {thread.messageCount !== 1 ? "s" : ""}
                            </p>
                          </button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={cn(
                              "h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
                              selectedChatThreadId === thread.id &&
                                "opacity-100",
                            )}
                            onClick={() => setChatThreadToDelete(thread)}
                            disabled={
                              deleteChatMutation.isPending &&
                              deleteChatMutation.variables === thread.id
                            }
                            title="Delete chat"
                            aria-label="Delete chat"
                          >
                            {deleteChatMutation.isPending &&
                            deleteChatMutation.variables === thread.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                            )}
                          </Button>
                        </div>
                      ))
                    )}
                  </CollapsibleContent>
                </Collapsible>
              </div>
            </div>

            <div className="border-t p-3">
              <div className="space-y-1">
                {canUseSavedWorkspace ? (
                  <>
                    <Button
                      asChild
                      variant="ghost"
                      className="w-full justify-start text-muted-foreground hover:text-foreground"
                    >
                      <Link href="/settings" aria-label="Settings">
                        <Settings className="mr-3 h-4 w-4" />
                        <span>Settings</span>
                      </Link>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label="Sign out"
                      className="w-full justify-start text-muted-foreground hover:text-destructive"
                      onClick={() => signOut()}
                    >
                      <LogOut className="mr-3 h-4 w-4" />
                      <span>Sign out</span>
                    </Button>
                  </>
                ) : (
                  <Button
                    asChild
                    variant="ghost"
                    className="w-full justify-start text-muted-foreground hover:text-foreground"
                  >
                    <Link href="/sign-in" aria-label="Log in">
                      <LogIn className="mr-3 h-4 w-4" />
                      <span>Log in</span>
                    </Link>
                  </Button>
                )}
              </div>
            </div>
          </>
        ) : null}
      </aside>

      <main
        className={cn(
          "min-w-0 min-h-0 flex-1 flex flex-col relative",
          activeTab === "chat" ? "overflow-hidden" : "overflow-y-auto",
        )}
      >
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_60%_60%_at_50%_-20%,rgba(120,119,198,0.1),rgba(255,255,255,0))] dark:bg-[radial-gradient(ellipse_60%_60%_at_50%_-20%,rgba(120,119,198,0.2),rgba(255,255,255,0))]" />

        <header className="relative z-20 flex h-14 shrink-0 items-center px-2 gap-0.5">
          {!sidebarOpen && (
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-10 w-10 text-muted-foreground hover:text-foreground hover:bg-muted"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open sidebar"
              >
                <PanelLeft className="h-5 w-5" />
              </Button>
              {activeTab === "chat" && (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 text-muted-foreground hover:text-foreground hover:bg-muted"
                    onClick={() => {
                      if (canUseSavedWorkspace) {
                        createChatMutation.mutate();
                        return;
                      }

                      selectTemporaryChat();
                    }}
                    title="New chat"
                    aria-label="New chat"
                  >
                    <Plus className="h-5 w-5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 text-muted-foreground hover:text-foreground hover:bg-muted"
                    onClick={selectTemporaryChat}
                    title="Temporary chat"
                    aria-label="Temporary chat"
                  >
                    <Clock className="h-5 w-5" />
                  </Button>
                </>
              )}
            </div>
          )}

          <div className="flex items-center">
            {activeTab === "chat" && (
              <ModelSelector
                activeModel={activeModel}
                availableModels={availableModels}
                disabled={
                  !canUseSavedWorkspace || updateModelMutation.isPending
                }
                onSelect={(model) => {
                  if (!canUseSavedWorkspace) return;
                  updateModelMutation.mutate(model);
                }}
                showBrand={!sidebarOpen}
              />
            )}
          </div>
        </header>

        <div
          className={cn(
            "relative z-10 flex flex-1 min-h-0 flex-col",
            activeTab === "chat" ? "p-0" : "p-6 pt-0 lg:p-10 lg:pt-0",
          )}
        >
          {activeTab !== "chat" && (
            <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-border/40 pb-6 pt-2">
              <div>
                <h1 className="text-3xl font-bold tracking-tight">
                  {tabLabels[activeTab]}
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {canUseSavedWorkspace
                    ? `Welcome back, ${user?.firstName || "there"}`
                    : "Log in to create and manage saved workspace items."}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!canUseSavedWorkspace ? (
                  <Button asChild>
                    <Link href="/sign-in">
                      <LogIn className="mr-2 h-4 w-4" />
                      Log in
                    </Link>
                  </Button>
                ) : activeTab === "contracts" ? (
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
            !canUseSavedWorkspace ? (
              renderLoginRequired("contracts")
            ) : contractsFailed ? (
              renderLoadError("contracts", () => void refetchContracts())
            ) : loadingContracts ? (
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
                <h3 className="text-xl font-semibold text-foreground">
                  No contracts found
                </h3>
                <p className="mt-2 text-sm text-muted-foreground max-w-sm">
                  Upload a contract to begin analyzing it instantly, or create a
                  project for context-aware reviews.
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
                    <Link
                      href={`/contracts/${contract.id}`}
                      className="block h-full"
                    >
                      <CardHeader className="space-y-0 pb-4 pr-12">
                        <CardTitle className="text-base font-semibold leading-tight line-clamp-2">
                          {contract.title}
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="mb-4 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Calendar className="h-3.5 w-3.5" />
                          {formatDate(contract.createdAt, "MMMM d, yyyy")}
                        </div>
                        <div className="flex items-end justify-between">
                          <Badge
                            variant="secondary"
                            className="font-medium bg-secondary/50"
                          >
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
            !canUseSavedWorkspace ? (
              renderLoginRequired("projects")
            ) : projectsFailed ? (
              renderLoadError("projects", () => void refetchProjects())
            ) : loadingProjects ? (
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
                <h3 className="text-xl font-semibold text-foreground">
                  No projects yet
                </h3>
                <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
                  Projects let you analyze contracts with legal context. Upload
                  governing laws or reference documents.
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
                        <CardTitle className="text-base font-semibold leading-tight line-clamp-2">
                          {project.title}
                        </CardTitle>
                        <FolderOpen className="h-4 w-4 text-primary shrink-0 ml-2" />
                      </CardHeader>
                      <CardContent>
                        {project.description ? (
                          <p className="mb-4 line-clamp-2 text-sm text-muted-foreground leading-relaxed">
                            {project.description}
                          </p>
                        ) : null}
                        <div className="mb-4 flex flex-wrap gap-2">
                          <Badge
                            variant="outline"
                            className="text-xs font-medium border-border/60 bg-background"
                          >
                            <FileText className="mr-1.5 h-3 w-3 text-muted-foreground" />
                            {project.contractCount || 0} contract
                            {project.contractCount !== 1 ? "s" : ""}
                          </Badge>
                          <Badge
                            variant="outline"
                            className="text-xs font-medium border-border/60 bg-background"
                          >
                            <Book className="mr-1.5 h-3 w-3 text-muted-foreground" />
                            {project.contextDocumentCount || 0} context
                          </Badge>
                        </div>
                        <div className="flex items-end justify-between pt-1">
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Calendar className="h-3.5 w-3.5" />
                            {formatDate(project.createdAt, "MMM d, yyyy")}
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

          <div
            className={cn(
              "min-h-0 flex-1 overflow-hidden h-full flex-col bg-background/50",
              activeTab === "chat" ? "flex" : "hidden",
            )}
          >
            <ChatPanel
              selectedThreadId={
                isTemporaryChatSelected ? null : selectedChatThreadId
              }
              temporary={isTemporaryChatSelected}
              temporarySessionKey={temporaryChatKey}
              landingHero={landingHero}
              initialPrompt={initialTemporaryPrompt}
              onThreadSelected={(threadId) => {
                if (threadId) {
                  selectNewChatThread(threadId);
                  return;
                }

                setSelectedChatThreadId(null);
              }}
            />
          </div>
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
              This will permanently delete{" "}
              <span className="font-medium text-foreground">
                {contractToDelete?.title}
              </span>{" "}
              and all associated analyses. This action cannot be undone.
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
              {deleteContractMutation.isPending
                ? "Deleting..."
                : "Delete Contract"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!chatThreadToDelete}
        onOpenChange={(open) => {
          if (!open) setChatThreadToDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes{" "}
              {chatThreadToDelete?.title || "this chat"} and its complete
              message history. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteChatMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteChatMutation.isPending || !chatThreadToDelete}
              onClick={() => {
                if (chatThreadToDelete) {
                  deleteChatMutation.mutate(chatThreadToDelete.id);
                }
              }}
            >
              {deleteChatMutation.isPending ? "Deleting..." : "Delete Chat"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Dashboard;
