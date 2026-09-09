import type { ChatMessageRecord } from "@/lib/server-db";

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
