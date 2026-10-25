// Client NDJSON transport shared by the assistant-ui adapter and its controlled-stream tests.
import type { ChatToolActivity, ChatToolName } from "@/lib/chat";
import type { AccountQuota } from "@/lib/inference-policy";
import type { ChatThreadMessage } from "@/lib/workspace-query-options";
import { parseWebSources } from "@repo/chat-engine/chat-history-shared";
import { chatRequestFailure } from "@/lib/chat-request-error";
import { parseAccountQuota } from "@/lib/usage-client";
import { isRecord } from "@/lib/utils";
import {
  parseChatDownloads,
  parseChatDocuments,
  type ChatDownloadFile,
  type ChatDocument,
} from "@/lib/chat-files-shared";

type ChatApiSuccess = {
  files?: ChatDownloadFile[];
  documents?: ChatDocument[];
  toolActivity?: ChatToolActivity[];
  /** Temporary chat keeps its tool exchanges here; saved threads reload them from the database. */
  agentMessages?: unknown[];
  webSources?: ReturnType<typeof parseWebSources>;
  message: string;
  provider?: string;
  model?: string;
  persisted?: boolean;
  storedMessages?: ChatThreadMessage[];
  /** The signed-in account's quota as of this request's admission. */
  quota?: AccountQuota;
};

type ChatApiStreamEvent =
  | { type: "tool"; activity: ChatToolActivity }
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

export type ChatApiStreamSnapshot = ChatApiSuccess & {
  done: boolean;
};

function parseError(payload: unknown, status: number): string {
  return chatRequestFailure(payload, status, null).message;
}

/** Normalize a complete reply and validate any document or download metadata at the boundary. */
function parseSuccess(payload: unknown): ChatApiSuccess {
  if (!isRecord(payload) || typeof payload.message !== "string") {
    throw new Error("Chat response did not include a message.");
  }

  const message = payload.message;
  if (!message.trim()) {
    throw new Error("Chat response was empty.");
  }

  return {
    message,
    ...(payload.documents !== undefined
      ? { documents: parseChatDocuments(payload.documents) }
      : {}),
    ...(payload.files !== undefined
      ? { files: parseChatDownloads(payload.files) }
      : {}),
    webSources: parseWebSources(payload.webSources),
    toolActivity: parseToolActivity(payload.toolActivity),
    agentMessages: Array.isArray(payload.agentMessages)
      ? payload.agentMessages
      : undefined,
    storedMessages: Array.isArray(payload.storedMessages)
      ? payload.storedMessages.filter(
          (message): message is ChatThreadMessage =>
            isRecord(message) &&
            typeof message.id === "string" &&
            typeof message.content === "string" &&
            typeof message.position === "number" &&
            (message.role === "user" || message.role === "assistant"),
        )
      : undefined,
    provider:
      typeof payload.provider === "string" ? payload.provider : undefined,
    model: typeof payload.model === "string" ? payload.model : undefined,
    persisted:
      typeof payload.persisted === "boolean" ? payload.persisted : undefined,
    quota: parseAccountQuota(payload.quota) ?? undefined,
  };
}

export const TOOL_ACTIVITY_LABELS: Record<
  ChatToolName,
  { running: string; complete: string; error: string }
> = {
  read_file: {
    running: "Reading file",
    complete: "Read file",
    error: "File unavailable",
  },
  create_file: {
    running: "Creating file",
    complete: "Created file",
    error: "File creation failed",
  },
  search_web: {
    running: "Searching",
    complete: "Searched",
    error: "Search unavailable",
  },
  generate_image: {
    running: "Generating image",
    complete: "Generated image",
    error: "Image unavailable",
  },
  read_url: {
    running: "Reading page",
    complete: "Read page",
    error: "Page unavailable",
  },
  http_get: { running: "Fetching", complete: "Fetched", error: "Fetch failed" },
  read_contract: {
    running: "Reading contract",
    complete: "Read contract",
    error: "Contract unavailable",
  },
  list_contracts: {
    running: "Listing contracts",
    complete: "Listed contracts",
    error: "Contract list unavailable",
  },
};

/** Keep only recognized tool activity so malformed saved metadata cannot break the transcript. */
export function parseToolActivity(value: unknown): ChatToolActivity[] {
  return Array.isArray(value)
    ? value.flatMap((item): ChatToolActivity[] =>
        isRecord(item) &&
        typeof item.id === "string" &&
        typeof item.query === "string" &&
        (item.status === "running" ||
          item.status === "complete" ||
          item.status === "error")
          ? [
              {
                id: item.id,
                query: item.query,
                status: item.status,
                ...(typeof item.tool === "string" &&
                item.tool in TOOL_ACTIVITY_LABELS
                  ? { tool: item.tool as ChatToolName }
                  : {}),
              },
            ]
          : [],
      )
    : [];
}

