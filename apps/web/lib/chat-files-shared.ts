import { z } from "zod";

export const CHAT_FILE_ACCEPT = ".pdf,.txt,.docx";
export const MAX_CHAT_FILES_PER_MESSAGE = 4;
export const MAX_CHAT_FILE_TEXT = 200_000;
export const MAX_CHAT_DOCUMENT_CONTEXT = 400_000;
// Two base64 downloads plus reply text must fit beneath Vercel's 4.5 MB response limit.
export const MAX_CHAT_GENERATED_FILE_BYTES = 1024 * 1024;
export const CHAT_FILE_TYPES = {
  pdf: "application/pdf",
  txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;
export type ChatFileFormat = keyof typeof CHAT_FILE_TYPES;

const fileInfoSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(180),
  mediaType: z.enum(Object.values(CHAT_FILE_TYPES) as [string, ...string[]]),
  size: z
    .number()
    .int()
    .positive()
    .max(4 * 1024 * 1024),
  url: z
    .string()
    .regex(/^\/api\/chat\/threads\/[\da-f-]{36}\/files\/[\da-f-]{36}$/i)
    .optional(),
  warning: z.string().max(2000).optional(),
});
export type ChatFileInfo = z.infer<typeof fileInfoSchema>;
export type ChatDownloadFile = ChatFileInfo & { data?: string };
export const chatDocumentSchema = fileInfoSchema.omit({ url: true }).extend({
  text: z.string().min(1).max(MAX_CHAT_FILE_TEXT),
});
export type ChatDocument = z.infer<typeof chatDocumentSchema>;

/** Accept a bounded document batch; reject the entire batch if any item is malformed. */
export function parseChatDocuments(value: unknown): ChatDocument[] {
  const parsed = z
    .array(chatDocumentSchema)
    .max(MAX_CHAT_FILES_PER_MESSAGE)
    .safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** Descriptors only; saved API responses never expose extracted document text. */
export function parseChatFileInfos(value: unknown): ChatFileInfo[] {
  const parsed = z.array(fileInfoSchema).max(8).safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** Validate download descriptors and cap inline base64 before the browser decodes it. */
export function parseChatDownloads(value: unknown): ChatDownloadFile[] {
  const parsed = z
    .array(
      fileInfoSchema.extend({
        data: z
          .string()
          .max(Math.ceil(MAX_CHAT_GENERATED_FILE_BYTES / 3) * 4)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/)
          .optional(),
      }),
    )
    .max(4)
    .safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** Bound filenames and remove path/control characters before storage or HTTP headers. */
export function chatFileName(name: string): string {
  const bounded = name.replace(/[\p{Cc}/\\]/gu, "_").slice(-180);
  // UTF-8 round-trip repairs lone surrogates so Content-Disposition encoding cannot throw.
  return (
    new TextDecoder().decode(new TextEncoder().encode(bounded)).trim() ||
    "document"
  );
}

/** Publish a saved file's owner-checked download URL without its bytes or extracted text. */
export function savedChatFile(
  file: ChatFileInfo,
  threadId: string,
): ChatFileInfo {
  return {
    id: file.id,
    name: file.name,
    mediaType: file.mediaType,
    size: file.size,
    ...(file.warning ? { warning: file.warning } : {}),
    url: `/api/chat/threads/${threadId}/files/${file.id}`,
  };
}
