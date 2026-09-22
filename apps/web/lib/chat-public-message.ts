import type { ChatMessageRecord } from "@/lib/server-db";

/**
 * Saved chats rewrite generated images to attachment URLs while persisting. The finished reply
 * the browser keeps should be that stored text. A failed persist, or a temporary chat that never
 * persists, still has to show the drafted reply — that is where the image bytes live.
 */
export function assistantMessageForClient(
  drafted: string,
  storedMessages: readonly { role: string; content: string }[],
  persisted: boolean,
): string {
  if (!persisted) return drafted;
  for (let index = storedMessages.length - 1; index >= 0; index -= 1) {
    const message = storedMessages[index];
    if (message?.role === "assistant" && message.content) return message.content;
  }
  return drafted;
}

/** Keep agent replay state on the server; the UI only needs the answer and tool activity. */
export function toPublicChatMessage(message: ChatMessageRecord) {
  return {
    id: message.id,
    threadId: message.threadId,
    role: message.role,
    content: message.content,
    position: message.position,
    createdAt: message.createdAt,
    model: message.model,
    provider: message.provider,
    toolActivity: message.toolActivity,
  };
}