/** Validate an NDJSON event before the client applies it to a streamed reply. */
function parseStreamEvent(payload: unknown): ChatApiStreamEvent {
  if (!isRecord(payload) || typeof payload.type !== "string") {
    throw new Error("Chat stream included an invalid event.");
  }

  if (payload.type === "tool") {
    const activity = parseToolActivity([payload.activity])[0];
    if (!activity) throw new Error("Invalid tool activity");
    return { type: "tool", activity };
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

/** Subsequent text paints at most once per 40 ms burst; first text/tools/done bypass the timer. */
export const CHAT_STREAM_UPDATE_MS = 40;

/**
 * Own the reader as well as the timer. An async generator's native return() queues behind a
 * pending next(), so explicitly abort first to wake a paused read when the consumer leaves.
 */
export function readChatApiResponse(
  response: Response,
  abortSignal?: AbortSignal,
): AsyncGenerator<ChatApiStreamSnapshot> {
  const cancellation = new AbortController();
  const iterator = consumeChatApiResponse(response, cancellation, abortSignal);
  const next = iterator.next.bind(iterator);
  const finish = iterator.return.bind(iterator);
  const fail = iterator.throw.bind(iterator);
  let started = false;
  iterator.next = (...args) => {
    started = true;
    return next(...args);
  };
  const cancel = () => {
    cancellation.abort();
    if (!started) void response.body?.cancel().catch(() => {});
  };
  iterator.return = (value) => {
    cancel();
    return finish(value);
  };
  iterator.throw = (error) => {
    cancel();
    return fail(error);
  };
  return iterator;
}

/** Consume bounded JSON or NDJSON replies while preserving cancellation and final metadata. */
async function* consumeChatApiResponse(
  response: Response,
  cancellation: AbortController,
  abortSignal?: AbortSignal,
): AsyncGenerator<ChatApiStreamSnapshot> {
  const signal = cancellation.signal;
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const streaming =
    response.ok &&
    reader &&
    response.headers.get("Content-Type")?.includes("application/x-ndjson");
  let buffer = "";
  let accumulatedMessage = "";
  let firstText = true;
  let dirty = false;
  let ended = !reader;
  let stopped = false;
  let reading = false;
  let readResult: ReadableStreamReadResult<Uint8Array> | undefined;
  let readError: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushDue = false;
  const toolActivity = new Map<string, ChatToolActivity>();
  // Text snapshots share the same array until a tool actually changes.
  let toolActivitySnapshot: ChatToolActivity[] = [];
  const snapshot = (): ChatApiStreamSnapshot => ({
    message: accumulatedMessage,
    toolActivity: toolActivitySnapshot,
    done: false,
  });
  const clearFlush = () => {
    clearTimeout(timer);
    timer = undefined;
    flushDue = false;
    dirty = false;
  };
  const stopReader = () => {
    if (stopped) return;
    stopped = true;
    // cancel() settles outstanding reads immediately. Do not wait on a possibly slow underlying
    // cancel hook before releasing the lock or surfacing terminal output/errors.
    void reader?.cancel().catch(() => {});
    reader?.releaseLock();
  };
  const onAbort = () => {
    cleanup();
    wake?.();
  };
  const forwardAbort = () => cancellation.abort(abortSignal?.reason);
  const cleanup = () => {
    clearFlush();
    signal.removeEventListener("abort", onAbort);
    abortSignal?.removeEventListener("abort", forwardAbort);
    stopReader();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  abortSignal?.addEventListener("abort", forwardAbort, { once: true });
  if (abortSignal?.aborted) forwardAbort();

  try {
    while (true) {
      signal.throwIfAborted();
      if (streaming) {
        const newline = buffer.indexOf("\n");
        if (newline !== -1 || (ended && buffer)) {
          const line = (
            newline === -1 ? buffer : buffer.slice(0, newline)
          ).trim();
          buffer = newline === -1 ? "" : buffer.slice(newline + 1);
          if (!line) continue;
          // Preserve CDN/proxy comments and keepalives, including split non-JSON lines.
          const parsed = parseJsonPayload(line);
          if (parsed === null) continue;
          const event = parseStreamEvent(parsed);
          if (event.type === "error") throw new Error(event.error);
          if (event.type === "done") {
            cleanup();
            yield { ...event, done: true };
            return;
          }
          if (event.type === "tool") {
            const previous = toolActivity.get(event.activity.id);
            if (
              previous?.tool === event.activity.tool &&
              previous?.query === event.activity.query &&
              previous?.status === event.activity.status
            )
              continue;
            toolActivity.set(event.activity.id, event.activity);
            toolActivitySnapshot = [...toolActivity.values()];
            clearFlush();
            yield snapshot();
          } else if (event.text) {
            accumulatedMessage += event.text;
            if (firstText && accumulatedMessage.trim()) {
              firstText = false;
              yield snapshot();
            } else if (!firstText) {
              dirty = true;
              timer ??= setTimeout(() => {
                timer = undefined;
                flushDue = true;
                wake?.();
              }, CHAT_STREAM_UPDATE_MS);
            }
          }
          continue;
        }
      }

      if (ended) {
        if (streaming) throw new Error("Chat stream ended before completion.");
        const parsedPayload = parseJsonPayload(buffer);
        if (!response.ok)
          throw new Error(parseError(parsedPayload, response.status));
        const success = parseSuccess(parsedPayload);
        cleanup();
        yield { ...success, done: true };
        return;
      }

      // A single outstanding read is retained across timer flushes. Its handlers and one wake
      // callback replace Promise.race loops, which can accumulate reactions on a paused source.
      if (!reading) {
        reading = true;
        void reader!.read().then(
          (result) => {
            readResult = result;
            wake?.();
          },
          (error: unknown) => {
            readError = { error };
            wake?.();
          },
        );
      }
      if (!readResult && !readError && !flushDue && !signal.aborted) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      signal.throwIfAborted();
      if (readError) throw readError.error;
      // Process already-arrived bytes first: a terminal event never waits out the batch window.
      if (readResult) {
        const { done, value } = readResult;
        readResult = undefined;
        reading = false;
        if (value) buffer += decoder.decode(value, { stream: !done });
        if (done) buffer += decoder.decode();
        ended = done;
      } else if (flushDue) {
        clearFlush();
        yield snapshot();
      }
    }
  } catch (error) {
    const flushPartial = dirty && !signal.aborted;
    cleanup();
    // Keep useful buffered prose on real failures, but never paint into an abandoned view.
    if (flushPartial) yield snapshot();
    signal.throwIfAborted();
    throw error;
  } finally {
    cleanup();
  }
}
