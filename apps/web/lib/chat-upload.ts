import { parseDocument } from "@/lib/document-parser";
import {
  prepareUpload,
  toExtractedText,
  type ExtractedText,
  type PreparedUpload,
  type UploadValidationError,
} from "@/lib/upload-pipeline";

/**
 * Receive, validate and extract a chat attachment within this request. Chat attachments are not
 * stored first, so they still parse in their own function rather than the parse-only one.
 */
export async function prepareExtractedUpload(
  req: Request,
  options: Parameters<typeof prepareUpload>[1],
): Promise<(PreparedUpload & ExtractedText) | UploadValidationError> {
  const prepared = await prepareUpload(req, options);
  if (!prepared.ok) return prepared;
  const extracted = toExtractedText(
    await parseDocument(prepared.buffer, prepared.mimeType, prepared.signal),
    prepared.signal,
  );
  return extracted.ok ? { ...prepared, ...extracted } : extracted;
}
