"use client";

import type { AttachmentAdapter } from "@assistant-ui/react";
import { toast } from "sonner";
import {
  CHAT_FILE_ACCEPT,
  chatDocumentSchema,
  parseChatFileInfos,
  type ChatDocument,
  type ChatFileInfo,
} from "@/lib/chat-files-shared";
import { MAX_UPLOAD_FILE_SIZE } from "@/lib/upload-constants";

export function chatAttachmentAdapter(): AttachmentAdapter {
  const pending = new Set<string>();
  return {
    accept: CHAT_FILE_ACCEPT,
    async add({ file }) {
      if (pending.size >= 4) {
        toast.error("Attach at most four files per message.");
        throw new Error("Attach at most four files per message.");
      }
      if (
        !/\.(pdf|txt|docx)$/i.test(file.name) ||
        !file.size ||
        file.size > MAX_UPLOAD_FILE_SIZE
      ) {
        const message = "Attach a non-empty PDF, TXT, or DOCX up to 4 MB.";
        toast.error(message);
        throw new Error(message);
      }
      const id = crypto.randomUUID();
      pending.add(id);
      return {
        id,
        name: file.name,
        type: "document",
        contentType: file.type,
        file,
        status: { type: "requires-action", reason: "composer-send" },
      };
    },
    async send(attachment) {
      pending.delete(attachment.id);
      return { ...attachment, content: [], status: { type: "complete" } };
    },
    async remove(attachment) {
      pending.delete(attachment.id);
    },
  };
}

export async function uploadChatFile(
  file: File,
  threadId: string | null,
  signal: AbortSignal,
): Promise<ChatDocument | ChatFileInfo> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(
    `/api/chat/files${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`,
    { method: "POST", body: form, signal },
  );
  const payload = await response.json();
  if (!response.ok)
    throw new Error(
      typeof payload.error === "string" ? payload.error : "File upload failed.",
    );
  const parsed = threadId
    ? parseChatFileInfos([payload.file])[0]
    : chatDocumentSchema.parse(payload.file);
  if (!parsed)
    throw new Error("The upload response did not include a valid file.");
  if (parsed.warning) toast.warning(parsed.warning);
  return parsed;
}
