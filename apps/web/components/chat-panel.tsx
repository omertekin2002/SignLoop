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
  ImagePlus,
  MessageSquareText,
  Send,
  Square,
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

type ChatSettingsAvailability = {
  imageGenerationAvailable: boolean;
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
    <span className="group relative my-3 block w-fit max-w-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt ?? "Generated image"}
        className={cn("max-h-[32rem] w-auto max-w-full rounded border border-border", className)}
        {...props}
      />
      <button
        type="button"
        className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded border border-[hsl(var(--border))] bg-[hsl(var(--card)/0.95)] text-foreground shadow-[2px_2px_0_hsl(var(--border))] transition hover:bg-[hsl(var(--accent)/0.2)]"
        onClick={() => {
          void downloadImageFromSrc(src);
        }}
        title="Download image"
        aria-label="Download image"
      >
        <Download className="h-3.5 w-3.5" />
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
          "[&_img]:my-3 [&_img]:max-h-[32rem] [&_img]:w-auto [&_img]:max-w-full [&_img]:rounded [&_img]:border [&_img]:border-border",
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
  const [imageMode, setImageMode] = useState(false);
  const hydratedSignatureRef = useRef<string | null>(null);
  const settingsAvailabilityQuery = useQuery({
    queryKey: ["settings", "chat-availability"],
    queryFn: async () => {
      const response = await fetch("/api/settings");
      const payload = (await response.json().catch(() => null)) as
        | (ChatSettingsAvailability & { error?: string })
        | null;

      if (!response.ok || !payload) {
        throw new Error(payload?.error || "Failed to load chat model availability.");
      }

      return payload;
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const isImageGenerationAvailable = settingsAvailabilityQuery.data?.imageGenerationAvailable === true;

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
      return;
    }

    if (selectedThreadId !== activeThreadId) {
      setActiveThreadId(selectedThreadId);
    }
  }, [selectedThreadId, activeThreadId]);

  useEffect(() => {
    if (!isImageGenerationAvailable && imageMode) {
      setImageMode(false);
    }
  }, [imageMode, isImageGenerationAvailable]);

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
            imageMode,
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
    [activeThreadId, imageMode, onThreadSelected, queryClient]
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
    <Card className="h-full min-h-0 overflow-hidden border-2 border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-[var(--card-shadow)] transition-none hover:translate-x-0 hover:translate-y-0 hover:shadow-[var(--card-shadow)]">
      <CardContent className="h-full min-h-0 !p-0">
        <div className="flex h-full min-h-0">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[hsl(var(--card))]">
            <AssistantRuntimeProvider runtime={runtime}>
              <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col overflow-hidden">
                <ThreadPrimitive.Viewport className="h-0 flex-1 overflow-y-auto p-4">
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

                <ComposerPrimitive.Root className="shrink-0 border-t-2 border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3">
                  {isImageGenerationAvailable ? (
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <Button
                        type="button"
                        variant={imageMode ? "default" : "outline"}
                        size="sm"
                        className="h-8 gap-1.5 px-2.5 text-[0.68rem] normal-case tracking-normal"
                        onClick={() => setImageMode((current) => !current)}
                      >
                        <ImagePlus className="h-3.5 w-3.5" />
                        {imageMode ? "Image Mode On" : "Image Mode"}
                      </Button>
                      <p className="hidden text-xs text-muted-foreground sm:block">
                        {imageMode
                          ? "Using gemini-3.1-flash-image for this chat turn."
                          : "Toggle to generate images from your prompt."}
                      </p>
                    </div>
                  ) : null}

                  <div className="flex items-end gap-2">
                    <ComposerPrimitive.Input
                      className={cn(
                        "min-h-[52px] w-full resize-none rounded-[var(--radius)] border-2 border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2 text-sm text-foreground outline-none ring-0",
                        "placeholder:text-muted-foreground focus-visible:border-[hsl(var(--accent)/0.75)]",
                      )}
                      placeholder={
                        imageMode && isImageGenerationAvailable
                          ? "Describe the image you want to generate..."
                          : "Type your question..."
                      }
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
