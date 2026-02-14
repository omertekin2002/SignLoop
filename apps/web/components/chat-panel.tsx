'use client';

import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  Loader2,
  MessageSquareText,
  Plus,
  Send,
  Square,
  Trash2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type ChatApiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatApiSuccess = {
  message: string;
  provider?: string;
  model?: string;
};

type ChatThreadSummary = {
  id: string;
  title: string;
  updatedAt: string;
  lastMessagePreview: string | null;
  messageCount: number;
};

type ChatThreadMessage = {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  createdAt: string;
};

type ChatThreadDetail = {
  id: string;
  title: string;
  messages: ChatThreadMessage[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractMessageText(message: ThreadMessage): string {
  const chunks: string[] = [];

  for (const part of message.content) {
    if (part.type === "text" || part.type === "reasoning") {
      if (part.text.trim()) {
        chunks.push(part.text.trim());
      }
      continue;
    }

    if (part.type === "source") {
      const sourceLabel = part.title ? `${part.title}: ${part.url}` : part.url;
      chunks.push(sourceLabel);
      continue;
    }

    if (part.type === "image") {
      chunks.push(part.filename ? `[image: ${part.filename}]` : "[image]");
      continue;
    }

    if (part.type === "file") {
      chunks.push(part.filename ? `[file: ${part.filename}]` : "[file]");
      continue;
    }

    if (part.type === "audio") {
      chunks.push("[audio]");
      continue;
    }

    if (part.type === "tool-call") {
      chunks.push(`[tool-call: ${part.toolName}]`);
      continue;
    }

    if (part.type === "data") {
      chunks.push(`[data: ${part.name}]`);
    }
  }

  return chunks.join("\n").trim();
}

function toApiMessages(messages: readonly ThreadMessage[]): ChatApiMessage[] {
  return messages
    .map((message) => ({
      role: message.role,
      content: extractMessageText(message),
    }))
    .filter((message) => message.content.length > 0)
    .slice(-30);
}

function parseError(payload: unknown, status: number): string {
  if (isRecord(payload) && typeof payload.error === "string" && payload.error.trim()) {
    return payload.error;
  }

  return `Chat request failed (${status})`;
}

function parseSuccess(payload: unknown): ChatApiSuccess {
  if (!isRecord(payload) || typeof payload.message !== "string") {
    throw new Error("Chat response did not include a message.");
  }

  const message = payload.message.trim();
  if (!message) {
    throw new Error("Chat response was empty.");
  }

  return {
    message,
    provider: typeof payload.provider === "string" ? payload.provider : undefined,
    model: typeof payload.model === "string" ? payload.model : undefined,
  };
}

function toRuntimeMessages(messages: ChatThreadMessage[]): ThreadMessageLike[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: new Date(message.createdAt),
  }));
}

function formatThreadDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

const UserTextPart = () => (
  <MessagePartPrimitive.Text component="p" className="whitespace-pre-wrap text-sm leading-6 text-primary-foreground" />
);

function toMarkdownText(children: ReactNode): string {
  const text = typeof children === "string" ? children : String(children ?? "");
  return text.replace(/<br\s*\/?>/gi, "\n");
}

const MarkdownMessage = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  ({ children, className, ...props }, ref) => {
    const markdown = useMemo(() => toMarkdownText(children), [children]);

    return (
      <div
        ref={ref}
        className={cn(
          "text-sm leading-6 text-foreground",
          "[&_h1]:mb-2 [&_h1]:mt-5 [&_h1]:text-xl [&_h1]:font-semibold",
          "[&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold",
          "[&_h3]:mb-2 [&_h3]:mt-3 [&_h3]:text-base [&_h3]:font-semibold",
          "[&_p]:mb-3 [&_p:last-child]:mb-0",
          "[&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-6",
          "[&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-6",
          "[&_li]:mb-1",
          "[&_a]:text-[var(--accent)] [&_a]:underline [&_a]:underline-offset-2",
          "[&_code]:rounded [&_code]:bg-muted/70 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
          "[&_pre]:mb-3 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:border [&_pre]:border-border [&_pre]:bg-background/80 [&_pre]:p-3",
          "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
          "[&_blockquote]:mb-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground",
          "[&_table]:mb-3 [&_table]:w-full [&_table]:border-collapse [&_table]:overflow-hidden [&_table]:border [&_table]:border-border",
          "[&_th]:border [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold",
          "[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5",
          "[&_hr]:my-4 [&_hr]:border-border",
          className,
        )}
        {...props}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
    );
  }
);

