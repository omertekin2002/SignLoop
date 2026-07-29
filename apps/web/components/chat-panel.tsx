"use client";

import {
  forwardRef,
  memo,
  type ComponentPropsWithoutRef,
  type ReactNode,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/nextjs";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  useMessage,
  type ChatModelAdapter,
  type ThreadMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  Bot,
  Download,
  FileText,
  Image as ImageIcon,
  Loader2,
  MessagesSquare,
  Send,
  Sparkles,
  Square,
} from "lucide-react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { marked } from "marked";
import { NumberTicker } from "@/components/number-ticker";
import { TypingAnimation } from "@/components/typing-animation";
import { AnimatedGridPattern } from "@/components/ui/animated-grid-pattern";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { compactInlineImageDataUris } from "@/lib/chat-policy";
import { cn, isRecord } from "@/lib/utils";
import {
  hasPrivacyConsent,
  PRIVACY_CONSENT_EVENT,
} from "@/lib/privacy-consent";
// KaTeX styles are only needed where assistant markdown can render math, which is here.
// Scoped to this client component so the ~24KB stylesheet no longer loads on every route.
import "katex/dist/katex.min.css";

const landingStats = [
  {
    label: "Contracts Analyzed",
    value: 150,
    icon: FileText,
  },
  {
    label: "Chat Interactions",
    value: 2000,
    icon: MessagesSquare,
  },
] as const;

type ChatApiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatApiSuccess = {
  message: string;
  provider?: string;
  model?: string;
  persisted?: boolean;
};

type ChatApiStreamEvent =
  | {
      type: "delta";
      text: string;
    }
  | ({
      type: "done";
    } & ChatApiSuccess)
  | {
      type: "error";
      error: string;
    };

type ChatApiStreamSnapshot = ChatApiSuccess & {
  done: boolean;
};

type ChatCapabilities = {
  imageGenerationAvailable: boolean;
  imageGenerationModel: string | null;
};

type ChatThreadMessage = {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  createdAt: string;
  model?: string | null;
  provider?: string | null;
};

type ChatThreadDetail = {
  id: string;
  title: string;
  messages: ChatThreadMessage[];
};

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
  if (
    isRecord(payload) &&
    typeof payload.error === "string" &&
    payload.error.trim()
  ) {
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
    provider:
      typeof payload.provider === "string" ? payload.provider : undefined,
    model: typeof payload.model === "string" ? payload.model : undefined,
    persisted:
      typeof payload.persisted === "boolean" ? payload.persisted : undefined,
  };
}

function parseStreamEvent(payload: unknown): ChatApiStreamEvent {
  if (!isRecord(payload) || typeof payload.type !== "string") {
    throw new Error("Chat stream included an invalid event.");
  }

  if (payload.type === "delta") {
    return {
      type: "delta",
      text: typeof payload.text === "string" ? payload.text : "",
    };
  }

  if (payload.type === "done") {
    return {
      type: "done",
      ...parseSuccess(payload),
    };
  }

  if (payload.type === "error") {
    return {
      type: "error",
      error:
        typeof payload.error === "string" && payload.error.trim()
          ? payload.error
          : "Chat request failed.",
    };
  }

  throw new Error(`Unknown chat stream event: ${payload.type}`);
}

function parseJsonPayload(rawPayload: string): unknown {
  if (!rawPayload) {
    return null;
  }

  try {
    return JSON.parse(rawPayload);
  } catch {
    return null;
  }
}

