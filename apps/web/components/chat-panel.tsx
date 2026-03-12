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
  Download,
  Loader2,
  Send,
  Square,
  Sparkles,
  Bot
} from "lucide-react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
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
  mode?: string;
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

function compactInlineImageDataUris(text: string): string {
  return text
    .replace(
      /!\[([^\]]*)\]\(\s*data:image\/[a-z0-9.+-]+;base64,[^)]+\)/gi,
      (_match, alt: string) => `[generated image${alt?.trim() ? `: ${alt.trim()}` : ""}]`,
    )
    .replace(
      /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{200,}/gi,
      "[generated image data]",
    );
}

function extractMessageText(message: ThreadMessage): string {
  const chunks: string[] = [];

  for (const part of message.content) {
    if (part.type === "text" || part.type === "reasoning") {
      if (part.text.trim()) {
        chunks.push(compactInlineImageDataUris(part.text.trim()));
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
    mode: typeof payload.mode === "string" ? payload.mode : undefined,
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
  <MessagePartPrimitive.Text component="p" className="whitespace-pre-wrap text-sm leading-relaxed" />
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

function markdownUrlTransform(url: string): string {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(url)) {
    return url;
  }

  if (/^blob:/i.test(url)) {
    return url;
  }

  return defaultUrlTransform(url);
}

function inferImageExtension(src: string): string {
  const dataUriMatch = src.match(/^data:image\/([a-z0-9.+-]+);base64,/i);
  if (dataUriMatch?.[1]) {
    const raw = dataUriMatch[1].toLowerCase();
    if (raw === "jpeg") return "jpg";
    if (raw === "svg+xml") return "svg";
    return raw.replace(/[^a-z0-9]+/g, "");
  }

  try {
    const parsed = new URL(src);
    const fileName = parsed.pathname.split("/").pop() ?? "";
    const extensionMatch = fileName.match(/\.([a-z0-9]{2,5})$/i);
    if (extensionMatch?.[1]) {
      return extensionMatch[1].toLowerCase();
    }
  } catch {
    // ignore parse failures and fall back to png
  }

  return "png";
}

function makeDownloadFileName(src: string): string {
  const extension = inferImageExtension(src);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `signloop-image-${stamp}.${extension}`;
}

function clickDownloadAnchor(href: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function downloadImageFromSrc(src: string): Promise<void> {
  const fileName = makeDownloadFileName(src);

  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(src)) {
    clickDownloadAnchor(src, fileName);
    return;
  }

  try {
    const response = await fetch(src);
    if (response.ok) {
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      clickDownloadAnchor(blobUrl, fileName);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
      return;
    }
  } catch {
    // fall through to direct URL download
  }

  clickDownloadAnchor(src, fileName);
}

type MarkdownImageProps = ComponentPropsWithoutRef<"img"> & {
  src?: string | Blob;
  alt?: string;
};

const MarkdownImage = ({ src, alt, className, ...props }: MarkdownImageProps) => {
  if (typeof src !== "string" || !src) {
    return null;
  }

  return (
    <span className="group relative my-4 block w-fit max-w-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt ?? "Generated image"}
        className={cn("max-h-[32rem] w-auto max-w-full rounded-xl border object-contain shadow-sm", className)}
        {...props}
      />
      <button
        type="button"
        className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-lg border bg-background/80 text-foreground shadow-sm backdrop-blur transition-all hover:bg-background/100"
        onClick={() => {
          void downloadImageFromSrc(src);
        }}
        title="Download image"
        aria-label="Download image"
      >
        <Download className="h-4 w-4" />
      </button>
    </span>
  );
};

const markdownComponents: Components = {
  img: (props) => <MarkdownImage {...props} />,
};

const MarkdownMessage = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  ({ children, className, ...props }, ref) => {
    const markdown = useMemo(() => toMarkdownText(children), [children]);

    return (
      <div
        ref={ref}
        className={cn(
          "text-sm leading-relaxed prose prose-sm dark:prose-invert max-w-none text-foreground",
          "prose-headings:font-semibold prose-headings:tracking-tight",
          "prose-h1:text-xl prose-h2:text-lg prose-h3:text-base",
          "prose-a:text-primary prose-a:underline-offset-4 hover:prose-a:text-primary/80",
          "prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:bg-muted prose-code:text-muted-foreground prose-code:font-mono prose-code:text-[0.85em]",
          "prose-pre:bg-muted/50 prose-pre:border prose-pre:rounded-xl prose-pre:p-4 prose-pre:shadow-sm",
          "prose-blockquote:border-l-4 prose-blockquote:border-primary/50 prose-blockquote:pl-4 prose-blockquote:italic",
          "prose-table:border-collapse prose-table:w-full",
          "prose-th:border-b prose-th:px-4 prose-th:py-2 prose-th:text-left",
          "prose-td:border-b prose-td:border-border/50 prose-td:px-4 prose-td:py-2",
          "prose-hr:my-8 prose-hr:border-border/50",
          "[&_.katex-display>.katex]:inline-block [&_.katex-display>.katex]:min-w-full [&_.katex-display]:my-4 [&_.katex-display]:overflow-x-auto",
          className,
        )}
        {...props}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          urlTransform={markdownUrlTransform}
          components={markdownComponents}
        >
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
    <MessagePrimitive.Root className="group relative flex w-full flex-col gap-2 mb-6">
      <MessagePrimitive.If user>
        <div className="ml-auto relative flex max-w-[85%] items-end gap-2 md:max-w-[75%]">
          <div className="flex w-full flex-col gap-1 rounded-2xl rounded-br-sm bg-primary px-5 py-3.5 text-primary-foreground shadow-sm">
            <MessagePrimitive.Content components={{ Text: UserTextPart }} />
          </div>
        </div>
      </MessagePrimitive.If>

      <MessagePrimitive.If assistant>
        <div className="mr-auto relative flex max-w-[90%] items-start gap-3 md:max-w-[90%]">
          <div className="flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-lg border bg-background shadow-sm">
            <Bot className="h-4 w-4 text-foreground/80" />
          </div>
          <div className="flex w-full flex-col gap-1 rounded-2xl rounded-tl-sm border bg-card px-5 py-4 shadow-sm">
            <MessagePrimitive.Content
              components={{
                Text: AssistantTextPart,
                Reasoning: AssistantTextPart,
              }}
            />
            <MessagePrimitive.Error>
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <Square className="h-4 w-4" />
                <p>Failed to generate a response. Please try again.</p>
              </div>
            </MessagePrimitive.Error>
          </div>
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
  const newlyCreatedThreadIdsRef = useRef<Set<string>>(new Set());
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
          newlyCreatedThreadIdsRef.current.add(threadId);
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
              mode: parsedSuccess.mode ?? null,
            },
          },
        };
      },
    }),
    [activeThreadId, onThreadSelected, queryClient]
  );

  const runtime = useLocalRuntime(chatModel);
  const isHydratingThread =
    activeThreadId !== null &&
    activeThreadQuery.isLoading &&
    !newlyCreatedThreadIdsRef.current.has(activeThreadId);

  useEffect(() => {
    if (!activeThreadId) {
      runtime.thread.reset([]);
      hydratedSignatureRef.current = null;
      return;
    }

    if (activeThreadQuery.isLoading) {
      if (newlyCreatedThreadIdsRef.current.has(activeThreadId)) {
        return;
      }

      runtime.thread.reset([]);
      hydratedSignatureRef.current = `${activeThreadId}:loading`;
      return;
    }

    const thread = activeThreadQuery.data;
    if (!thread) return;

    const lastMessage = thread.messages[thread.messages.length - 1];
    const signature = `${thread.id}:${thread.messages.length}:${lastMessage?.id ?? "none"}`;
    const isNewlyCreatedThread = newlyCreatedThreadIdsRef.current.has(thread.id);
    if (isNewlyCreatedThread && thread.messages.length === 0) {
      hydratedSignatureRef.current = `${thread.id}:pending`;
      return;
    }

    if (hydratedSignatureRef.current === signature) {
      return;
    }

    runtime.thread.reset(toRuntimeMessages(thread.messages));
    hydratedSignatureRef.current = signature;
    if (isNewlyCreatedThread) {
      newlyCreatedThreadIdsRef.current.delete(thread.id);
    }
  }, [
    activeThreadId,
    activeThreadQuery.data,
    activeThreadQuery.isLoading,
    runtime,
  ]);

  return (
    <Card className="flex h-full min-h-0 w-full flex-col overflow-hidden border-0 bg-transparent shadow-none sm:border sm:bg-background/50 sm:shadow-sm sm:backdrop-blur-md relative">
      <CardContent className="flex h-full min-h-0 flex-1 flex-col p-0 sm:p-0">
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col overflow-hidden">
            <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 py-6 scroll-smooth">
              {isHydratingThread ? (
                <div className="flex h-full flex-col items-center justify-center space-y-4 pb-20 text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <Loader2 className="h-8 w-8 animate-spin" />
                  </div>
                  <div className="space-y-2 max-w-[400px]">
                    <h2 className="text-xl font-semibold tracking-tight">Loading conversation</h2>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      Fetching the existing thread history before chat becomes available.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <ThreadPrimitive.Empty>
                    <div className="flex h-full flex-col items-center justify-center space-y-4 text-center pb-20">
                      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                        <Sparkles className="h-8 w-8" />
                      </div>
                      <div className="space-y-2 max-w-[400px]">
                        <h2 className="text-xl font-semibold tracking-tight">How can I help you today?</h2>
                        {activeThreadId ? (
                          <p className="text-sm text-muted-foreground leading-relaxed">
                            Start a conversation about reviewing your contracts, spotting clauses, or navigating negotiation points.
                          </p>
                        ) : (
                          <p className="text-sm text-muted-foreground leading-relaxed">
                            Select an existing chat from the sidebar or click <span className="font-medium text-foreground">New Chat</span> to start.
                          </p>
                        )}
                      </div>
                    </div>
                  </ThreadPrimitive.Empty>

                  <div className="mx-auto w-full max-w-6xl">
                    <ThreadPrimitive.Messages components={{ Message: ChatMessage }} />
                  </div>
                </>
              )}
            </ThreadPrimitive.Viewport>

            <ComposerPrimitive.Root className="shrink-0 bg-transparent p-4 pt-1 sm:p-6 sm:pt-2">
              <div className="mx-auto flex w-full max-w-6xl items-end gap-2 rounded-2xl border bg-background/80 p-2 shadow-sm backdrop-blur transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20">
                <ComposerPrimitive.Input
                  className={cn(
                    "min-h-[44px] max-h-60 w-full resize-none bg-transparent px-3 py-3 text-sm text-foreground outline-none",
                    "placeholder:text-muted-foreground",
                  )}
                  disabled={isHydratingThread}
                  placeholder={isHydratingThread ? "Loading conversation..." : "Ask a question about your documents..."}
                  submitMode="enter"
                  rows={1}
                />

                <div className="flex shrink-0 p-1">
                  <ThreadPrimitive.If running={false}>
                    <ComposerPrimitive.Send asChild>
                      <Button
                        type="button"
                        size="icon"
                        disabled={isHydratingThread}
                        className="h-9 w-9 shrink-0 rounded-xl transition-transform hover:scale-105"
                      >
                        <Send className="h-4 w-4" />
                        <span className="sr-only">Send message</span>
                      </Button>
                    </ComposerPrimitive.Send>
                  </ThreadPrimitive.If>

                  <ThreadPrimitive.If running>
                    <ComposerPrimitive.Cancel asChild>
                      <Button type="button" variant="secondary" size="icon" className="h-9 w-9 shrink-0 rounded-xl">
                        <Square className="h-4 w-4 fill-current" />
                        <span className="sr-only">Cancel generation</span>
                      </Button>
                    </ComposerPrimitive.Cancel>
                  </ThreadPrimitive.If>
                </div>
              </div>
              <div className="mx-auto mt-2 max-w-6xl text-center text-xs text-muted-foreground/80">
                {isHydratingThread
                  ? "Conversation history is loading. Sending is disabled until it finishes."
                  : "AI may produce inaccurate information about laws or guidelines. Keep original records."}
              </div>
            </ComposerPrimitive.Root>
          </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
      </CardContent>
    </Card>
  );
}
