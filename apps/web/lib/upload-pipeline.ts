import { type ReportProgress } from "@/lib/operation-progress";
import { withAbort } from "@repo/chat-engine/bounded-response";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createUploadCleanupIntent,
  findDirectUploadIntent,
  type DirectUploadTarget,
} from "@/lib/server-db";
import { validateFileSignature, validateMimeType } from "@/lib/file-types";
import { requestParse } from "@/lib/parse-client";
import type { ParseOutcome } from "@/lib/parse-protocol";
import type { ExtractionMethod } from "@/lib/text-extraction";
import {
  getStorageBucketName,
  getUploadCleanupKey,
  readUploadedBlob,
  uploadObject,
} from "@/lib/object-storage";
import { getErrorMessage } from "@/lib/utils";
import {
  DIRECT_UPLOAD_PATHNAME,
  MAX_EXTRACTED_TEXT_LENGTH,
  MAX_DIRECT_UPLOAD_FILE_SIZE,
  MAX_DIRECT_UPLOAD_FILE_SIZE_MB,
  MAX_MULTIPART_UPLOAD_FILE_SIZE,
  MAX_MULTIPART_UPLOAD_FILE_SIZE_MB,
} from "@/lib/upload-constants";

const MAX_MULTIPART_OVERHEAD = 64 * 1024;
const LOW_OCR_CONFIDENCE = 60;
const MAX_LISTED_PAGE_RANGES = 6;

// Shared file-upload pipeline used by both the contract-upload and project-context routes, so
// size/MIME validation, the single buffer conversion, storage, and the call to the parse-only
// function live in one place. It imports no parser: the routes store a validated file, then
// parseUpload asks app/api/internal/parse to read it back and extract its text.

export type UploadValidationError = {
  ok: false;
  status: number;
  error: string;
};

export type StoredUpload = {
  storageKey: string;
  bucket: string;
  storageIntentId: string;
};

/** A received upload whose size, MIME type and signature passed validation. Not parsed yet. */
export type PreparedUpload = {
  signal: AbortSignal;
  ok: true;
  // The request's text fields: multipart string parts, or a finalize request's title/documentType.
  fields: Record<string, string>;
  fileName: string;
  buffer: Buffer;
  mimeType: string;
  // Set for a direct-to-Blob upload, whose bytes are already stored under the claimed intent.
  stored: StoredUpload | null;
};