async function* readChatApiResponse(
  response: Response,
): AsyncGenerator<ChatApiStreamSnapshot> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (
    !response.ok ||
    !response.body ||
    !contentType.includes("application/x-ndjson")
  ) {
    const parsedPayload = parseJsonPayload(await response.text());

    if (!response.ok) {
      throw new Error(parseError(parsedPayload, response.status));
    }

    yield {
      ...parseSuccess(parsedPayload),
      done: true,
    };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedMessage = "";

  // The `finally` releases the reader on every exit path — normal completion, a thrown stream
  // error, and (importantly) the implicit generator return when the consumer aborts mid-turn.
  // Without it the ReadableStream stays locked with unread bytes until GC.
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
      }
      if (done) {
        buffer += decoder.decode();
      }

      const lines = buffer.split("\n");
      buffer = done ? "" : (lines.pop() ?? "");

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Use the safe parser: an intermediary (CDN/proxy) keep-alive or comment line that survives
        // the split is non-JSON and would otherwise throw here and abort an already-streaming turn.
        const parsed = parseJsonPayload(trimmed);
        if (parsed === null) continue;

        const event = parseStreamEvent(parsed);

        if (event.type === "error") {
          throw new Error(event.error);
        }

        if (event.type === "delta") {
          if (!event.text) continue;
          accumulatedMessage += event.text;
          yield {
            message: accumulatedMessage,
            done: false,
          };
          continue;
        }

        yield {
          ...event,
          message: event.message || accumulatedMessage,
          done: true,
        };
        return;
      }

      if (done) {
        break;
      }
    }

    // Only reachable via the `break` above: the stream ended without a terminal event. The
    // success path returns from inside the loop.
    throw new Error("Chat stream ended before completion.");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function toRuntimeMessages(messages: ChatThreadMessage[]): ThreadMessageLike[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: new Date(message.createdAt),
    // Re-attach the persisted generating model/provider so the "generated by" label renders for
    // saved messages exactly as it did live during streaming.
    ...(message.role === "assistant" && (message.model || message.provider)
      ? {
          metadata: {
            custom: {
              model: message.model ?? null,
              provider: message.provider ?? null,
            },
          },
        }
      : {}),
  }));
}