MarkdownMessage.displayName = "MarkdownMessage";

const AssistantTextPart = () => (
  <MessagePartPrimitive.Text component={MarkdownMessage} smooth={false} />
);

const ChatMessage = () => {
  return (
    <MessagePrimitive.Root className="mb-4">
      <MessagePrimitive.If user>
        <div className="ml-auto max-w-3xl border border-border bg-primary px-4 py-3 shadow-sm">
          <MessagePrimitive.Content components={{ Text: UserTextPart }} />
        </div>
      </MessagePrimitive.If>

      <MessagePrimitive.If assistant>
        <div className="mr-auto max-w-3xl border border-border bg-card/90 px-4 py-3 shadow-sm backdrop-blur-sm">
          <MessagePrimitive.Content
            components={{
              Text: AssistantTextPart,
              Reasoning: AssistantTextPart,
            }}
          />
          <MessagePrimitive.Error>
            <p className="mt-2 text-xs text-destructive">Failed to generate a response. Please try again.</p>
          </MessagePrimitive.Error>
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
};

export function ChatPanel() {
  const queryClient = useQueryClient();
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const hydratedSignatureRef = useRef<string | null>(null);

  const threadsQuery = useQuery({
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

  const createThreadMutation = useMutation({
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
    onSuccess: (created) => {
      setActiveThreadId(created.id);
      queryClient.invalidateQueries({ queryKey: ["chat-threads"] });
    },
  });

  const deleteThreadMutation = useMutation({
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

      if (activeThreadId === deletedThreadId) {
        setActiveThreadId(null);
        hydratedSignatureRef.current = null;
      }
    },
  });

  const activeThreadQuery = useQuery({
    queryKey: ["chat-thread", activeThreadId],
    enabled: Boolean(activeThreadId),
    queryFn: async () => {
      const response = await fetch(`/api/chat/threads/${activeThreadId}`);
      const payload = (await response.json().catch(() => null)) as
        | { data?: ChatThreadDetail; error?: string }
        | null;

      if (!response.ok || !payload?.data) {
        throw new Error(payload?.error || "Failed to fetch chat thread.");
      }

      return payload.data;
    },
  });

  useEffect(() => {
    const threads = threadsQuery.data;
    if (!threads || threadsQuery.isLoading) return;

    if (!threads.length) {
      if (!createThreadMutation.isPending && !activeThreadId) {
        createThreadMutation.mutate();
      }
      return;
    }

    if (!activeThreadId) {
      setActiveThreadId(threads[0]!.id);
      return;
    }

    const stillExists = threads.some((thread) => thread.id === activeThreadId);
    if (!stillExists) {
      setActiveThreadId(threads[0]!.id);
    }
  }, [
    activeThreadId,
    createThreadMutation,
    threadsQuery.data,
    threadsQuery.isLoading,
  ]);

  const chatModel = useMemo<ChatModelAdapter>(
    () => ({
      run: async ({ messages, abortSignal }) => {
        if (!activeThreadId) {
          throw new Error("Select or create a chat first.");
        }

        const payloadMessages = toApiMessages(messages);

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            threadId: activeThreadId,
            messages: payloadMessages,
          }),
          signal: abortSignal,
        });

        const rawPayload = await response.text();
        let parsedPayload: unknown = null;

        if (rawPayload) {
          try {
            parsedPayload = JSON.parse(rawPayload);
          } catch {
            parsedPayload = null;
          }
        }

        if (!response.ok) {
          throw new Error(parseError(parsedPayload, response.status));
        }

        queryClient.invalidateQueries({ queryKey: ["chat-threads"] });
        queryClient.invalidateQueries({ queryKey: ["chat-thread", activeThreadId] });

        const parsedSuccess = parseSuccess(parsedPayload);
        return {
          content: [{ type: "text", text: parsedSuccess.message }] as const,
          metadata: {
            custom: {
              provider: parsedSuccess.provider ?? null,
              model: parsedSuccess.model ?? null,
            },
          },
        };
      },
    }),
    [activeThreadId, queryClient]
  );

  const runtime = useLocalRuntime(chatModel);

  useEffect(() => {
    if (!activeThreadId) return;

    if (activeThreadQuery.isLoading) {
      runtime.thread.reset([]);
      hydratedSignatureRef.current = `${activeThreadId}:loading`;
      return;
    }

    const thread = activeThreadQuery.data;
    if (!thread) return;

    const lastMessage = thread.messages[thread.messages.length - 1];
    const signature = `${thread.id}:${thread.messages.length}:${lastMessage?.id ?? "none"}`;
    if (hydratedSignatureRef.current === signature) {
      return;
    }

    runtime.thread.reset(toRuntimeMessages(thread.messages));
    hydratedSignatureRef.current = signature;
  }, [
    activeThreadId,
    activeThreadQuery.data,
    activeThreadQuery.isLoading,
    runtime,
  ]);

  const threads = threadsQuery.data || [];

  return (
    <Card className="border border-border bg-card/80 shadow-sm backdrop-blur-sm">
      <CardContent className="p-0">
        <div className="flex h-[72vh] min-h-[560px]">
          <aside className="w-[300px] shrink-0 border-r border-border bg-background/45">
            <div className="flex items-center justify-between border-b border-border px-3 py-3">
              <h3 className="text-sm font-semibold text-foreground">Chats</h3>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8"
                onClick={() => createThreadMutation.mutate()}
                disabled={createThreadMutation.isPending}
              >
                {createThreadMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>

            <div className="h-[calc(72vh-56px)] overflow-y-auto p-2">
              {threadsQuery.isLoading ? (
                <div className="px-2 py-4 text-xs text-muted-foreground">Loading chats...</div>
              ) : threads.length === 0 ? (
                <div className="px-2 py-4 text-xs text-muted-foreground">
                  No chats yet. Create one to start.
                </div>
              ) : (
                <div className="space-y-2">
                  {threads.map((thread) => {
                    const isActive = thread.id === activeThreadId;
                    const isDeleting =
                      deleteThreadMutation.isPending && deleteThreadMutation.variables === thread.id;

                    return (
                      <button
                        key={thread.id}
                        type="button"
                        onClick={() => setActiveThreadId(thread.id)}
                        className={cn(
                          "w-full border px-3 py-2 text-left transition-colors",
                          isActive
                            ? "border-ring bg-muted/80"
                            : "border-border bg-card/60 hover:bg-muted/45"
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">{thread.title}</p>
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                              {thread.lastMessagePreview || "No messages yet"}
                            </p>
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              {thread.messageCount} message{thread.messageCount === 1 ? "" : "s"}{" "}
                              {thread.updatedAt ? `• ${formatThreadDate(thread.updatedAt)}` : ""}
                            </p>
                          </div>

                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0"
                            title="Delete chat"
                            disabled={isDeleting}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              deleteThreadMutation.mutate(thread.id);
                            }}
                          >
                            {isDeleting ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                          </Button>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <AssistantRuntimeProvider runtime={runtime}>
              <ThreadPrimitive.Root className="flex h-full flex-col">
                <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto p-4">
                  <ThreadPrimitive.Empty>
                    <div className="mx-auto flex max-w-xl flex-col items-center gap-3 py-16 text-center text-muted-foreground">
                      <MessageSquareText className="h-8 w-8" />
                      <p className="text-sm">
                        Ask about clauses, obligations, dates, or negotiation points. Chats are saved and tied to your
                        account.
                      </p>
                    </div>
                  </ThreadPrimitive.Empty>

                  <ThreadPrimitive.Messages components={{ Message: ChatMessage }} />
                </ThreadPrimitive.Viewport>

                <ComposerPrimitive.Root className="border-t border-border bg-background/70 p-3">
                  <div className="flex items-end gap-2">
                    <ComposerPrimitive.Input
                      className={cn(
                        "min-h-[52px] w-full resize-none border border-input bg-card px-3 py-2 text-sm text-foreground outline-none ring-0",
                        "placeholder:text-muted-foreground focus-visible:border-ring"
                      )}
                      placeholder="Type your question..."
                      submitMode="enter"
                      rows={1}
                    />

                    <ThreadPrimitive.If running={false}>
                      <ComposerPrimitive.Send asChild>
                        <Button type="button" size="icon" className="h-11 w-11 shrink-0">
                          <Send className="h-4 w-4" />
                        </Button>
                      </ComposerPrimitive.Send>
                    </ThreadPrimitive.If>

                    <ThreadPrimitive.If running>
                      <ComposerPrimitive.Cancel asChild>
                        <Button type="button" variant="outline" size="icon" className="h-11 w-11 shrink-0">
                          <Square className="h-4 w-4" />
                        </Button>
                      </ComposerPrimitive.Cancel>
                    </ThreadPrimitive.If>
                  </div>
                </ComposerPrimitive.Root>
              </ThreadPrimitive.Root>
            </AssistantRuntimeProvider>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