export type ExtractedText = {
  ok: true;
  text: string;
  method: ExtractionMethod | null;
  confidence: number | null;
  // Non-null when the parser rejected the file; the text/method/confidence fields are then
  // empty/null.
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

type BoundedBody =
  | { ok: true; body: Blob }
  | (UploadValidationError & { ok: false });

/** Buffer a request body, refusing it as soon as it exceeds maxBytes. */
async function readBoundedBody(
  req: Request,
  maxBytes: number,
  signal: AbortSignal,
  invalidError: string,
): Promise<BoundedBody> {
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
      if (bytes > maxBytes) {
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
    return { ok: true, body: new Blob(chunks) };
  } catch {
    void reader?.cancel().catch(() => {});
    return {
      ok: false,
      status: signal.aborted ? 503 : 400,
      error: signal.aborted ? "Upload timed out or was canceled." : invalidError,
    };
  } finally {
    reader?.releaseLock();
  }
}

function uploadSignal(req: Request): AbortSignal {
  return AbortSignal.any([req.signal, AbortSignal.timeout(150_000)]);
}

type UploadFormatOptions = {
  allowedExtensions: readonly string[];
  allowedMimeTypes?: readonly string[];
};

/** The validation both upload paths share: size, MIME type and signature checks. */
function validateUploadedFile(input: {
  options?: UploadFormatOptions;
  buffer: Buffer;
  fileName: string;
  declaredMimeType: string;
  maxBytes: number;
  maxMb: number;
}): { ok: true; mimeType: string } | UploadValidationError {
  const { options, buffer, fileName } = input;
  if (options && !options.allowedExtensions.includes(fileName.split(".").at(-1)?.toLowerCase() ?? "")) {
    return { ok: false, status: 400, error: "Attach a PDF, TXT, or DOCX file." };
  }

  if (buffer.length === 0) {
    return { ok: false, status: 400, error: "The uploaded file is empty" };
  }

  if (buffer.length > input.maxBytes) {
    return {
      ok: false,
      status: 413,
      error: `File too large. Maximum size is ${input.maxMb} MB.`,
    };
  }

  const rawMimeType = input.declaredMimeType || "application/octet-stream";
  let mimeType: string;
  try {
    mimeType = validateMimeType(rawMimeType, fileName);
  } catch (error: unknown) {
    return {
      ok: false,
      status: 400,
      error: getErrorMessage(error, "Invalid file type"),
    };
  }

  if (options?.allowedMimeTypes && !options.allowedMimeTypes.includes(mimeType))
    return { ok: false, status: 400, error: "Attach a PDF, TXT, or DOCX file." };
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
  return { ok: true, mimeType };
}

const PROCESSING_TIMED_OUT: UploadValidationError = {
  ok: false,
  status: 503,
  error: "Upload processing timed out or was canceled.",
};

/**
 * Turn a parse result into what the routes report: limit and content problems are the uploader's
 * to fix (422), a canceled or expired upload and transient failures are 503, and a parser failure
 * becomes `extractionError`, which each route answers with its own message.
 */
export function toExtractedText(
  outcome: ParseOutcome,
  signal: AbortSignal,
): ExtractedText | UploadValidationError {
  if (!outcome.ok && (outcome.kind === "limit" || outcome.kind === "content")) {
    return { ok: false, status: 422, error: outcome.message };
  }
  if (signal.aborted) return PROCESSING_TIMED_OUT;
  if (!outcome.ok && outcome.kind === "unavailable") {
    return { ok: false, status: 503, error: outcome.message };
  }
  if (!outcome.ok) {
    return {
      ok: true,
      text: "",
      method: null,
      confidence: null,
      extractionError: outcome.message,
      extractionWarning: null,
    };
  }
  // The parse function enforces this bound too; never trust a larger answer.
  if (outcome.text.length > MAX_EXTRACTED_TEXT_LENGTH) {
    return {
      ok: false,
      status: 422,
      error: `Extracted text is too large. Maximum length is ${MAX_EXTRACTED_TEXT_LENGTH.toLocaleString("en-US")} characters.`,
    };
  }
  return {
    ok: true,
    text: outcome.text,
    method: outcome.method,
    confidence: outcome.confidence,
    extractionError: null,
    extractionWarning: getExtractionWarning(outcome),
  };
}

/**
 * Extract a stored upload's text in the parse-only function. The upload is stored first, so a
 * failure here leaves the object to the outbox, which deletes it once its cleanup intent is due.
 */
export async function parseUpload(
  req: Request,
  upload: Pick<PreparedUpload, "signal" | "mimeType">,
  stored: StoredUpload,
  progress?: ReportProgress,
): Promise<ExtractedText | UploadValidationError> {
  try {
    upload.signal.throwIfAborted();
    progress?.("extracting");
  } catch {
    return PROCESSING_TIMED_OUT;
  }
  const outcome = await requestParse({
    req,
    storageKey: stored.storageKey,
    mimeType: upload.mimeType,
    signal: upload.signal,
  });
  return toExtractedText(outcome, upload.signal);
}

/**
 * Receive and validate a bounded multipart upload using the caller's allowed file formats.
 * Does not persist or parse it.
 */
export async function prepareUpload(
  req: Request,
  options?: UploadFormatOptions,
): Promise<PreparedUpload | UploadValidationError> {
  const signal = uploadSignal(req);
  const declaredContentLength = Number(req.headers.get("content-length"));
  if (
    Number.isFinite(declaredContentLength) &&
    declaredContentLength > MAX_MULTIPART_UPLOAD_FILE_SIZE + MAX_MULTIPART_OVERHEAD
  ) {
    return {
      ok: false,
      status: 413,
      error: `Request too large. Maximum file size is ${MAX_MULTIPART_UPLOAD_FILE_SIZE_MB} MB.`,
    };
  }

  const body = await readBoundedBody(
    req,
    MAX_MULTIPART_UPLOAD_FILE_SIZE + MAX_MULTIPART_OVERHEAD,
    signal,
    "Invalid multipart upload",
  );
  if (!body.ok) return body;
  let formData: FormData;
  try {
    formData = await new Response(body.body, {
      headers: { "content-type": req.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    return {
      ok: false,
      status: signal.aborted ? 503 : 400,
      error: signal.aborted
        ? "Upload timed out or was canceled."
        : "Invalid multipart upload",
    };
  }

  // Content-Length is only a fast preflight and may be absent. Recount every parsed part so large
  // non-file fields or files under unexpected field names cannot bypass the semantic body limit.
  let parsedBodyBytes = 0;
  const fields: Record<string, string> = {};
  for (const [name, value] of formData.entries()) {
    parsedBodyBytes +=
      value instanceof File ? value.size : Buffer.byteLength(value, "utf8");
    if (parsedBodyBytes > MAX_MULTIPART_UPLOAD_FILE_SIZE + MAX_MULTIPART_OVERHEAD) {
      return {
        ok: false,
        status: 413,
        error: `Request too large. Maximum file size is ${MAX_MULTIPART_UPLOAD_FILE_SIZE_MB} MB.`,
      };
    }
    if (typeof value === "string" && !(name in fields)) fields[name] = value;
  }

  const files = formData.getAll("file");
  if (files.length !== 1 || !(files[0] instanceof File)) {
    return { ok: false, status: 400, error: "Upload exactly one file" };
  }
  const file = files[0];
  if (file.size > MAX_MULTIPART_UPLOAD_FILE_SIZE) {
    return {
      ok: false,
      status: 413,
      error: `File too large. Maximum size is ${MAX_MULTIPART_UPLOAD_FILE_SIZE_MB} MB.`,
    };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const validated = validateUploadedFile({
    options,
    buffer,
    fileName: file.name,
    declaredMimeType: file.type,
    maxBytes: MAX_MULTIPART_UPLOAD_FILE_SIZE,
    maxMb: MAX_MULTIPART_UPLOAD_FILE_SIZE_MB,
  });
  if (!validated.ok) return validated;
  return {
    ok: true,
    signal,
    fields,
    fileName: file.name,
    buffer,
    mimeType: validated.mimeType,
    stored: null,
  };
}

/** A finalize request names an uploaded blob in JSON; anything else is a multipart upload. */
export function isDirectUploadRequest(req: Request): boolean {
  return (
    req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

const MAX_FINALIZE_BODY = 16 * 1024;
const finalizeBodySchema = z.object({
  pathname: z.string().regex(DIRECT_UPLOAD_PATHNAME),
  fileName: z.string().trim().min(1).max(1024),
  title: z.string().max(1024).optional(),
  documentType: z.string().max(100).optional(),
});

/**
 * Finalize a direct-to-Blob upload: claim the blob only through the cleanup intent its token was
 * issued under for this owner's target, read it back within the direct-upload limit, and run the
 * multipart path's validation. Failures leave the blob to the outbox, which deletes it once the
 * intent becomes due.
 */
export async function prepareDirectUpload(
  req: Request,
  input: { userId: string; target: DirectUploadTarget },
): Promise<PreparedUpload | UploadValidationError> {
  const signal = uploadSignal(req);
  const body = await readBoundedBody(
    req,
    MAX_FINALIZE_BODY,
    signal,
    "Invalid upload request",
  );
  if (!body.ok) return body;
  let parsed: z.infer<typeof finalizeBodySchema>;
  try {
    const result = finalizeBodySchema.safeParse(JSON.parse(await body.body.text()));
    if (!result.success)
      return { ok: false, status: 400, error: "Invalid upload request" };
    parsed = result.data;
  } catch {
    return { ok: false, status: 400, error: "Invalid upload request" };
  }

  const missing: UploadValidationError = {
    ok: false,
    status: 404,
    error: "The uploaded file was not found. Upload it again.",
  };
  const storageIntentId = await findDirectUploadIntent({
    userId: input.userId,
    pathname: parsed.pathname,
    target: input.target,
  });
  if (!storageIntentId) return missing;

  let blob: Awaited<ReturnType<typeof readUploadedBlob>>;
  try {
    blob = await readUploadedBlob(
      parsed.pathname,
      MAX_DIRECT_UPLOAD_FILE_SIZE,
      signal,
    );
  } catch (error: unknown) {
    if (!signal.aborted) console.error("Uploaded blob read failed:", error);
    return {
      ok: false,
      status: 503,
      error: signal.aborted
        ? "Upload timed out or was canceled."
        : "The uploaded file could not be read. Please try again.",
    };
  }
  if (!blob.ok) {
    return blob.reason === "missing"
      ? missing
      : {
          ok: false,
          status: 413,
          error: `File too large. Maximum size is ${MAX_DIRECT_UPLOAD_FILE_SIZE_MB} MB.`,
        };
  }

  const validated = validateUploadedFile({
    buffer: blob.buffer,
    fileName: parsed.fileName,
    declaredMimeType: blob.contentType,
    maxBytes: MAX_DIRECT_UPLOAD_FILE_SIZE,
    maxMb: MAX_DIRECT_UPLOAD_FILE_SIZE_MB,
  });
  if (!validated.ok) return validated;
  const fields: Record<string, string> = {};
  if (parsed.title !== undefined) fields.title = parsed.title;
  if (parsed.documentType !== undefined) fields.documentType = parsed.documentType;
  return {
    ok: true,
    signal,
    fileName: parsed.fileName,
    buffer: blob.buffer,
    mimeType: validated.mimeType,
    fields,
    stored: {
      storageKey: blob.url,
      bucket: getStorageBucketName(),
      storageIntentId,
    },
  };
}

// Persist under an opaque, collision-resistant path. The object key deliberately contains no
// owner ID, domain entity ID, or original filename because Blob URLs may be logged or shared.
export async function storeUploadedFile(input: {
  signal?: AbortSignal;
  buffer: Buffer;
  mimeType: string;
}): Promise<StoredUpload> {
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
