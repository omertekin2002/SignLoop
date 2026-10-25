"use client";

import {
  MAX_AGENT_STATE_CHARACTERS,
  parseWebSources,
} from "@repo/chat-engine/chat-history-shared";

import type { ModelMessage } from "ai";
import type { ChatToolActivity } from "@/lib/chat";
import { chatAttachmentAdapter, uploadChatFile } from "@/lib/chat-files-client";
import {
  MAX_CHAT_DOCUMENT_CONTEXT,
  MAX_CHAT_FILES_PER_MESSAGE,
  parseChatDocuments,
  type ChatDocument,
  type ChatFileInfo,
} from "@/lib/chat-files-shared";
import {
  ComposerFile,
  UploadedFile,
  MessageFileDownloads,
} from "@/components/chat-files";

import { toast } from "sonner";
import { chatRequestFailure } from "@/lib/chat-request-error";
import {
  readChatApiResponse,
  parseToolActivity,
  TOOL_ACTIVITY_LABELS,
  type ChatApiStreamSnapshot,
} from "@/lib/chat-api-response";
import {
  composerUsageNote,
  formatResetTime,
  syncUsage,
  useUsage,
} from "@/lib/usage-client";
import {
  boundTemporaryChatHistory,
  compactInlineImageDataUris,
} from "@/lib/chat-history-bounds";

import {
  Component,
  createContext,
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import {
  AssistantRuntimeProvider,
  ActionBarPrimitive,
  ErrorPrimitive,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  useMessage,
  useThread,
  type ChatModelAdapter,
  type ThreadMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  Bot,
  Check,
  Copy,
  Loader2,
  Paperclip,
  Send,
  Sparkles,
  Square,
} from "lucide-react";
import { LandingHero } from "@/components/landing-hero";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { createOperationGuard } from "@/lib/operation-guard";
import { createSavedChatSession } from "@/lib/saved-chat-session";
import { refreshWorkspaceList } from "@/lib/use-workspace-list";
import {
  chatThreadOptions,
  type ChatThreadDetail,
  type ChatThreadMessage,
} from "@/lib/workspace-query-options";
import {
  hasPrivacyConsent,
  PRIVACY_CONSENT_EVENT,
} from "@/lib/privacy-consent";

type ChatApiMessage = {
  fileIds?: string[];
  documents?: ChatDocument[];
  role: "system" | "user" | "assistant";
  content: string;
  agentMessages?: unknown[];
  webSources?: ReturnType<typeof parseWebSources>;
};

/** Flatten runtime message parts into text, replacing binary media with compact placeholders. */
function extractMessageText(message: Pick<ThreadMessage, "content">): string {
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

/**
 * Temporary chat has no server-side history, so the tool exchange only survives to the next turn
 * if the browser sends it back. Bounded here as well as on the server: an oversized transcript
 * should cost its own replay, not 413 the whole request.
 */
function readAgentMessages(message: ThreadMessage): ModelMessage[] | undefined {
  const custom = (
    message.metadata as { custom?: { agentMessages?: unknown } } | undefined
  )?.custom;
  const agentMessages = custom?.agentMessages;
  if (!Array.isArray(agentMessages) || !agentMessages.length) return undefined;
  return JSON.stringify(agentMessages).length <= MAX_AGENT_STATE_CHARACTERS
    ? (agentMessages as ModelMessage[])
    : undefined;
}

/** Serialize history, prioritizing newest documents within temporary transport and text budgets. */
function toApiMessages(
  messages: readonly ThreadMessage[],
  preparedFiles: ReadonlyMap<string, ChatDocument | ChatFileInfo>,
  scope: string,
  temporary: boolean,
): ChatApiMessage[] {
  let documentCharacters = 0;
  const selectedDocuments = new Set<string>();
  const messageFiles = (message: ThreadMessage) =>
    message.role === "user"
      ? message.attachments.flatMap((attachment) => {
          const file = preparedFiles.get(`${scope}:${attachment.id}`);
          return file ? [file] : [];
        })
      : temporary
        ? parseChatDocuments(message.metadata.custom?.documents)
        : [];
  for (const message of [...messages].reverse()) {
    for (const file of messageFiles(message)) {
      if (
        file &&
        "text" in file &&
        !selectedDocuments.has(file.id) &&
        documentCharacters + file.text.length <= MAX_CHAT_DOCUMENT_CONTEXT
      ) {
        selectedDocuments.add(file.id);
        documentCharacters += file.text.length;
      }
    }
  }
  return boundTemporaryChatHistory(
    messages
      .slice(-30)
      .map((message) => {
        const agentMessages =
          message.role === "assistant" ? readAgentMessages(message) : undefined;
        const files = messageFiles(message);
        return {
          role: message.role,
          content:
            extractMessageText(message) ||
            (files.length ? "Please read the attached files." : ""),
          ...(temporary
            ? {
                documents: files.filter(
                  (file): file is ChatDocument =>
                    "text" in file && selectedDocuments.has(file.id),
                ),
              }
            : files.length
              ? { fileIds: files.map((file) => file.id) }
              : {}),
          ...(agentMessages ? { agentMessages } : {}),
          webSources: parseWebSources(
            (
              message.metadata as
                { custom?: { webSources?: unknown } } | undefined
            )?.custom?.webSources,
          ),
        };
      })
      .filter((message) => message.content.length > 0),
  );
}

/** Show request failures with sign-in or quota-aware retry controls. */
function ChatMessageError() {
  const failure = useMessage((state) => state.metadata.custom?.requestError) as
    ReturnType<typeof chatRequestFailure> | undefined;
  const [now, setNow] = useState(Date.now);
  const retryAt = failure?.retryAt ?? 0;
  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= retryAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
  return (
    <div
      role="alert"
      className="mt-4 space-y-3 rounded-card border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm"
    >
      <p className="text-destructive">
        <ErrorPrimitive.Message />
      </p>
      {failure?.status === 401 ? (
        <Button asChild variant="outline" size="sm">
          <a href="/sign-in">Sign in</a>
        </Button>
      ) : (
        <ActionBarPrimitive.Reload asChild>
          <Button variant="outline" size="sm" disabled={remaining > 0}>
            {/* An hourly or daily limit can be far off; name the time rather than count seconds. */}
            {remaining > 90
              ? `Retry at ${formatResetTime(retryAt, now)}`
              : remaining > 0
                ? `Retry in ${remaining}s`
                : "Retry"}
          </Button>
        </ActionBarPrimitive.Reload>
      )}
    </div>
  );
}

/** Label current tools while retaining compatibility with legacy search-only activity rows. */
function describeToolActivity(activity: ChatToolActivity): string {
  // Rows saved before other tools existed carry no tool name and were always searches.
  const label =
    TOOL_ACTIVITY_LABELS[activity.tool ?? "search_web"][activity.status];
  return activity.query ? `${label}: ${activity.query}` : label;
}

/** Restore saved messages, attachment links, and model metadata into assistant-ui's runtime. */
function toRuntimeMessages(messages: ChatThreadMessage[]): ThreadMessageLike[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: new Date(message.createdAt),
    ...(message.role === "user" && message.files?.length
      ? {
          attachments: message.files.map((file) => ({
            id: file.id,
            type: "document",
            name: file.name,
            contentType: file.mediaType,
            status: { type: "complete" as const },
            content: [{ type: "text" as const, text: file.url ?? "" }],
          })),
        }
      : {}),
    // Re-attach the persisted generating model/provider so the "generated by" label renders for
    // saved messages exactly as it did live during streaming.
    ...(message.role === "assistant" &&
    (message.model || message.provider || message.files?.length)
      ? {
          metadata: {
            custom: {
              model: message.model ?? null,
              provider: message.provider ?? null,
              toolActivity: parseToolActivity(message.toolActivity),
              files: message.files ?? [],
            },
          },
        }
      : {}),
  }));
}

