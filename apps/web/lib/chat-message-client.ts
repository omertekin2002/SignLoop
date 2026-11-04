import type { ModelMessage } from "ai";
import type { ThreadMessage } from "@assistant-ui/react";
import {
  MAX_AGENT_STATE_CHARACTERS,
  parseWebSources,
} from "@repo/chat-engine/chat-history-shared";
import {
  boundTemporaryChatHistory,
  compactInlineImageDataUris,
} from "@/lib/chat-history-bounds";
import {
  MAX_CHAT_DOCUMENT_CONTEXT,
  MAX_CHAT_IMAGE_CONTEXT,
  parseChatDocuments,
  type ChatDocument,
  type ChatImage,
  type ChatUpload,
  type ChatFileInfo,
} from "@/lib/chat-files-shared";

type ChatApiMessage = {
  images?: ChatImage[];
  fileIds?: string[];
  documents?: ChatDocument[];
  role: "system" | "user" | "assistant";
  content: string;
  agentMessages?: unknown[];
  webSources?: ReturnType<typeof parseWebSources>;
};

/** Flatten runtime message parts into text, replacing binary media with compact placeholders. */
export function extractMessageText(
  message: Pick<ThreadMessage, "content">,
): string {
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
export function toApiMessages(
  messages: readonly ThreadMessage[],
  preparedFiles: ReadonlyMap<string, ChatUpload | ChatFileInfo>,
  scope: string,
  temporary: boolean,
): ChatApiMessage[] {
  let documentCharacters = 0;
  const selectedDocuments = new Set<string>();
  const selectedImages = new Set<string>();
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
      if ("data" in file && selectedImages.size < MAX_CHAT_IMAGE_CONTEXT)
        selectedImages.add(file.id);
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
                ...(message.role === "user"
                  ? {
                      images: files.filter(
                        (file): file is ChatImage =>
                          "data" in file && selectedImages.has(file.id),
                      ),
                    }
                  : {}),
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
