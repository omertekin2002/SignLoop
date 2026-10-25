import type { ModelMessage } from "ai";
import type { ChatMessage, ChatRole } from "@/lib/chat";
import { isRecord } from "@/lib/utils";
import {
  parseAgentMessages,
  parseWebSources,
} from "@repo/chat-engine/chat-agent-history";
import { withAbort } from "@repo/chat-engine/bounded-response";
import { z } from "zod";
import {
  chatDocumentSchema,
  MAX_CHAT_DOCUMENT_CONTEXT,
  MAX_CHAT_FILES_PER_MESSAGE,
} from "@/lib/chat-files-shared";
import {
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_REQUEST_BODY_BYTES,
  MAX_CHAT_TOTAL_MESSAGE_LENGTH,
} from "@/lib/chat-history-bounds";
export { MAX_AGENT_STATE_CHARACTERS } from "@repo/chat-engine/chat-agent-history";
export {
  boundCanonicalChatHistory,
  boundTemporaryChatHistory,
  compactInlineImageDataUris,
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_REQUEST_BODY_BYTES,
  MAX_CHAT_TOTAL_MESSAGE_LENGTH,
} from "@/lib/chat-history-bounds";

/**
 * Temporary chat has no server-side history, so a replayed tool transcript arrives from the
 * browser, including for signed-in users with private contract tools. It must be structurally sound so a
 * malformed shape cannot fault the SDK or the provider call. Anything unexpected drops the whole
 * transcript rather than replaying part of it, which degrades to a text-only turn.
 * Only text and tool exchanges are accepted: the server never emits media or approvals into model
 * transcripts, and SDK file parts can trigger automatic downloads outside the HTTP tools' guards.
 */
export function parseClientAgentMessages(
  value: unknown,
): ModelMessage[] | undefined {
  const messages = parseAgentMessages(value);
  if (!messages) return undefined;
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") {
        if (
          part.output.type === "content" &&
          part.output.value.some((item) => item.type !== "text")
        )
          return undefined;
      } else if (
        part.type !== "text" &&
        part.type !== "reasoning" &&
        part.type !== "tool-call"
      ) {
        return undefined;
      }
    }
  }
  return messages;
}

type RequestPayload = {
  messages?: unknown;
};

export type ParsedChatMessages =
  | { ok: true; messages: ChatMessage[] }
  | { ok: false; error: string; status: number };

export type ParsedJsonRequest<T> =
  { ok: true; value: T } | { ok: false; error: string; status: number };

function isClientChatRole(
  value: unknown,
): value is Exclude<ChatRole, "system"> {
  return value === "user" || value === "assistant";
}

export function parseClientChatMessages(payload: unknown): ParsedChatMessages {
  if (!isRecord(payload)) {
    return { ok: false, error: "Request body must be an object.", status: 400 };
  }

  const rawMessages = (payload as RequestPayload).messages;
  if (!Array.isArray(rawMessages)) {
    return { ok: false, error: "messages must be an array.", status: 400 };
  }

  if (rawMessages.length > MAX_CHAT_MESSAGES) {
    return {
      ok: false,
      error: `Chat supports at most ${MAX_CHAT_MESSAGES} messages per request.`,
      status: 413,
    };
  }

  const normalized: ChatMessage[] = [];
  let totalLength = 0;
  let documentCharacters = 0;

  for (const item of rawMessages) {
    if (!isRecord(item)) {
      return {
        ok: false,
        error: "Each message must be an object.",
        status: 400,
      };
    }

    const role = item.role;
    const content = item.content;
    if (!isClientChatRole(role) || typeof content !== "string") {
      return {
        ok: false,
        error:
          "Each message must have a user or assistant role and string content.",
        status: 400,
      };
    }

    if (content.length > MAX_CHAT_MESSAGE_LENGTH) {
      return {
        ok: false,
        error: `Each message must be at most ${MAX_CHAT_MESSAGE_LENGTH} characters.`,
        status: 413,
      };
    }

    const trimmed = content.trim();
    if (!trimmed) {
      return { ok: false, error: "Messages cannot be empty.", status: 400 };
    }

    totalLength += trimmed.length;
    if (totalLength > MAX_CHAT_TOTAL_MESSAGE_LENGTH) {
      return {
        ok: false,
        error:
          "Chat history is too large. Start a new chat or shorten the request.",
        status: 413,
      };
    }

    const agentMessages =
      role === "assistant"
        ? parseClientAgentMessages(item.agentMessages)
        : undefined;
    const webSources =
      role === "assistant" ? parseWebSources(item.webSources) : undefined;
    const documents =
      item.documents !== undefined
        ? z
            .array(chatDocumentSchema)
            .max(MAX_CHAT_FILES_PER_MESSAGE)
            .safeParse(item.documents)
        : null;
    if (documents && !documents.success)
      return { ok: false, error: "Invalid chat files.", status: 400 };
    if (documents?.success)
      documentCharacters += documents.data.reduce(
        (total, file) => total + file.text.length,
        0,
      );
    if (documentCharacters > MAX_CHAT_DOCUMENT_CONTEXT)
      return {
        ok: false,
        error:
          "Attached documents exceed the conversation's 400,000 character limit. Start a new chat.",
        status: 413,
      };
    totalLength += JSON.stringify({ agentMessages, webSources }).length;
    if (totalLength > MAX_CHAT_TOTAL_MESSAGE_LENGTH) {
      return {
        ok: false,
        status: 413,
        error: "Chat history is too large. Start a new chat.",
      };
    }
    normalized.push({
      role,
      content: trimmed,
      ...(agentMessages ? { agentMessages } : {}),
      ...(webSources ? { webSources } : {}),
      ...(documents?.success ? { documents: documents.data } : {}),
    });
  }

  if (!normalized.length) {
    return {
      ok: false,
      error: "Chat requires at least one message.",
      status: 400,
    };
  }

  if (normalized.at(-1)?.role !== "user") {
    return {
      ok: false,
      error: "The final chat message must be from the user.",
      status: 400,
    };
  }

  return { ok: true, messages: normalized };
}

