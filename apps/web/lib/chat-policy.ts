import type { ChatMessage, ChatRole } from "@/lib/chat";
import { isRecord } from "@/lib/utils";

export const MAX_CHAT_MESSAGES = 30;
export const MAX_CHAT_MESSAGE_LENGTH = 4_000;
export const MAX_CHAT_TOTAL_MESSAGE_LENGTH = 60_000;
export const MAX_CHAT_REQUEST_BODY_BYTES = 128 * 1024;

/** Replace generated image payloads before a message is sent back to a text model. */
export function compactInlineImageDataUris(text: string): string {
  return text
    .replace(
      /!\[([^\]]*)\]\(\s*data:image\/[a-z0-9.+-]+;base64,[^)]+\)/gi,
      (_match, alt: string) =>
        `[generated image${alt?.trim() ? `: ${alt.trim()}` : ""}]`,
    )
    .replace(
      /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{200,}/gi,
      "[generated image data]",
    );
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

    normalized.push({ role, content: trimmed });
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
): Promise<ParsedJsonRequest<T>> {
  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: false, error: "Invalid JSON body", status: 400 };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return {
          ok: false,
          error: "Chat request body is too large.",
          status: 413,
        };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, error: "Invalid JSON body", status: 400 };
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

  return { ok: true, messages: [{ role: "user", content }] };
}

/** Keep the newest canonical messages inside the same per-message and total character budgets. */
export function boundCanonicalChatHistory(
  messages: readonly ChatMessage[],
  reservedCharacters = 0,
): ChatMessage[] {
  let remainingCharacters = Math.max(
    0,
    MAX_CHAT_TOTAL_MESSAGE_LENGTH - Math.max(0, Math.trunc(reservedCharacters)),
  );
  const selected: ChatMessage[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || (message.role !== "user" && message.role !== "assistant"))
      continue;

    const content = compactInlineImageDataUris(message.content.trim()).slice(
      0,
      MAX_CHAT_MESSAGE_LENGTH,
    );
    if (!content) continue;
    if (content.length > remainingCharacters) break;

    selected.push({ role: message.role, content });
    remainingCharacters -= content.length;
  }

  return selected.reverse();
}
