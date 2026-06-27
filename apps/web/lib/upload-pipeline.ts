import { processFile, validateMimeType, type ExtractionMethod } from "@/lib/text-extraction";
import { getStorageBucketName, uploadObject } from "@/lib/object-storage";
import { getErrorMessage } from "@/lib/utils";
import { MAX_UPLOAD_FILE_SIZE, MAX_UPLOAD_FILE_SIZE_MB } from "@/lib/upload-constants";

// Shared file-upload pipeline used by both the contract-upload and project-context routes,
// so size/MIME validation, the single buffer conversion, and text extraction live in one place.

export { MAX_UPLOAD_FILE_SIZE };

export type UploadValidationError = { ok: false; status: number; error: string };

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
};

// Parse + validate the multipart upload and extract its text. Does NOT persist anything, so the
// caller decides its own empty-text policy before storing (e.g. contracts reject empty text).
export async function prepareUpload(
  req: Request,
): Promise<PreparedUpload | UploadValidationError> {
  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, status: 400, error: "No file uploaded" };
  }

  if (file.size > MAX_UPLOAD_FILE_SIZE) {
    return { ok: false, status: 413, error: `File too large. Maximum size is ${MAX_UPLOAD_FILE_SIZE_MB} MB.` };
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

  let text = "";
  let method: ExtractionMethod | null = null;
  let confidence: number | null = null;
  let extractionError: string | null = null;
  try {
    const extracted = await processFile(buffer, mimeType, file.name);
    text = extracted.text;
    method = extracted.method;
    confidence = typeof extracted.confidence === "number" ? extracted.confidence : null;
  } catch (error: unknown) {
    extractionError = getErrorMessage(error, "Text extraction failed");
  }

  return { ok: true, formData, file, buffer, mimeType, text, method, confidence, extractionError };
}

// Persist the uploaded bytes under `<prefix>/<timestamp>-<safeName>` and return the stored key
// plus the active storage bucket label.
export async function storeUploadedFile(input: {
  buffer: Buffer;
  mimeType: string;
  storageKeyPrefix: string;
  fileName: string;
}): Promise<{ storageKey: string; bucket: string }> {
  const safeFileName = input.fileName.replace(/[^\w.-]/g, "_");
  const prefix = input.storageKeyPrefix.replace(/\/+$/, "");
  const objectKey = `${prefix}/${Date.now()}-${safeFileName}`;
  const bucket = getStorageBucketName();
  const storageKey = await uploadObject(objectKey, input.buffer, input.mimeType);
  return { storageKey, bucket };
}