/** Preserve the user's whitespace without interpreting their message as Markdown. */
const UserTextPart = () => (
  <MessagePartPrimitive.Text
    component="p"
    className="whitespace-pre-wrap text-sm leading-relaxed"
  />
);

// The markdown renderer (remark, rehype, KaTeX and its stylesheet) loads with the first assistant
// reply, so the landing and dashboard first paint do not ship it.
const MarkdownSourceContext = createContext("");

/** Keep assistant text readable while the Markdown chunk loads or after a chunk failure. */
function PlainMarkdownSource() {
  const markdown = useContext(MarkdownSourceContext);
  return (
    <p className="whitespace-pre-wrap break-words">
      {compactInlineImageDataUris(markdown)}
    </p>
  );
}

const ChatMarkdownBlocks = dynamic(() => import("@/components/chat-markdown"), {
  ssr: false,
  loading: PlainMarkdownSource,
});

// A tab left open across a deploy can 404 the lazy chunk; keep the reply readable as plain text.
class MarkdownChunkBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <PlainMarkdownSource /> : this.props.children;
  }
}

/** Style assistant Markdown and retain a plain-text fallback across lazy chunk failures. */
const MarkdownMessage = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<"div">
>(({ children, className, ...props }, ref) => {
  const markdown =
    typeof children === "string" ? children : String(children ?? "");

  return (
    <div
      ref={ref}
      className={cn(
        "text-sm leading-relaxed prose prose-sm prose-dala max-w-none text-foreground",
        "prose-headings:font-normal prose-headings:tracking-tight",
        "prose-h1:text-xl prose-h2:text-lg prose-h3:text-base",
        "prose-a:underline-offset-4 hover:prose-a:text-highlight/80",
        "prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:bg-muted prose-code:text-subtle-foreground prose-code:font-mono prose-code:text-[0.85em]",
        "prose-pre:border prose-pre:rounded-card prose-pre:p-4",
        "prose-blockquote:border-l-2 prose-blockquote:border-primary prose-blockquote:pl-4 prose-blockquote:font-extralight prose-blockquote:not-italic",
        "prose-table:border-collapse prose-table:w-full",
        "prose-th:border-b prose-th:px-4 prose-th:py-2 prose-th:text-left",
        "prose-td:border-b prose-td:border-border/50 prose-td:px-4 prose-td:py-2",
        "prose-hr:my-8 prose-hr:border-border/50",
        "[&_.katex-display>.katex]:inline-block [&_.katex-display>.katex]:min-w-full [&_.katex-display]:my-4 [&_.katex-display]:overflow-x-auto",
        className,
      )}
      {...props}
    >
      <MarkdownSourceContext.Provider value={markdown}>
        <MarkdownChunkBoundary>
          <ChatMarkdownBlocks markdown={markdown} />
        </MarkdownChunkBoundary>
      </MarkdownSourceContext.Provider>
    </div>
  );
});

