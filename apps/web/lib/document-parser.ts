import { withAbort } from "@repo/chat-engine/bounded-response";
import { MAX_EXTRACTED_TEXT_LENGTH } from "@/lib/extraction-limits";
import { readObject } from "@/lib/object-storage";
import type { ParseOutcome } from "@/lib/parse-protocol";
import {
  ExtractedTextContentError,
  ExtractionLimitError,
  ExtractionUnavailableError,
  processValidatedFile,
} from "@/lib/text-extraction";
import {
  MAX_DIRECT_UPLOAD_FILE_SIZE,
  MAX_DIRECT_UPLOAD_FILE_SIZE_MB,
} from "@/lib/upload-constants";

// Runs the parsers on a file whose MIME type and signature were already validated, and reports
// the result as a ParseOutcome. Only the parse-only function uses it: on stored uploads, and on
// the bytes of chat attachments.

const TIMED_OUT = "Upload processing timed out or was canceled.";
const READ_FAILED = "The uploaded file could not be read. Please try again.";

/** Parse validated bytes. Never throws; the parser's own error is logged, not returned. */
export async function parseDocument(
  buffer: Buffer,
  mimeType: string,
  signal: AbortSignal,
): Promise<ParseOutcome> {
  try {
    signal.throwIfAborted();
    const extracted = await processValidatedFile(buffer, mimeType, { signal });
    signal.throwIfAborted();
    if (extracted.text.length > MAX_EXTRACTED_TEXT_LENGTH) {
      return {
        ok: false,
        kind: "limit",
        message: `Extracted text is too large. Maximum length is ${MAX_EXTRACTED_TEXT_LENGTH.toLocaleString("en-US")} characters.`,
      };
    }
    return {
      ok: true,
      text: extracted.text,
      method: extracted.method,
      confidence:
        typeof extracted.confidence === "number" ? extracted.confidence : null,
      sparseTextPages: extracted.sparseTextPages ?? [],
    };
  } catch (error: unknown) {
    if (
      error instanceof ExtractionLimitError ||
      error instanceof ExtractedTextContentError
    ) {
      return {
        ok: false,
        kind: error instanceof ExtractionLimitError ? "limit" : "content",
        message: error.message,
      };
    }
    if (signal.aborted) {
      return { ok: false, kind: "unavailable", message: TIMED_OUT };
    }
    if (error instanceof ExtractionUnavailableError) {
      return { ok: false, kind: "unavailable", message: error.message };
    }
    console.error("Text extraction failed:", error);
    return { ok: false, kind: "failed", message: "Text extraction failed" };
  }
}

type StoredBytes =
  | { ok: true; buffer: Buffer }
  | { ok: false; reason: "missing" | "too_large" };

/** Read a stored object, refusing it as soon as it passes maxBytes. */
async function readStoredBytes(
  storageKey: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<StoredBytes> {
  const stream = await readObject(storageKey, signal);
  if (!stream) return { ok: false, reason: "missing" };
  const reader = stream.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) return { ok: false, reason: "too_large" };
      chunks.push(value);
    }
    return { ok: true, buffer: Buffer.concat(chunks, bytes) };
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Parse a stored upload: read it within the 10 MiB upload bound, then run the parsers. Like
 * parseDocument, it never throws.
 */
export async function parseStoredDocument(
  storageKey: string,
  mimeType: string,
  signal: AbortSignal,
): Promise<ParseOutcome> {
  let stored: StoredBytes;
  try {
    stored = await readStoredBytes(
      storageKey,
      MAX_DIRECT_UPLOAD_FILE_SIZE,
      signal,
    );
  } catch (error: unknown) {
    if (signal.aborted) {
      return { ok: false, kind: "unavailable", message: TIMED_OUT };
    }
    console.error("Stored upload read failed:", error);
    return { ok: false, kind: "unavailable", message: READ_FAILED };
  }
  if (!stored.ok) {
    if (stored.reason === "missing") {
      console.error("Stored upload to parse was not found");
      return { ok: false, kind: "unavailable", message: READ_FAILED };
    }
    return {
      ok: false,
      kind: "limit",
      message: `File too large. Maximum size is ${MAX_DIRECT_UPLOAD_FILE_SIZE_MB} MB.`,
    };
  }
  return parseDocument(stored.buffer, mimeType, signal);
}