function createRuntimeMessage(
  role: "user" | "assistant",
  content: string,
  idPrefix: string,
): ThreadMessageLike {
  return {
    id: `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: new Date(),
  };
}

const UserTextPart = () => (
  <MessagePartPrimitive.Text
    component="p"
    className="whitespace-pre-wrap text-sm leading-relaxed"
  />
);

function looksLikeMathContent(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  if (/^\d+$/.test(text)) return false;
  // Bracketed legal alternatives such as "[Buyer/Seller]" are placeholders, not equations.
  if (/^[A-Za-z][A-Za-z .'-]{1,}(?:\/[A-Za-z][A-Za-z .'-]{1,})+$/.test(text)) {
    return false;
  }

  return /\\[a-zA-Z]+|[{}^_=]|[+\-*/<>]=?|(?:\d+\s*[a-zA-Z])|(?:[a-zA-Z]\s*\d)/.test(
    text,
  );
}

function normalizeMathNotation(raw: string): string {
  let text = raw;

  // Support LaTeX-style delimiters.
  text = text.replace(
    /\\\[((?:.|\n)*?)\\\]/g,
    (_match, expression) => `\n$$\n${expression.trim()}\n$$\n`,
  );
  text = text.replace(
    /\\\(((?:.|\n)*?)\\\)/g,
    (_match, expression) => `$${expression.trim()}$`,
  );

  // Support bracketed display math often returned by models: [ ... ]
  text = text.replace(
    /(^|[\s:])\[([^\]\n]{2,320})\](?=$|[\s,.;:!?])/g,
    (full, prefix: string, expression: string) => {
      if (!looksLikeMathContent(expression)) return full;
      return `${prefix}\n$$\n${expression.trim()}\n$$\n`;
    },
  );

  return text;
}

function toMarkdownText(children: ReactNode): string {
  const text = typeof children === "string" ? children : String(children ?? "");
  return normalizeMathNotation(text.replace(/<br\s*\/?>/gi, "\n"));
}

function markdownUrlTransform(url: string): string {
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(url)) {
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

const MarkdownImage = ({
  src,
  alt,
  className,
  // react-markdown passes the hast node down to custom components. Pull it out of the rest so it
  // isn't spread onto the real <img>, where React would serialize it as node="[object Object]".
  node: _node,
  ...props
}: MarkdownImageProps & { node?: unknown }) => {
  if (typeof src !== "string" || !src) {
    return null;
  }

  const isInlineImage =
    /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(src) ||
    /^blob:/i.test(src);

  // Model-authored remote image URLs must not become automatic browser requests. A non-anchor
  // placeholder also stays valid when Markdown wraps the image in a link.
  if (!isInlineImage) {
    return (
      <span className="break-all text-sm text-muted-foreground">
        {alt?.trim() ? `Linked image (${alt.trim()}): ` : "Linked image: "}
        {src}
      </span>
    );
  }

  return (
    <span className="group relative my-4 block w-fit max-w-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt ?? "Generated image"}
        className={cn(
          "max-h-[32rem] w-auto max-w-full rounded-xl border object-contain shadow-sm",
          className,
        )}
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

// Hoisted so the plugin arrays keep a stable identity across every block render.
const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

// Split the accumulated markdown into top-level blocks (paragraphs, headings, fenced code,
// tables, whole lists, …). `marked.lexer` keeps each block's source in `token.raw`, and the
// raw strings of completed leading blocks stay byte-for-byte identical as more text streams
// in — only the trailing, still-growing block changes. That's what makes per-block memoization
// avoid the O(n²) re-parse of the whole string on every NDJSON delta.
//
// Tradeoff (inherent to block-level memoization): a reference-style link/footnote whose
// definition lands in a different block won't resolve, since each block is parsed in isolation.
// Chat models emit inline links, so this practically never bites; everything else — GFM tables,
// loose/ordered lists, fenced code with blank lines, KaTeX `$...$`/`$$...$$` — stays intact
// because the lexer never splits inside those constructs.
function parseMarkdownIntoBlocks(markdown: string): string[] {
  if (!markdown) return [];

  try {
    // The lexer emits a `space` token for every blank line between blocks — roughly half of all
    // tokens. Each one would otherwise mount a full ReactMarkdown instance (remark-parse →
    // remark-gfm → remark-math → rehype-katex → rehype-react) to render nothing. Blocks are parsed
    // in isolation anyway, so dropping the blank ones changes no output.
    return marked
      .lexer(markdown)
      .map((token) => token.raw)
      .filter((raw) => raw.trim().length > 0);
  } catch {
    // The lexer is tolerant of partial markdown, but never let a hiccup break rendering.
    return [markdown];
  }
}

// One block of already-split markdown. Memoized on its raw source so a block only re-parses
// (remark/rehype/KaTeX) when its own text changes — settled blocks are skipped entirely.
const MarkdownBlock = memo(function MarkdownBlock({
  content,
}: {
  content: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={markdownUrlTransform}
      components={markdownComponents}
    >
      {content}
    </ReactMarkdown>
  );
});

const MarkdownMessage = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<"div">
>(({ children, className, ...props }, ref) => {
  // While streaming, `children` is the cumulative message text, so it changes on every delta and
  // this memo always misses — re-lexing the whole message (plus four full-string regex passes) per
  // token, which is O(n^2) over a turn. Deferring lets React skip intermediate parses under load
  // and keep the newest text; settled messages are unaffected because the value stops changing.
  const deferredChildren = useDeferredValue(children);
  const blocks = useMemo(
    () => parseMarkdownIntoBlocks(toMarkdownText(deferredChildren)),
    [deferredChildren],
  );

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
      {blocks.map((block, index) => (
        // Blocks are append-only while streaming (earlier blocks never reorder), so the index
        // is a stable key.
        <MarkdownBlock key={index} content={block} />
      ))}
    </div>
  );
});

MarkdownMessage.displayName = "MarkdownMessage";

const AssistantTextPart = () => (
  <MessagePartPrimitive.Text component={MarkdownMessage} smooth={false} />
);

// Drop a trailing ":free" tier suffix for readability (e.g. OpenRouter "...:free" models).
function formatModelLabel(model: string): string {
  return model.replace(/:free$/i, "");
}

// Shows the model that actually generated the assistant message, read from the metadata the
// server attaches on completion. Reflects an OpenRouter fallback model when the primary failed.
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
        <div className="mr-auto relative flex w-full flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 select-none items-center justify-center rounded-lg border bg-background shadow-sm">
              <Bot className="h-4 w-4 text-foreground/80" />
            </div>
            <AssistantModelLabel />
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

function LandingHeroEmpty() {
  const [isHeroTitleComplete, setIsHeroTitleComplete] = useState(false);

  return (
    <div className="relative -mx-4 -my-6 flex min-h-[calc(100vh-8.5rem)] flex-col overflow-hidden px-4 py-12 text-center sm:px-8 lg:py-16">
      <section className="mx-auto flex w-full max-w-[980px] flex-1 flex-col items-center justify-center gap-7">
        <div className="inline-flex items-center rounded-full border border-white/40 bg-white/50 px-3 py-1 text-sm font-medium text-slate-950 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/10 dark:text-white">
          <span className="mr-2 flex h-2 w-2 rounded-full bg-slate-700/70 dark:bg-white/60" />
          SignLoop is now in Beta
        </div>

        <div className="space-y-5">
          <h1 className="min-h-[5em] whitespace-pre-wrap bg-gradient-to-br from-indigo-950 to-slate-700 bg-clip-text pb-3 font-[family-name:var(--font-eb-garamond)] text-4xl font-normal leading-normal tracking-tight text-transparent drop-shadow-sm dark:from-white dark:to-slate-300 sm:min-h-[2.5em] sm:text-5xl md:min-h-[2em] md:text-6xl lg:text-7xl">
            <TypingAnimation
              text={"Review contracts with precision.\nNot guesswork."}
              initialDelay={250}
              typeSpeed={40}
              persistCursor={false}
              onComplete={() => setIsHeroTitleComplete(true)}
              className="inline-block whitespace-pre-wrap bg-gradient-to-br from-indigo-950 to-slate-700 bg-clip-text pb-4 text-transparent dark:from-white dark:to-slate-300"
            />
          </h1>
          <div
            className={cn(
              "mx-auto min-h-[4rem] max-w-[720px] text-lg leading-relaxed text-slate-600 opacity-0 dark:text-slate-300 sm:text-xl",
              isHeroTitleComplete && "animate-fade-in-up",
            )}
            style={{ animationDelay: "0.1s" }}
          >
            <p>
              SignLoop combines document ingestion, structured analysis
              workflows, model routing, and chat into one legal workspace.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl pb-2">
        <div className="grid grid-cols-2 gap-4">
          {landingStats.map((stat, index) => (
            <div
              key={stat.label}
              className={cn(
                "flex flex-col items-center justify-center gap-5 opacity-0",
                isHeroTitleComplete && "animate-fade-in-up",
              )}
              style={{ animationDelay: index === 0 ? "0.25s" : "0.35s" }}
            >
              <div className="flex items-baseline gap-1 font-[family-name:var(--font-eb-garamond)] text-6xl font-normal leading-none tracking-normal text-slate-900/85 dark:text-white/90 sm:text-7xl md:text-8xl">
                <NumberTicker
                  start={isHeroTitleComplete}
                  delay={index * 140}
                  useGrouping={stat.value >= 1000}
                  value={stat.value}
                />
                <span className="ml-2 font-light text-slate-900/25 dark:text-white/20">
                  +
                </span>
              </div>
              <p className="text-xs font-medium uppercase tracking-[0.22em] text-slate-600 dark:text-slate-400 sm:text-sm">
                {stat.label}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function LandingGridBackdrop() {
  return (
    <>
      <AnimatedGridPattern
        width={38}
        height={38}
        numSquares={90}
        maxOpacity={0.14}
        duration={3.4}
        repeatDelay={0.8}
        className={cn(
          "-z-20 fill-slate-900/[0.045] stroke-slate-900/[0.07] dark:fill-white/[0.035] dark:stroke-white/[0.055]",
          "[mask-image:radial-gradient(720px_circle_at_center,white,transparent)]",
          "inset-x-0 inset-y-[-32%] h-[190%] skew-y-12",
        )}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_33%,rgba(255,218,185,0.55),rgba(255,218,185,0)_26%),radial-gradient(circle_at_27%_20%,rgba(125,149,255,0.35),rgba(125,149,255,0)_32%),radial-gradient(circle_at_76%_16%,rgba(217,139,255,0.30),rgba(217,139,255,0)_34%)] dark:bg-[radial-gradient(circle_at_50%_28%,rgba(80,62,137,0.28),rgba(80,62,137,0)_28%),radial-gradient(circle_at_25%_16%,rgba(42,84,143,0.30),rgba(42,84,143,0)_35%),radial-gradient(circle_at_80%_20%,rgba(96,50,108,0.26),rgba(96,50,108,0)_36%)]"
      />
    </>
  );
}

type ChatPanelProps = {
  selectedThreadId?: string | null;
  onThreadSelected?: (threadId: string | null) => void;
  temporary?: boolean;
  temporarySessionKey?: number;
  landingHero?: boolean;
  initialPrompt?: string;
};

export function ChatPanel({
  selectedThreadId = null,
  onThreadSelected,
  temporary = false,
  temporarySessionKey = 0,
  landingHero = false,
  initialPrompt,
}: ChatPanelProps) {
  const { isLoaded: isUserLoaded, user } = useUser();
  const queryClient = useQueryClient();
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [isRunningInitialPrompt, setIsRunningInitialPrompt] = useState(false);
  const [persistenceWarning, setPersistenceWarning] = useState(false);
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false);
  const [imageMode, setImageMode] = useState(false);
  const hydratedSignatureRef = useRef<string | null>(null);
  const initialPromptSignatureRef = useRef<string | null>(null);
  const newlyCreatedThreadIdsRef = useRef<Set<string>>(new Set());
  const previousActiveThreadIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isUserLoaded) {
      setPrivacyAcknowledged(false);
      return;
    }

    const syncConsent = () => {
      setPrivacyAcknowledged(hasPrivacyConsent(user?.id));
    };
    syncConsent();
    window.addEventListener(PRIVACY_CONSENT_EVENT, syncConsent);
    return () => window.removeEventListener(PRIVACY_CONSENT_EVENT, syncConsent);
  }, [isUserLoaded, user?.id]);

  const activeThreadQuery = useQuery({
    queryKey: ["chat-thread", activeThreadId],
    enabled: !temporary && Boolean(activeThreadId),
    queryFn: async () => {
      const response = await fetch(`/api/chat/threads/${activeThreadId}`);
      const payload = (await response.json().catch(() => null)) as {
        data?: ChatThreadDetail;
        error?: string;
      } | null;

      if (!response.ok || !payload?.data) {
        throw new Error(payload?.error || "Failed to fetch chat thread.");
      }

      return payload.data;
    },
  });

  const capabilitiesQuery = useQuery({
    queryKey: ["chat-capabilities"],
    queryFn: async (): Promise<ChatCapabilities> => {
      const response = await fetch("/api/chat", { cache: "no-store" });
      const payload = (await response
        .json()
        .catch(() => null)) as Partial<ChatCapabilities> | null;

      if (
        !response.ok ||
        typeof payload?.imageGenerationAvailable !== "boolean"
      ) {
        throw new Error("Failed to load chat capabilities.");
      }

      return {
        imageGenerationAvailable: payload.imageGenerationAvailable,
        imageGenerationModel:
          typeof payload.imageGenerationModel === "string"
            ? payload.imageGenerationModel
            : null,
      };
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const imageGenerationAvailable =
    capabilitiesQuery.data?.imageGenerationAvailable === true;

  useEffect(() => {
    if (!imageGenerationAvailable) {
      setImageMode(false);
    }
  }, [imageGenerationAvailable]);

  useEffect(() => {
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
        if (!temporary && !threadId) {
          const createThreadResponse = await fetch("/api/chat/threads", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
            signal: abortSignal,
          });
          const createPayload = (await createThreadResponse
            .json()
            .catch(() => null)) as {
            data?: { id?: string };
            error?: string;
          } | null;

          if (!createThreadResponse.ok || !createPayload?.data?.id) {
            throw new Error(
              createPayload?.error || "Failed to create chat thread.",
            );
          }

          threadId = createPayload.data.id;
          newlyCreatedThreadIdsRef.current.add(threadId);
          setActiveThreadId(threadId);
          onThreadSelected?.(threadId);
          queryClient.invalidateQueries({ queryKey: ["chat-threads"] });
        }

        // Saved-thread history is reconstructed from the database; submit only the new user turn.
        // Slice before mapping — toApiMessages runs image-data-URI compaction over every message,
        // so mapping the full history first would scan megabytes of base64 only to discard it.
        const payloadMessages = temporary
          ? toApiMessages(messages)
          : toApiMessages(messages.slice(-1));

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
            imageMode,
          }),
          signal: abortSignal,
        });

        let completedSnapshot: ChatApiStreamSnapshot | null = null;

        for await (const snapshot of readChatApiResponse(response)) {
          completedSnapshot = snapshot.done ? snapshot : completedSnapshot;
          yield {
            content: [{ type: "text", text: snapshot.message }] as const,
            status: snapshot.done
              ? ({ type: "complete", reason: "stop" } as const)
              : undefined,
            metadata: snapshot.done
              ? {
                  custom: {
                    provider: snapshot.provider ?? null,
                    model: snapshot.model ?? null,
                  },
                }
              : undefined,
          };
        }

        if (!completedSnapshot) {
          throw new Error("Chat stream ended before completion.");
        }

        if (!temporary) {
          setPersistenceWarning(completedSnapshot.persisted === false);
          queryClient.invalidateQueries({ queryKey: ["chat-threads"] });
          queryClient.invalidateQueries({
            queryKey: ["chat-thread", threadId],
          });
        }
      },
    }),
    [
      activeThreadId,
      imageMode,
      onThreadSelected,
      privacyAcknowledged,
      queryClient,
      temporary,
    ],
  );

  const runtime = useLocalRuntime(chatModel);
  const isHydratingThread =
    !temporary &&
    activeThreadId !== null &&
    activeThreadQuery.isLoading &&
    !newlyCreatedThreadIdsRef.current.has(activeThreadId);
  const isThreadUnavailable =
    !temporary && activeThreadId !== null && activeThreadQuery.isLoadingError;

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
    hydratedSignatureRef.current = signature;
    newlyCreatedThreadIdsRef.current.clear();
  }, [runtime, temporary, temporarySessionKey]);

  useEffect(() => {
    const prompt = initialPrompt?.trim();
    if (!temporary || !prompt || !privacyAcknowledged) {
      return;
    }

    const signature = `temporary-prompt:${temporarySessionKey}:${prompt}`;
    if (initialPromptSignatureRef.current === signature) {
      return;
    }

    initialPromptSignatureRef.current = signature;
    const abortController = new AbortController();
    let settled = false;
    const userMessage = createRuntimeMessage("user", prompt, "url-prompt");

    runtime.thread.reset([userMessage]);
    setIsRunningInitialPrompt(true);

    void (async () => {
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            temporary: true,
            messages: [{ role: "user", content: prompt }],
            stream: true,
          }),
          signal: abortController.signal,
        });

        const assistantMessage = createRuntimeMessage(
          "assistant",
          "",
          "url-answer",
        );
        let completedSnapshot: ChatApiStreamSnapshot | null = null;

        for await (const snapshot of readChatApiResponse(response)) {
          if (abortController.signal.aborted) {
            return;
          }

          completedSnapshot = snapshot.done ? snapshot : completedSnapshot;
          runtime.thread.reset([
            userMessage,
            {
              ...assistantMessage,
              content: snapshot.message,
              ...(snapshot.done
                ? {
                    metadata: {
                      custom: {
                        provider: snapshot.provider ?? null,
                        model: snapshot.model ?? null,
                      },
                    },
                  }
                : {}),
            },
          ]);
        }

        if (!completedSnapshot) {
          throw new Error("Chat stream ended before completion.");
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }

        const message =
          error instanceof Error
            ? error.message
            : "Failed to generate a response.";
        runtime.thread.reset([
          userMessage,
          createRuntimeMessage("assistant", message, "url-answer-error"),
        ]);
      } finally {
        settled = true;
        if (!abortController.signal.aborted) {
          setIsRunningInitialPrompt(false);
        }
      }
    })();

    return () => {
      abortController.abort();
      if (!settled && initialPromptSignatureRef.current === signature) {
        initialPromptSignatureRef.current = null;
      }
    };
  }, [
    initialPrompt,
    privacyAcknowledged,
    runtime,
    temporary,
    temporarySessionKey,
  ]);

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
    if (isNewlyCreatedThread && thread.messages.length === 0) {
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

  const restorePersistedConversation = async () => {
    if (!activeThreadId) return;

    const result = await activeThreadQuery.refetch();
    if (!result.data) return;

    const lastMessage = result.data.messages[result.data.messages.length - 1];
    runtime.thread.cancelRun();
    runtime.thread.reset(toRuntimeMessages(result.data.messages));
    hydratedSignatureRef.current = `${result.data.id}:${result.data.messages.length}:${lastMessage?.id ?? "none"}`;
    newlyCreatedThreadIdsRef.current.delete(result.data.id);
    setPersistenceWarning(false);
  };

  const composerDisabled =
    !privacyAcknowledged ||
    isHydratingThread ||
    isRunningInitialPrompt ||
    isThreadUnavailable ||
    persistenceWarning;

  return (
    <Card
      className={cn(
        "relative isolate flex h-full min-h-0 w-full flex-col overflow-hidden rounded-none border-0 bg-transparent shadow-none sm:bg-background/50 sm:backdrop-blur-md",
        temporary &&
          landingHero &&
          "bg-[linear-gradient(180deg,#fbfbff_0%,#f7f3ff_44%,#eef4ff_100%)] dark:bg-[linear-gradient(180deg,#090a12_0%,#0d1020_48%,#080a10_100%)] sm:bg-[linear-gradient(180deg,#fbfbff_0%,#f7f3ff_44%,#eef4ff_100%)] sm:dark:bg-[linear-gradient(180deg,#090a12_0%,#0d1020_48%,#080a10_100%)]",
      )}
    >
      {temporary && landingHero ? <LandingGridBackdrop /> : null}
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
                    <h2 className="text-xl font-semibold tracking-tight">
                      Loading conversation
                    </h2>
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
                    <h2 className="text-xl font-semibold tracking-tight">
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
                      <LandingHeroEmpty />
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center space-y-4 text-center pb-20">
                        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                          <Sparkles className="h-8 w-8" />
                        </div>
                        <div className="space-y-2 max-w-[400px]">
                          <h2 className="text-xl font-semibold tracking-tight">
                            How can I help you today?
                          </h2>
                          {activeThreadId ? (
                            <p className="text-sm text-muted-foreground leading-relaxed">
                              Start a conversation about reviewing your
                              contracts, spotting clauses, or navigating
                              negotiation points.
                            </p>
                          ) : temporary ? (
                            <p className="text-sm text-muted-foreground leading-relaxed">
                              Temporary chat is not saved to your history.
                            </p>
                          ) : (
                            <p className="text-sm text-muted-foreground leading-relaxed">
                              Select an existing chat from the sidebar or click{" "}
                              <span className="font-medium text-foreground">
                                The &quot;+&quot; Button
                              </span>{" "}
                              to start.
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
            </ThreadPrimitive.Viewport>

            <ComposerPrimitive.Root className="shrink-0 bg-transparent px-4 pb-2 pt-1 sm:px-6 sm:pb-3 sm:pt-2">
              {persistenceWarning && !temporary ? (
                <div
                  className="mx-auto mb-2 max-w-3xl rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100"
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
                      onClick={() => void restorePersistedConversation()}
                    >
                      Restore saved chat
                    </Button>
                  </div>
                </div>
              ) : null}
              <div className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-[1.75rem] border bg-background/80 p-1.5 shadow-sm backdrop-blur transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20">
                {imageGenerationAvailable ? (
                  <button
                    type="button"
                    aria-label={
                      imageMode
                        ? "Turn off image generation mode"
                        : "Turn on image generation mode"
                    }
                    aria-pressed={imageMode}
                    className={cn(
                      "mb-1 ml-1 flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors",
                      imageMode
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border bg-background/60 text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    disabled={composerDisabled}
                    onClick={() => setImageMode((enabled) => !enabled)}
                    title="Generate an image with gpt-image-2"
                  >
                    <ImageIcon className="h-3.5 w-3.5" />
                    <span>Image</span>
                  </button>
                ) : null}
                <ComposerPrimitive.Input
                  className={cn(
                    "min-h-[40px] max-h-60 w-full resize-none bg-transparent px-4 py-2.5 text-[15px] text-foreground outline-none",
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
                        : isRunningInitialPrompt
                          ? "Answering..."
                          : imageMode
                            ? "Describe the image you want..."
                            : "Ask SignLoop..."
                  }
                  submitMode="enter"
                  rows={1}
                />

                <div className="flex shrink-0 p-1">
                  <ThreadPrimitive.If running={false}>
                    <ComposerPrimitive.Send asChild>
                      <Button
                        type="button"
                        size="icon"
                        disabled={composerDisabled}
                        className="h-8 w-8 shrink-0 rounded-full transition-transform hover:scale-105"
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
                        className="h-8 w-8 shrink-0 rounded-full"
                      >
                        <Square className="h-4 w-4 fill-current" />
                        <span className="sr-only">Cancel generation</span>
                      </Button>
                    </ComposerPrimitive.Cancel>
                  </ThreadPrimitive.If>
                </div>
              </div>
              <div className="mx-auto mt-1.5 max-w-3xl text-center text-xs text-muted-foreground/80">
                {isHydratingThread
                  ? "Conversation history is loading. Sending is disabled until it finishes."
                  : isRunningInitialPrompt
                    ? "Answering the temporary prompt from the URL."
                    : temporary
                      ? imageMode
                        ? "Image mode uses gpt-image-2. Temporary chat is not saved."
                        : "Temporary chat is not saved. AI may produce inaccurate information."
                      : imageMode
                        ? "Image mode uses gpt-image-2 and returns one generated image."
                        : "AI may produce inaccurate information about laws or guidelines. Keep original records."}
              </div>
            </ComposerPrimitive.Root>
          </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
      </CardContent>
    </Card>
  );
}