MarkdownMessage.displayName = "MarkdownMessage";

/** Render assistant content directly so streamed deltas do not receive a second smoothing delay. */
const AssistantTextPart = () => (
  <MessagePartPrimitive.Text component={MarkdownMessage} smooth={false} />
);

/** Drop a trailing ":free" tier suffix for readability (e.g. OpenRouter "...:free" models). */
function formatModelLabel(model: string): string {
  return model.replace(/:free$/i, "");
}

/** Show the model recorded on completion, including fallback models chosen by the provider. */
const AssistantModelLabel = () => {
  const model = useMessage((message) => {
    const custom = (
      message.metadata as { custom?: { model?: unknown } } | undefined
    )?.custom;
    return typeof custom?.model === "string" && custom.model.trim()
      ? custom.model
      : null;
  });

  if (!model) {
    return null;
  }

  return (
    <span className="truncate text-xs text-muted-foreground" title={model}>
      {formatModelLabel(model)}
    </span>
  );
};

/** Announce validated tool progress, including document reads and file creation. */
const SearchActivity = () => {
  const rawActivity = useMessage(
    (message) => message.metadata?.custom?.toolActivity,
  );
  const activities = parseToolActivity(rawActivity);
  if (!activities.length) return null;
  return (
    <div className="space-y-1 text-xs text-muted-foreground" aria-live="polite">
      {activities.map((activity) => (
        <div key={activity.id}>{describeToolActivity(activity)}</div>
      ))}
    </div>
  );
};

/** Copy the text representation, replacing generated image data with a compact placeholder. */
const MessageCopyButton = ({ className }: { className?: string }) => {
  const content = useMessage((message) => message.content);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  // Runs on every stream delta, so keep it to a scan; the full extraction happens only on click.
  const hasText = content.some(
    (part) =>
      (part.type === "text" || part.type === "reasoning") &&
      part.text.trim().length > 0,
  );
  if (!hasText) return null;

  const handleCopy = async () => {
    const text = extractMessageText({ content });
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Denied permission or a non-secure context; neither is recoverable from here.
      toast.error("Could not copy to the clipboard.");
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied to clipboard" : "Copy message"}
      title={copied ? "Copied" : "Copy"}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
};

/** Compose user attachments and assistant text, tool progress, downloads, and recovery controls. */
const ChatMessage = () => {
  return (
    <MessagePrimitive.Root className="group relative flex w-full flex-col gap-2 mb-6">
      <MessagePrimitive.If user>
        <div className="ml-auto flex max-w-[85%] flex-col items-end gap-1 md:max-w-[75%]">
          <div className="relative flex w-full items-end gap-2">
            <div className="flex w-full flex-col gap-1 rounded-card rounded-br-[6px] bg-secondary px-5 py-3.5 text-secondary-foreground">
              <MessagePrimitive.Content components={{ Text: UserTextPart }} />
              <MessagePrimitive.Attachments
                components={{ Attachment: UploadedFile }}
              />
            </div>
          </div>
          <MessageCopyButton />
        </div>
      </MessagePrimitive.If>

      <MessagePrimitive.If assistant>
        <div className="mr-auto relative flex w-full flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 select-none items-center justify-center rounded-full border">
              <Bot className="h-4 w-4 text-primary" />
            </div>
            <AssistantModelLabel />
          </div>
          {/* Dala: assistant copy floats on the void — no bubble, border, or shadow. */}
          <div className="flex w-full flex-col gap-1 py-1 pl-10">
            <SearchActivity />
            <MessagePrimitive.Content
              components={{
                Text: AssistantTextPart,
                Reasoning: AssistantTextPart,
              }}
            />
            <MessageFileDownloads />
            <MessagePrimitive.Error>
              <ChatMessageError />
            </MessagePrimitive.Error>
          </div>
          <MessageCopyButton className="self-start" />
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
};

/** Start the landing composition at the top and follow new content only for conversations. */
function ChatViewport({ children }: { children: ReactNode }) {
  const hasMessages = useThread((state) => state.messages.length > 0);

  return (
    <ThreadPrimitive.Viewport
      autoScroll={hasMessages}
      scrollToBottomOnInitialize={hasMessages}
      scrollToBottomOnThreadSwitch={hasMessages}
      className="flex-1 overflow-y-auto px-4 py-6 scroll-smooth"
    >
      {children}
    </ThreadPrimitive.Viewport>
  );
}

const REPLY_END_ANNOUNCEMENTS: Partial<Record<string, string>> = {
  complete: "Reply ready",
  error: "Reply failed",
  cancelled: "Reply stopped",
};

/** Announce reply transitions without making the streamed transcript itself a live region. */
function ReplyStatusAnnouncer() {
  const replyId = useThread((state) => {
    const last = state.messages.at(-1);
    return last?.role === "assistant" ? last.id : null;
  });
  const replyStatus = useThread((state) => {
    const last = state.messages.at(-1);
    if (last?.role !== "assistant") return null;
    return last.status.type === "incomplete"
      ? last.status.reason
      : last.status.type;
  });
  const previousReplyRef = useRef({ id: replyId, status: replyStatus });
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const previous = previousReplyRef.current;
    previousReplyRef.current = { id: replyId, status: replyStatus };
    if (replyStatus === "running") {
      setAnnouncement("Generating reply");
    } else if (previous.status === "running") {
      // Hydrated history never passes through "running", and a thread switch mid-reply replaces the
      // running message, so only the reply that was streaming can announce how it ended.
      setAnnouncement(
        previous.id === replyId
          ? (REPLY_END_ANNOUNCEMENTS[replyStatus ?? ""] ?? "")
          : "",
      );
    }
  }, [replyId, replyStatus]);

  return (
    <div role="status" aria-live="polite" className="sr-only">
      {announcement}
    </div>
  );
}

