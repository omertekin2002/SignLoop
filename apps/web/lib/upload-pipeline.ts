import { type ReportProgress } from "@/lib/operation-progress";
import { withAbort } from "@/lib/bounded-response";
import { MAX_EXTRACTED_TEXT_LENGTH } from "@/lib/extraction-limits";
import { randomUUID } from "node:crypto";
import { createUploadCleanupIntent } from "@/lib/server-db";
import {
  ExtractedTextContentError,
  ExtractionLimitError,
  ExtractionUnavailableError,
  processValidatedFile,
  validateFileSignature,
  validateMimeType,
  type ExtractionMethod,
} from "@/lib/text-extraction";
import {
  getStorageBucketName,
  getUploadCleanupKey,
  uploadObject,
} from "@/lib/object-storage";
import { getErrorMessage } from "@/lib/utils";
import {
  MAX_UPLOAD_FILE_SIZE,
  MAX_UPLOAD_FILE_SIZE_MB,
} from "@/lib/upload-constants";

const MAX_MULTIPART_OVERHEAD = 64 * 1024;
const LOW_OCR_CONFIDENCE = 60;
const MAX_LISTED_PAGE_RANGES = 6;

// Shared file-upload pipeline used by both the contract-upload and project-context routes,
// so size/MIME validation, the single buffer conversion, and text extraction live in one place.

export type UploadValidationError = {
  ok: false;
  status: number;
  error: string;
};

export type PreparedUpload = {
  signal: AbortSignal;
  ok: true;
  formData: FormData;
  file: File;
  buffer: Buffer;
  mimeType: string;
  text: string;
  method: ExtractionMethod | null;
  confidence: number | null;
  // Non-null when text extraction threw; the text/method/confidence fields are then empty/null.
  extractionError: string | null;
  extractionWarning: string | null;
};

/**
 * "Pages 7–9 and 12 …" for [7, 8, 9, 12]; a long list ends with a count of the other pages. A
 * sparse page's short text (a cover title, a stamp) is kept, so this must not call it unread.
 */
function describeSparseTextPages(pages: readonly number[]): string {
  const ranges: Array<[number, number]> = [];
  for (const page of pages) {
    const previous = ranges.at(-1);
    if (previous && page === previous[1] + 1) previous[1] = page;
    else ranges.push([page, page]);
  }
  const listed = ranges
    .slice(0, MAX_LISTED_PAGE_RANGES)
    .map(([first, last]) => (first === last ? `${first}` : `${first}–${last}`));
  const otherPages = ranges
    .slice(MAX_LISTED_PAGE_RANGES)
    .reduce((count, [first, last]) => count + last - first + 1, 0);
  if (otherPages > 0) {
    listed.push(`${otherPages} more ${otherPages === 1 ? "page" : "pages"}`);
  }
  const list = new Intl.ListFormat("en-US").format(listed);
  return pages.length === 1
    ? `Page ${list} has little or no selectable text. Any text on it is included, but if it is a scanned image, its content is missing from the analysis. Verify that page in the original before relying on the analysis.`
    : `Pages ${list} have little or no selectable text. Any text on them is included, but if they are scanned images, their content is missing from the analysis. Verify those pages in the original before relying on the analysis.`;
}

export function getExtractionWarning(input: {
  method: ExtractionMethod | null;
  confidence: number | null;
  sparseTextPages?: readonly number[];
}): string | null {
  if (input.method === "pdf_scanned") {
    return "This PDF appears to be scanned and may have an incomplete text layer. Verify the extracted text before relying on the analysis.";
  }

  if (input.sparseTextPages?.length) {
    return describeSparseTextPages(input.sparseTextPages);
  }

  if (
    input.method === "tesseract_ocr" &&
    input.confidence !== null &&
    input.confidence < LOW_OCR_CONFIDENCE
  ) {
    return `OCR confidence is low (${Math.round(input.confidence)}%). Verify the extracted text before relying on the analysis.`;
  }

  return null;
}

