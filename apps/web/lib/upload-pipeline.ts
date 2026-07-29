import { randomUUID } from "node:crypto";
import {
  ExtractionLimitError,
  ExtractionUnavailableError,
  processFile,
  validateFileSignature,
  validateMimeType,
  type ExtractionMethod,
} from "@/lib/text-extraction";
import { getStorageBucketName, uploadObject } from "@/lib/object-storage";
import { getErrorMessage } from "@/lib/utils";
import {
  MAX_UPLOAD_FILE_SIZE,
  MAX_UPLOAD_FILE_SIZE_MB,
} from "@/lib/upload-constants";

const MAX_MULTIPART_OVERHEAD = 1024 * 1024;
const MAX_EXTRACTED_TEXT_LENGTH = 2_000_000;
const LOW_OCR_CONFIDENCE = 60;

// Shared file-upload pipeline used by both the contract-upload and project-context routes,
// so size/MIME validation, the single buffer conversion, and text extraction live in one place.

export type UploadValidationError = {
  ok: false;
  status: number;
  error: string;
};

export type PreparedUpload = {
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

function getExtractionWarning(input: {
  method: ExtractionMethod | null;
  confidence: number | null;
}): string | null {
  if (input.method === "pdf_scanned") {
    return "This PDF appears to be scanned and may have an incomplete text layer. Verify the extracted text before relying on the analysis.";
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
): Promise<PreparedUpload | UploadValidationError> {
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
  try {
    formData = await req.formData();
  } catch {
    return { ok: false, status: 400, error: "Invalid multipart upload" };
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
    const extracted = await processFile(buffer, mimeType, file.name);
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
    extractionWarning = getExtractionWarning({ method, confidence });
  } catch (error: unknown) {
    if (error instanceof ExtractionLimitError) {
      return { ok: false, status: 422, error: error.message };
    }
    if (error instanceof ExtractionUnavailableError) {
      return { ok: false, status: 503, error: error.message };
    }
    extractionError = getErrorMessage(error, "Text extraction failed");
  }

  return {
    ok: true,
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
// Clerk ID, domain entity ID, or original filename because Blob URLs may be logged or shared.
export async function storeUploadedFile(input: {
  buffer: Buffer;
  mimeType: string;
}): Promise<{ storageKey: string; bucket: string }> {
  const objectKey = `uploads/${randomUUID()}`;
  const bucket = getStorageBucketName();
  const storageKey = await uploadObject(
    objectKey,
    input.buffer,
    input.mimeType,
  );
  return { storageKey, bucket };
}
