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
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  MessageSquareText,
  Send,
  Square,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
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

const UserTextPart = () => (
  <MessagePartPrimitive.Text component="p" className="whitespace-pre-wrap text-sm leading-6 text-foreground" />
);

function looksLikeMathContent(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  if (/^\d+$/.test(text)) return false;

  return /\\[a-zA-Z]+|[{}^_=]|[+\-*/<>]=?|(?:\d+\s*[a-zA-Z])|(?:[a-zA-Z]\s*\d)/.test(text);
}

function normalizeMathNotation(raw: string): string {
  let text = raw;

  // Support LaTeX-style delimiters.
  text = text.replace(/\\\[((?:.|\n)*?)\\\]/g, (_match, expression) => `\n$$\n${expression.trim()}\n$$\n`);
  text = text.replace(/\\\(((?:.|\n)*?)\\\)/g, (_match, expression) => `$${expression.trim()}$`);

  // Support bracketed display math often returned by models: [ ... ]
  text = text.replace(/(^|[\s:])\[([^\]\n]{2,320})\](?=$|[\s,.;:!?])/g, (full, prefix: string, expression: string) => {
    if (!looksLikeMathContent(expression)) return full;
    return `${prefix}\n$$\n${expression.trim()}\n$$\n`;
  });

  return text;
}

function toMarkdownText(children: ReactNode): string {
  const text = typeof children === "string" ? children : String(children ?? "");
  return normalizeMathNotation(text.replace(/<br\s*\/?>/gi, "\n"));
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
          "[&_.katex]:text-foreground [&_.katex]:text-[1.02em]",
          "[&_.katex-display]:my-4 [&_.katex-display]:overflow-x-auto",
          "[&_.katex-display>.katex]:inline-block [&_.katex-display>.katex]:min-w-full",
          className,
        )}
        {...props}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
          {markdown}
        </ReactMarkdown>
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
        <div className="ml-auto max-w-3xl rounded-[var(--radius)] border-2 border-[hsl(var(--accent)/0.7)] bg-[hsl(var(--accent)/0.16)] px-4 py-3 shadow-[var(--card-shadow)]">
          <MessagePrimitive.Content components={{ Text: UserTextPart }} />
        </div>
      </MessagePrimitive.If>

      <MessagePrimitive.If assistant>
        <div className="mr-auto max-w-3xl rounded-[var(--radius)] border-2 border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-3 shadow-[var(--card-shadow)]">
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

type ChatPanelProps = {
  selectedThreadId?: string | null;
  onThreadSelected?: (threadId: string | null) => void;
};

export function ChatPanel({ selectedThreadId = null, onThreadSelected }: ChatPanelProps) {
  const queryClient = useQueryClient();
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const hydratedSignatureRef = useRef<string | null>(null);

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
    if (!selectedThreadId) {
      if (activeThreadId !== null) {
        setActiveThreadId(null);
      }
      return;
    }

    if (selectedThreadId !== activeThreadId) {
      setActiveThreadId(selectedThreadId);
    }
  }, [selectedThreadId, activeThreadId]);

  const chatModel = useMemo<ChatModelAdapter>(
    () => ({
      run: async ({ messages, abortSignal }) => {
        let threadId = activeThreadId;
        if (!threadId) {
          const createThreadResponse = await fetch("/api/chat/threads", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
            signal: abortSignal,
          });
          const createPayload = (await createThreadResponse.json().catch(() => null)) as
            | { data?: { id?: string }; error?: string }
            | null;

          if (!createThreadResponse.ok || !createPayload?.data?.id) {
            throw new Error(createPayload?.error || "Failed to create chat thread.");
          }

          threadId = createPayload.data.id;
          setActiveThreadId(threadId);
          onThreadSelected?.(threadId);
          queryClient.invalidateQueries({ queryKey: ["chat-threads"] });
        }

        const payloadMessages = toApiMessages(messages);

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            threadId,
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
        queryClient.invalidateQueries({ queryKey: ["chat-thread", threadId] });

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
    [activeThreadId, onThreadSelected, queryClient]
  );

  const runtime = useLocalRuntime(chatModel);

  useEffect(() => {
    if (!activeThreadId) {
      runtime.thread.reset([]);
      hydratedSignatureRef.current = null;
      return;
    }

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

  return (
    <Card className="h-full overflow-hidden border-2 border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-[var(--card-shadow)] transition-none hover:translate-x-0 hover:translate-y-0 hover:shadow-[var(--card-shadow)]">
      <CardContent className="h-full p-0">
        <div className="flex h-full min-h-0">
          <div className="flex min-w-0 flex-1 flex-col bg-[hsl(var(--card))]">
            <AssistantRuntimeProvider runtime={runtime}>
              <ThreadPrimitive.Root className="flex h-full flex-col">
                <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto p-4">
                  <ThreadPrimitive.Empty>
                    <div className="mx-auto flex max-w-xl flex-col items-center gap-3 py-16 text-center text-muted-foreground">
                      <MessageSquareText className="h-8 w-8" />
                      {activeThreadId ? (
                        <p className="text-sm">
                          Ask about clauses, obligations, dates, or negotiation points. Chats are saved and tied to
                          your account.
                        </p>
                      ) : (
                        <p className="text-sm">
                          Select a chat from the sidebar or create a new one to start.
                        </p>
                      )}
                    </div>
                  </ThreadPrimitive.Empty>

                  <ThreadPrimitive.Messages components={{ Message: ChatMessage }} />
                </ThreadPrimitive.Viewport>

                <ComposerPrimitive.Root className="sticky bottom-0 z-10 border-t-2 border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3">
                  <div className="flex items-end gap-2">
                    <ComposerPrimitive.Input
                      className={cn(
                        "min-h-[52px] w-full resize-none rounded-[var(--radius)] border-2 border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2 text-sm text-foreground outline-none ring-0",
                        "placeholder:text-muted-foreground focus-visible:border-[hsl(var(--accent)/0.75)]",
                      )}
                      placeholder="Type your question..."
                      submitMode="enter"
                      rows={1}
                    />

                    <ThreadPrimitive.If running={false}>
                      <ComposerPrimitive.Send asChild>
                        <Button type="button" variant="outline" size="icon" className="h-[52px] w-[52px] shrink-0">
                          <Send className="h-4 w-4" />
                        </Button>
                      </ComposerPrimitive.Send>
                    </ThreadPrimitive.If>

                    <ThreadPrimitive.If running>
                      <ComposerPrimitive.Cancel asChild>
                        <Button type="button" variant="outline" size="icon" className="h-[52px] w-[52px] shrink-0">
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