// Parse + validate the multipart upload and extract its text. Does NOT persist anything, so the
// caller decides its own empty-text policy before storing (e.g. contracts reject empty text).
export async function prepareUpload(
  req: Request,
  progress?: ReportProgress,
): Promise<PreparedUpload | UploadValidationError> {
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(150_000)]);
  const declaredContentLength = Number(req.headers.get("content-length"));
  if (
    Number.isFinite(declaredContentLength) &&
    declaredContentLength > MAX_UPLOAD_FILE_SIZE + MAX_MULTIPART_OVERHEAD
  ) {
    return {
      ok: false,
      status: 413,
      error: `Request too large. Maximum file size is ${MAX_UPLOAD_FILE_SIZE_MB} MB.`,
    };
  }

  let formData: FormData;
  const reader = req.body?.getReader();
  try {
    if (!reader)
      return { ok: false, status: 400, error: "Missing upload body" };
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_UPLOAD_FILE_SIZE + MAX_MULTIPART_OVERHEAD) {
        void reader.cancel().catch(() => {});
        return {
          ok: false,
          status: 413,
          error: "Upload request is too large.",
        };
      }
      // No defensive copy: Blob copies each chunk when it takes ownership below.
      chunks.push(value);
    }
    formData = await new Response(new Blob(chunks), {
      headers: { "content-type": req.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    void reader?.cancel().catch(() => {});
    return {
      ok: false,
      status: signal.aborted ? 503 : 400,
      error: signal.aborted
        ? "Upload timed out or was canceled."
        : "Invalid multipart upload",
    };
  } finally {
    reader?.releaseLock();
  }

  // Content-Length is only a fast preflight and may be absent. Recount every parsed part so large
  // non-file fields or files under unexpected field names cannot bypass the semantic body limit.
  let parsedBodyBytes = 0;
  for (const value of formData.values()) {
    parsedBodyBytes +=
      value instanceof File ? value.size : Buffer.byteLength(value, "utf8");
    if (parsedBodyBytes > MAX_UPLOAD_FILE_SIZE + MAX_MULTIPART_OVERHEAD) {
      return {
        ok: false,
        status: 413,
        error: `Request too large. Maximum file size is ${MAX_UPLOAD_FILE_SIZE_MB} MB.`,
      };
    }
  }

  const files = formData.getAll("file");
  if (files.length !== 1 || !(files[0] instanceof File)) {
    return { ok: false, status: 400, error: "Upload exactly one file" };
  }
  const file = files[0];

  if (file.size === 0) {
    return { ok: false, status: 400, error: "The uploaded file is empty" };
  }

  if (file.size > MAX_UPLOAD_FILE_SIZE) {
    return {
      ok: false,
      status: 413,
      error: `File too large. Maximum size is ${MAX_UPLOAD_FILE_SIZE_MB} MB.`,
    };
  }

  const rawMimeType = file.type || "application/octet-stream";
  let mimeType: string;
  try {
    mimeType = validateMimeType(rawMimeType, file.name);
  } catch (error: unknown) {
    return {
      ok: false,
      status: 400,
      error: getErrorMessage(error, "Invalid file type"),
    };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    validateFileSignature(buffer, mimeType);
  } catch (error: unknown) {
    return {
      ok: false,
      status: 400,
      error: getErrorMessage(
        error,
        "File contents do not match the selected file type",
      ),
    };
  }

  let text = "";
  let method: ExtractionMethod | null = null;
  let confidence: number | null = null;
  let extractionError: string | null = null;
  let extractionWarning: string | null = null;
  try {
    signal.throwIfAborted();
    progress?.("extracting");
    const extracted = await processValidatedFile(buffer, mimeType, { signal });
    signal.throwIfAborted();
    if (extracted.text.length > MAX_EXTRACTED_TEXT_LENGTH) {
      return {
        ok: false,
        status: 422,
        error: `Extracted text is too large. Maximum length is ${MAX_EXTRACTED_TEXT_LENGTH.toLocaleString("en-US")} characters.`,
      };
    }
    text = extracted.text;
    method = extracted.method;
    confidence =
      typeof extracted.confidence === "number" ? extracted.confidence : null;
    extractionWarning = getExtractionWarning({
      method,
      confidence,
      sparseTextPages: extracted.sparseTextPages,
    });
  } catch (error: unknown) {
    if (
      error instanceof ExtractionLimitError ||
      error instanceof ExtractedTextContentError
    ) {
      return { ok: false, status: 422, error: error.message };
    }
    if (signal.aborted)
      return {
        ok: false,
        status: 503,
        error: "Upload processing timed out or was canceled.",
      };
    if (error instanceof ExtractionUnavailableError) {
      return { ok: false, status: 503, error: error.message };
    }
    extractionError = getErrorMessage(error, "Text extraction failed");
  }

  return {
    ok: true,
    signal,
    formData,
    file,
    buffer,
    mimeType,
    text,
    method,
    confidence,
    extractionError,
    extractionWarning,
  };
}

// Persist under an opaque, collision-resistant path. The object key deliberately contains no
// owner ID, domain entity ID, or original filename because Blob URLs may be logged or shared.
export async function storeUploadedFile(input: {
  signal?: AbortSignal;
  buffer: Buffer;
  mimeType: string;
}): Promise<{ storageKey: string; bucket: string; storageIntentId: string }> {
  const objectKey = `uploads/${randomUUID()}`;
  const bucket = getStorageBucketName();
  const storageIntentId = await createUploadCleanupIntent(
    getUploadCleanupKey(objectKey),
  );
  const storageKey = await uploadObject(
    objectKey,
    input.buffer,
    input.mimeType,
    input.signal,
  );
  return { storageKey, bucket, storageIntentId };
}