/** Read a JSON request incrementally so chunked bodies cannot bypass the chat byte limit. */
export async function parseBoundedJsonRequest<T>(
  request: Request,
  maxBytes = MAX_CHAT_REQUEST_BODY_BYTES,
  signal: AbortSignal = request.signal,
): Promise<ParsedJsonRequest<T>> {
  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: false, error: "Invalid JSON body", status: 400 };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => {});
        return {
          ok: false,
          error: "Chat request body is too large.",
          status: 413,
        };
      }
      chunks.push(value);
    }
  } catch {
    void reader.cancel().catch(() => {});
    return signal.aborted
      ? {
          ok: false,
          error: "Chat request timed out or was canceled.",
          status: 503,
        }
      : { ok: false, error: "Invalid JSON body", status: 400 };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      ok: true,
      value: JSON.parse(new TextDecoder().decode(bytes)) as T,
    };
  } catch {
    return { ok: false, error: "Invalid JSON body", status: 400 };
  }
}

/** Saved chats trust only the new user turn; earlier history is reconstructed from the database. */
export function parseLatestClientUserMessage(
  payload: unknown,
): ParsedChatMessages {
  if (!isRecord(payload)) {
    return { ok: false, error: "Request body must be an object.", status: 400 };
  }

  const rawMessages = (payload as RequestPayload).messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return { ok: false, error: "Chat requires a user message.", status: 400 };
  }
  if (rawMessages.length > MAX_CHAT_MESSAGES) {
    return {
      ok: false,
      error: `Chat supports at most ${MAX_CHAT_MESSAGES} messages per request.`,
      status: 413,
    };
  }

  const latest = rawMessages.at(-1);
  if (
    !isRecord(latest) ||
    latest.role !== "user" ||
    typeof latest.content !== "string"
  ) {
    return {
      ok: false,
      error: "The final chat message must be from the user.",
      status: 400,
    };
  }
  if (latest.content.length > MAX_CHAT_MESSAGE_LENGTH) {
    return {
      ok: false,
      error: `Each message must be at most ${MAX_CHAT_MESSAGE_LENGTH} characters.`,
      status: 413,
    };
  }

  const content = latest.content.trim();
  if (!content) {
    return { ok: false, error: "Messages cannot be empty.", status: 400 };
  }

  const ids =
    latest.fileIds === undefined
      ? null
      : z
          .array(z.uuid())
          .max(MAX_CHAT_FILES_PER_MESSAGE)
          .safeParse(latest.fileIds);
  if (ids && !ids.success)
    return { ok: false, status: 400, error: "Invalid chat file IDs." };
  return {
    ok: true,
    messages: [
      {
        role: "user",
        content,
        ...(ids?.success
          ? { fileIds: ids.data.map((id) => id.toLowerCase()) }
          : {}),
      },
    ],
  };
}
