// Imported by the chat client, so it must not pull runtime values from "ai" into the browser bundle.
import type { ChatMessage } from "@/lib/chat";
import { isPlainAssistantReplay } from "@/lib/chat-history-shared";

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
  let includedSources = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (selected.length >= MAX_CHAT_MESSAGES) break;
    const message = messages[index];
    if (!message || (message.role !== "user" && message.role !== "assistant"))
      continue;

    const content = compactInlineImageDataUris(message.content.trim()).slice(
      0,
      MAX_CHAT_MESSAGE_LENGTH,
    );
    if (!content) continue;
    if (content.length > remainingCharacters) break;

    // Catalogs accumulate across turns. Only the newest retained copy is read by generation.
    const sourceSize =
      !includedSources && message.webSources?.length
        ? JSON.stringify({ webSources: message.webSources }).length
        : 0;
    const includeSources =
      sourceSize > 0 && sourceSize + content.length <= remainingCharacters;
    const agentMessages =
      message.agentMessages?.length &&
      !isPlainAssistantReplay(message.agentMessages)
        ? message.agentMessages
        : undefined;
    const agentStateSize = JSON.stringify({ agentMessages }).length;
    const includeAgentState =
      message.role === "assistant" &&
      agentMessages?.length &&
      agentStateSize + content.length + (includeSources ? sourceSize : 0) <=
        remainingCharacters;
    selected.push({
      role: message.role,
      content,
      ...(includeAgentState
        ? {
            agentMessages,
          }
        : {}),
      ...(includeSources ? { webSources: message.webSources } : {}),
    });
    if (includeSources) includedSources = true;
    remainingCharacters -=
      content.length +
      (includeAgentState ? agentStateSize : 0) +
      (includeSources ? sourceSize : 0);
  }

  return selected.reverse();
}

/** Bound history for transport; the runtime retains the full text for display. */
export function boundTemporaryChatHistory(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  const latest = messages.at(-1);
  if (!latest) return [];
  // Never silently truncate the user's new request; server validation gives a useful error.
  const history = boundCanonicalChatHistory(
    messages.slice(-MAX_CHAT_MESSAGES, -1),
    latest.content.length,
  );
  const encoder = new TextEncoder();
  const result = [...history, latest];
  // Reserve framing space for thread/mode fields and account for Unicode and JSON escaping.
  while (
    result.length > 1 &&
    encoder.encode(JSON.stringify({ messages: result })).byteLength >
      MAX_CHAT_REQUEST_BODY_BYTES - 2048
  ) {
    result.shift();
  }
  return result;
}