type ChatPanelProps = {
  selectedThreadId?: string | null;
  onThreadSelected?: (threadId: string | null) => void;
  temporary?: boolean;
  temporarySessionKey?: number;
  landingHero?: boolean;
  initialPrompt?: string;
  active?: boolean;
  onContentChange?: (hasContent: boolean) => void;
};

/** Manage saved and temporary chat lifecycles, authenticated attachments, streaming, and cancellation. */
export function ChatPanel({
  selectedThreadId = null,
  onThreadSelected,
  temporary = false,
  temporarySessionKey = 0,
  landingHero = false,
  initialPrompt,
  active = true,
  onContentChange,
}: ChatPanelProps) {
  const { loading, user } = useAuth();
  const isLoaded = !loading;
  const queryClient = useQueryClient();
  // Only accounts have a reportable quota; anonymous temporary chat shows none.
  const usageQuery = useUsage(isLoaded && Boolean(user));
  const usageNote = composerUsageNote(usageQuery.data?.account);
  const quotaExhausted = usageQuery.data?.account.remaining === 0;
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [landingBackdrop, setLandingBackdrop] = useState<HTMLDivElement | null>(
    null,
  );
  const [persistenceWarning, setPersistenceWarning] = useState(false);
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreGuard] = useState(createOperationGuard);
  const [savedChatSession] = useState(() =>
    createSavedChatSession(async (id) => {
      const response = await fetch(
        `/api/chat/threads/${encodeURIComponent(id)}?onlyIfEmpty=1`,
        {
          method: "DELETE",
        },
      );
      if (response.ok) {
        queryClient.removeQueries({ queryKey: ["chat-thread", id] });
        void queryClient.invalidateQueries({ queryKey: ["chat-threads"] });
      }
    }),
  );
  const loadingOlderRef = useRef(false);
  const hydratedSignatureRef = useRef<string | null>(null);
  const initialPromptSignatureRef = useRef<string | null>(null);
  const newlyCreatedThreadIdsRef = useRef<Set<string>>(new Set());
  const previousActiveThreadIdRef = useRef<string | null>(null);
  const [attachmentAdapter] = useState(chatAttachmentAdapter);
  const preparedFilesRef = useRef(
    new Map<string, ChatDocument | ChatFileInfo>(),
  );
  useEffect(() => {
    preparedFilesRef.current.clear();
  }, [user?.id, temporarySessionKey]);

  useLayoutEffect(() => {
    savedChatSession.select(selectedThreadId, active && !temporary);
  }, [savedChatSession, selectedThreadId, active, temporary]);
  useLayoutEffect(
    () => () => savedChatSession.invalidate(),
    [savedChatSession],
  );

  useLayoutEffect(() => {
    restoreGuard.invalidate();
    setIsRestoring(false);
    return () => restoreGuard.invalidate();
  }, [
    activeThreadId,
    selectedThreadId,
    temporary,
    temporarySessionKey,
    restoreGuard,
  ]);

  useEffect(() => {
    if (!isLoaded) {
      setPrivacyAcknowledged(false);
      return;
    }

    const syncConsent = () => {
      setPrivacyAcknowledged(hasPrivacyConsent(user?.id));
    };
    syncConsent();
    window.addEventListener(PRIVACY_CONSENT_EVENT, syncConsent);
    return () => window.removeEventListener(PRIVACY_CONSENT_EVENT, syncConsent);
  }, [isLoaded, user?.id]);

  const activeThreadQuery = useQuery({
    ...chatThreadOptions(activeThreadId),
    enabled: !temporary && Boolean(activeThreadId),
  });

  useLayoutEffect(() => {
    if (temporary) {
      if (activeThreadId !== null) {
        setActiveThreadId(null);
      }
      return;
    }

    if (!selectedThreadId) {
      if (activeThreadId !== null) {
        setActiveThreadId(null);
      }
      return;
    }

    if (selectedThreadId !== activeThreadId) {
      setActiveThreadId(selectedThreadId);
    }
  }, [activeThreadId, selectedThreadId, temporary]);

  const chatModel = useMemo<ChatModelAdapter>(
    () => ({
      run: async function* ({ messages, abortSignal }) {
        if (!privacyAcknowledged) {
          throw new Error(
            "Accept the privacy notice before sending chat messages.",
          );
        }

        if (!temporary) {
          setPersistenceWarning(false);
        }

        let threadId = activeThreadId;
        const savedRun = temporary
          ? null
          : savedChatSession.beginRun(abortSignal);
        const assertCurrent = () => {
          abortSignal.throwIfAborted();
          savedRun?.assertCurrent();
        };
        if (savedRun) {
          let creationFailure: ReturnType<typeof chatRequestFailure> | null =
            null;
          try {
            threadId = await savedRun.resolveThread(async () => {
              const createThreadResponse = await fetch("/api/chat/threads", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({}),
              });
              const createPayload = (await createThreadResponse
                .json()
                .catch(() => null)) as {
                data?: { id?: string };
                error?: string;
              } | null;

              if (!createThreadResponse.ok) {
                creationFailure = chatRequestFailure(
                  createPayload,
                  createThreadResponse.status,
                  createThreadResponse.headers.get("Retry-After"),
                );
                throw new Error(creationFailure.message);
              }
              if (!createPayload?.data?.id) {
                throw new Error(
                  createPayload?.error || "Failed to create chat thread.",
                );
              }

              return createPayload.data.id;
            });
          } catch (error) {
            assertCurrent();
            if (creationFailure) {
              yield { metadata: { custom: { requestError: creationFailure } } };
            }
            throw error;
          }
          assertCurrent();
        }
        if (!temporary && threadId && threadId !== activeThreadId) {
          newlyCreatedThreadIdsRef.current.add(threadId);
          setActiveThreadId(threadId);
          onThreadSelected?.(threadId);
          void refreshWorkspaceList(
            queryClient,
            "chat-threads",
            "/chat/threads",
          ).catch(() => {});
        }

        // Saved-thread history is reconstructed from the database; submit only the new user turn.
        // Slice before mapping — toApiMessages runs image-data-URI compaction over every message,
        // so mapping the full history first would scan megabytes of base64 only to discard it.
        const scope = `${user?.id}:${temporary ? `temporary:${temporarySessionKey}` : threadId}`;
        const latestMessage = messages.at(-1);
        const attachments =
          latestMessage?.role === "user"
            ? (latestMessage.attachments ?? [])
            : [];
        if (attachments.length > MAX_CHAT_FILES_PER_MESSAGE)
          throw new Error("Attach at most four files per message.");
        if (attachments.length && !user)
          throw new Error("Sign in to attach files.");
        for (const attachment of attachments) {
          assertCurrent();
          const key = `${scope}:${attachment.id}`;
          if (!preparedFilesRef.current.has(key)) {
            if (!attachment.file)
              throw new Error("Reattach the file before sending it again.");
            const file = await uploadChatFile(
              attachment.file,
              temporary ? null : threadId,
              abortSignal,
            );
            assertCurrent();
            preparedFilesRef.current.set(key, file);
          }
        }
        const attachedText = attachments.reduce((total, attachment) => {
          const file = preparedFilesRef.current.get(
            `${scope}:${attachment.id}`,
          );
          return total + (file && "text" in file ? file.text.length : 0);
        }, 0);
        if (attachedText > MAX_CHAT_DOCUMENT_CONTEXT)
          throw new Error(
            "Attach at most 400,000 extracted characters per message.",
          );
        const payloadMessages = toApiMessages(
          temporary ? messages : messages.slice(-1),
          preparedFilesRef.current,
          scope,
          temporary,
        );

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            threadId: temporary ? undefined : threadId,
            messages: payloadMessages,
            temporary,
            stream: true,
          }),
          signal: abortSignal,
        });
        assertCurrent();

        if (!response.ok) {
          const failure = chatRequestFailure(
            await response.json().catch(() => null),
            response.status,
            response.headers.get("Retry-After"),
          );
          assertCurrent();
          // Any failure may follow admission (e.g. a provider error before streaming), so refresh
          // usage for all of them; 429s also carry the current quota.
          void syncUsage(queryClient, failure.quota);
          yield { metadata: { custom: { requestError: failure } } };
          throw new Error(failure.message);
        }

        let completedSnapshot: ChatApiStreamSnapshot | null = null;

        // An admitted request counts against the hourly quota however it ends.
        try {
          for await (const snapshot of readChatApiResponse(
            response,
            abortSignal,
          )) {
            assertCurrent();
            completedSnapshot = snapshot.done ? snapshot : completedSnapshot;
            yield {
              content: [{ type: "text", text: snapshot.message }] as const,
              status: snapshot.done
                ? ({ type: "complete", reason: "stop" } as const)
                : undefined,
              metadata: {
                custom: {
                  provider: snapshot.provider ?? null,
                  model: snapshot.model ?? null,
                  toolActivity: snapshot.toolActivity ?? [],
                  // Retained so the next temporary turn can replay this turn's tool exchange.
                  agentMessages: snapshot.agentMessages ?? [],
                  webSources: snapshot.webSources ?? [],
                  files: snapshot.files ?? [],
                  documents: snapshot.documents ?? [],
                },
              },
            };
          }
        } finally {
          void syncUsage(queryClient, completedSnapshot?.quota);
        }

        assertCurrent();
        if (!completedSnapshot) {
          throw new Error("Chat stream ended before completion.");
        }

        if (!temporary) {
          setPersistenceWarning(completedSnapshot.persisted === false);
          if (completedSnapshot.persisted !== false) {
            void refreshWorkspaceList(
              queryClient,
              "chat-threads",
              "/chat/threads",
            ).catch(() => {});
          }
          if (
            completedSnapshot.persisted !== false &&
            completedSnapshot.storedMessages?.length
          ) {
            const stored = completedSnapshot.storedMessages;
            queryClient.setQueryData<ChatThreadDetail>(
              ["chat-thread", threadId],
              (previous) => {
                const ids = new Set(stored.map((message) => message.id));
                const messages = [
                  ...(previous?.messages ?? []).filter(
                    (message) => !ids.has(message.id),
                  ),
                  ...stored,
                ];
                hydratedSignatureRef.current = `${threadId}:${messages.length}:${messages.at(-1)?.id ?? "none"}`;
                return {
                  id: threadId!,
                  title: previous?.title ?? "Chat",
                  hasMore: previous?.hasMore ?? false,
                  messages,
                };
              },
            );
          }
        }
      },
    }),
    [
      activeThreadId,
      onThreadSelected,
      privacyAcknowledged,
      queryClient,
      savedChatSession,
      temporary,
      temporarySessionKey,
      user,
    ],
  );

  const runtime = useLocalRuntime(chatModel, {
    adapters: { attachments: attachmentAdapter },
  });
  useEffect(() => {
    if (!active) runtime.thread.cancelRun();
  }, [active, runtime]);
  useEffect(() => {
    if (!onContentChange) return;
    const update = () =>
      onContentChange(
        runtime.thread.getState().messages.length > 0 ||
          Boolean(runtime.thread.composer.getState().text.trim()) ||
          runtime.thread.composer.getState().attachments.length > 0,
      );
    update();
    const stopThread = runtime.thread.subscribe(update);
    const stopComposer = runtime.thread.composer.subscribe(update);
    return () => {
      stopThread();
      stopComposer();
    };
  }, [runtime, onContentChange]);
  const isHydratingThread =
    !temporary &&
    activeThreadId !== null &&
    activeThreadQuery.isLoading &&
    !newlyCreatedThreadIdsRef.current.has(activeThreadId);
  const isThreadUnavailable =
    !temporary &&
    activeThreadId !== null &&
    activeThreadQuery.isLoadingError &&
    !newlyCreatedThreadIdsRef.current.has(activeThreadId);

  useEffect(() => {
    setPersistenceWarning(false);
  }, [activeThreadId, temporary]);

  useEffect(() => {
    const previousThreadId = previousActiveThreadIdRef.current;
    if (previousThreadId && previousThreadId !== activeThreadId) {
      // The marker only protects the in-memory first turn while its new thread is selected. Once
      // the user leaves, an empty canonical thread must hydrate as empty when they return.
      newlyCreatedThreadIdsRef.current.delete(previousThreadId);
    }
    previousActiveThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  useEffect(() => {
    if (!temporary) {
      return;
    }

    const signature = `temporary:${temporarySessionKey}`;
    if (hydratedSignatureRef.current === signature) {
      return;
    }

    runtime.thread.cancelRun();
    runtime.thread.reset([]);
    void runtime.thread.composer.reset();
    hydratedSignatureRef.current = signature;
    newlyCreatedThreadIdsRef.current.clear();
  }, [runtime, temporary, temporarySessionKey]);

  useEffect(() => {
    const prompt = initialPrompt?.trim();
    if (!temporary || !prompt || !privacyAcknowledged) return;
    const signature = `temporary-prompt:${prompt}`;
    let canceled = false;
    // A URL supplies a draft; only the user can submit it. Defer past Strict Mode replay.
    queueMicrotask(() => {
      if (canceled || initialPromptSignatureRef.current === signature) return;
      initialPromptSignatureRef.current = signature;
      runtime.thread.composer.setText(prompt);
    });
    return () => {
      canceled = true;
    };
  }, [initialPrompt, privacyAcknowledged, runtime, temporary]);

  useEffect(() => {
    if (temporary) {
      return;
    }

    if (!activeThreadId) {
      runtime.thread.cancelRun();
      runtime.thread.reset([]);
      hydratedSignatureRef.current = null;
      return;
    }

    if (activeThreadQuery.isLoading) {
      if (newlyCreatedThreadIdsRef.current.has(activeThreadId)) {
        return;
      }

      runtime.thread.cancelRun();
      runtime.thread.reset([]);
      hydratedSignatureRef.current = `${activeThreadId}:loading`;
      return;
    }

    const thread = activeThreadQuery.data;
    if (!thread) return;

    const lastMessage = thread.messages[thread.messages.length - 1];
    const signature = `${thread.id}:${thread.messages.length}:${lastMessage?.id ?? "none"}`;
    const isNewlyCreatedThread = newlyCreatedThreadIdsRef.current.has(
      thread.id,
    );
    if (
      isNewlyCreatedThread &&
      (thread.messages.length === 0 || runtime.thread.getState().isRunning)
    ) {
      // The local first turn (including its retry/error state) owns the runtime until it finishes.
      hydratedSignatureRef.current = `${thread.id}:pending`;
      return;
    }

    if (hydratedSignatureRef.current === signature) {
      return;
    }

    runtime.thread.cancelRun();
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
    temporary,
  ]);

  useEffect(
    () => () => {
      runtime.thread.cancelRun();
    },
    [runtime],
  );

  const loadOlderMessages = async () => {
    const first = activeThreadQuery.data?.messages[0];
    if (
      !first ||
      !activeThreadId ||
      loadingOlderRef.current ||
      runtime.thread.getState().isRunning
    )
      return;
    loadingOlderRef.current = true;
    setIsLoadingOlder(true);
    try {
      const response = await fetch(
        `/api/chat/threads/${activeThreadId}?before=${first.position}`,
      );
      if (!response.ok) throw new Error("Could not load older messages");
      const { data } = (await response.json()) as { data: ChatThreadDetail };
      if (runtime.thread.getState().isRunning) return;
      queryClient.setQueryData<ChatThreadDetail>(
        ["chat-thread", activeThreadId],
        (previous) =>
          previous
            ? {
                ...previous,
                hasMore: data.hasMore,
                messages: [...data.messages, ...previous.messages],
              }
            : data,
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not load older messages",
      );
    } finally {
      loadingOlderRef.current = false;
      setIsLoadingOlder(false);
    }
  };

  const restorePersistedConversation = async () => {
    if (
      !activeThreadId ||
      activeThreadId !== selectedThreadId ||
      temporary ||
      isRestoring
    )
      return;
    const threadId = activeThreadId;
    const isCurrent = restoreGuard.begin();
    setIsRestoring(true);
    try {
      const result = await activeThreadQuery.refetch();
      if (!isCurrent()) return;
      if (result.isError) {
        toast.error(
          "Could not restore the saved conversation. Please try again.",
        );
        return;
      }
      if (!result.data || result.data.id !== threadId) return;

      const lastMessage = result.data.messages[result.data.messages.length - 1];
      runtime.thread.cancelRun();
      runtime.thread.reset(toRuntimeMessages(result.data.messages));
      hydratedSignatureRef.current = `${result.data.id}:${result.data.messages.length}:${lastMessage?.id ?? "none"}`;
      newlyCreatedThreadIdsRef.current.delete(result.data.id);
      setPersistenceWarning(false);
    } finally {
      if (isCurrent()) setIsRestoring(false);
    }
  };

  const composerDisabled =
    !privacyAcknowledged ||
    isLoadingOlder ||
    isHydratingThread ||
    isThreadUnavailable ||
    persistenceWarning;

  return (
    <Card
      className={cn(
        "relative isolate flex h-full min-h-0 w-full flex-col overflow-hidden rounded-none border-0 bg-transparent",
      )}
    >
      {landingHero ? (
        // Landing constellation layer: spans the slides and the composer, behind both.
        <div
          ref={setLandingBackdrop}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10"
        />
      ) : null}
      <CardContent className="flex h-full min-h-0 flex-1 flex-col p-0 sm:p-0">
        <AssistantRuntimeProvider runtime={runtime}>
          {!temporary && activeThreadQuery.data?.hasMore && (
            <Button
              variant="ghost"
              size="sm"
              disabled={isLoadingOlder}
              onClick={() => void loadOlderMessages()}
            >
              {isLoadingOlder ? "Loading…" : "Load older messages"}
            </Button>
          )}
          <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col overflow-hidden">
            <ReplyStatusAnnouncer />
            <ChatViewport>
              {isHydratingThread ? (
                <div className="flex h-full flex-col items-center justify-center space-y-4 pb-20 text-center">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  <div className="space-y-2 max-w-[400px]">
                    <h2 className="text-heading-2xs">Loading conversation</h2>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      Fetching the existing thread history before chat becomes
                      available.
                    </p>
                  </div>
                </div>
              ) : isThreadUnavailable ? (
                <div
                  className="flex h-full flex-col items-center justify-center space-y-4 pb-20 text-center"
                  role="alert"
                >
                  <div className="max-w-[400px] space-y-2">
                    <h2 className="text-heading-2xs">
                      Couldn&apos;t load this conversation
                    </h2>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {activeThreadQuery.error instanceof Error
                        ? activeThreadQuery.error.message
                        : "The conversation is unavailable right now."}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void activeThreadQuery.refetch()}
                  >
                    Try again
                  </Button>
                </div>
              ) : (
                <>
                  <ThreadPrimitive.Empty>
                    {temporary && landingHero ? (
                      <LandingHero backdrop={landingBackdrop} />
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center space-y-4 text-center pb-20">
                        <Sparkles className="h-6 w-6 text-primary" />
                        <div className="space-y-2 max-w-[400px]">
                          <h2 className="text-heading-2xs">
                            How can I help you today?
                          </h2>
                          {!temporary ? (
                            <p className="text-sm text-muted-foreground leading-relaxed">
                              Start a conversation about reviewing your
                              contracts, spotting clauses, or navigating
                              negotiation points.
                            </p>
                          ) : (
                            <p className="text-sm text-muted-foreground leading-relaxed">
                              Temporary chat is not saved to your history.
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </ThreadPrimitive.Empty>

                  <div className="mx-auto w-full max-w-4xl">
                    <ThreadPrimitive.Messages
                      components={{ Message: ChatMessage }}
                    />
                  </div>
                </>
              )}
            </ChatViewport>

            <ComposerPrimitive.Root
              className="shrink-0 bg-transparent px-4 pb-2 pt-1 sm:px-6 sm:pb-3 sm:pt-2"
              // Enter submits the form directly, so the zero-quota guard sits here as well as on Send.
              onSubmit={(event) => {
                if (quotaExhausted) event.preventDefault();
              }}
            >
              {persistenceWarning && !temporary ? (
                <div
                  className="mx-auto mb-2 max-w-3xl rounded-card border border-highlight/40 bg-highlight/[0.06] px-4 py-3 text-sm text-foreground"
                  role="alert"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      This response could not be saved. Copy anything important,
                      then restore the saved conversation before continuing.
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isRestoring}
                      onClick={() => void restorePersistedConversation()}
                    >
                      {isRestoring ? "Restoring…" : "Restore saved chat"}
                    </Button>
                  </div>
                </div>
              ) : null}
              <div className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-card border border-input bg-popover p-2 transition-colors focus-within:border-primary/70">
                <ComposerPrimitive.AddAttachment asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    disabled={composerDisabled || !user}
                    title={
                      user
                        ? "Attach PDF, TXT, or DOCX (4 MB each)"
                        : "Sign in to attach files"
                    }
                  >
                    <Paperclip className="h-4 w-4" />
                    <span className="sr-only">Attach files</span>
                  </Button>
                </ComposerPrimitive.AddAttachment>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap gap-2 px-2">
                    <ComposerPrimitive.Attachments
                      components={{ Attachment: ComposerFile }}
                    />
                  </div>
                  <ComposerPrimitive.Input
                    className={cn(
                      "block min-h-9 max-h-60 w-full resize-none bg-transparent px-2 py-[7px] text-[15px] leading-[22px] text-foreground outline-none",
                      "placeholder:text-muted-foreground",
                      "composer-input-no-scrollbar",
                    )}
                    aria-label="Chat message"
                    disabled={composerDisabled}
                    placeholder={
                      isHydratingThread
                        ? "Loading conversation..."
                        : isThreadUnavailable
                          ? "Conversation unavailable"
                          : "Ask SignLoop..."
                    }
                    submitMode="enter"
                    rows={1}
                  />
                </div>

                <div className="flex shrink-0">
                  <ThreadPrimitive.If running={false}>
                    <ComposerPrimitive.Send asChild>
                      <Button
                        type="button"
                        size="icon"
                        disabled={composerDisabled || quotaExhausted}
                        className="h-9 w-9 shrink-0"
                      >
                        <Send className="h-4 w-4" />
                        <span className="sr-only">Send message</span>
                      </Button>
                    </ComposerPrimitive.Send>
                  </ThreadPrimitive.If>

                  <ThreadPrimitive.If running>
                    <ComposerPrimitive.Cancel asChild>
                      <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        className="h-9 w-9 shrink-0"
                      >
                        <Square className="h-4 w-4 fill-current" />
                        <span className="sr-only">Cancel generation</span>
                      </Button>
                    </ComposerPrimitive.Cancel>
                  </ThreadPrimitive.If>
                </div>
              </div>
              <div className="mx-auto mt-2 max-w-3xl text-center text-caption text-muted-foreground">
                {isHydratingThread
                  ? "Conversation history is loading. Sending is disabled until it finishes."
                  : temporary
                    ? "Temporary chat is not saved. AI may produce inaccurate information."
                    : "AI may produce inaccurate information about laws or guidelines. Keep original records."}
                {usageNote ? " · " : null}
                {/* Rendered while empty so the count is announced when it first appears. */}
                <span aria-live="polite">{usageNote}</span>
              </div>
            </ComposerPrimitive.Root>
          </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
      </CardContent>
    </Card>
  );
}
