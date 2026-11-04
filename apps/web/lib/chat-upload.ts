import { requestParse } from "@/lib/parse-client";
import {
  prepareUpload,
  toExtractedText,
  type ExtractedText,
  type PreparedUpload,
  type UploadValidationError,
} from "@/lib/upload-pipeline";
import { isChatImage } from "@/lib/chat-files-shared";
import { validateChatImage } from "@/lib/chat-images";

/**
 * Receive and validate a chat attachment, then have the parse-only function extract it. Chat
 * attachments are never stored first (temporary chats keep nothing, saved chats keep the bytes in
 * PostgreSQL), so the validated bytes go to the parse function as the request body.
 */
export async function prepareExtractedUpload(
  req: Request,
  options: Parameters<typeof prepareUpload>[1],
): Promise<(PreparedUpload & ExtractedText) | UploadValidationError> {
  const prepared = await prepareUpload(req, options);
  if (!prepared.ok) return prepared;
  if (isChatImage(prepared.mimeType)) {
    try {
      validateChatImage(prepared.buffer, prepared.mimeType);
      return { ...prepared, text: "", method: null, confidence: null, extractionError: null, extractionWarning: null };
    } catch (error) {
      return { ok: false, status: 422, error: error instanceof Error ? error.message : "Invalid image." };
    }
  }
  const extracted = toExtractedText(
    await requestParse({
      req,
      buffer: prepared.buffer,
      mimeType: prepared.mimeType,
      signal: prepared.signal,
    }),
    prepared.signal,
  );
  return extracted.ok ? { ...prepared, ...extracted } : extracted;
}
