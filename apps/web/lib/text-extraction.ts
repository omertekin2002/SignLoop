import type { createWorker } from "tesseract.js";
import type WordExtractor from "word-extractor";
import { getErrorMessage } from "@/lib/utils";

const MIN_TEXT_DENSITY = 50; // Minimum characters per page for non-scanned PDF
const MAX_PDF_PAGES = 500;
const DOC_MIME_TYPE = "application/msword";
const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TEXT_MIME_TYPE = "text/plain";
const PDF_MIME_TYPE = "application/pdf";
const MAX_PENDING_OCR_JOBS = 2;
const OCR_WORKER_INIT_TIMEOUT_MS = 60_000;
const OCR_RECOGNITION_TIMEOUT_MS = 90_000;
const FILE_SIGNATURE_ERROR =
  "File contents do not match the selected file type";

// The three extractor libraries (unpdf, tesseract.js, word-extractor) are heavy, so each is
// imported lazily inside the extractor that needs it — a PDF upload no longer pulls in the OCR
// wasm or the Word parser, and validate-only callers load none of them.

// Reuse a single Tesseract worker across requests so we don't re-spin a worker and reload the
// English language model on every image upload (the dominant cost in tesseract.js). On failure
// the cached promise is cleared so the next call can retry.
let ocrWorkerPromise: Promise<Awaited<ReturnType<typeof createWorker>>> | null =
  null;
let ocrQueue: Promise<void> = Promise.resolve();
let pendingOcrJobs = 0;

async function runSerializedOcr<T>(task: () => Promise<T>): Promise<T> {
  const previous = ocrQueue;
  let release!: () => void;
  ocrQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function getOcrWorker(): Promise<Awaited<ReturnType<typeof createWorker>>> {
  if (!ocrWorkerPromise) {
    const creationPromise = (async () => {
      const { createWorker } = await import("tesseract.js");
      return createWorker("eng");
    })();
    const cachedPromise = creationPromise.catch((error) => {
      // A timed-out initialization may already have been replaced by a new worker promise. Only
      // clear the cache if this failing promise is still the active one.
      if (ocrWorkerPromise === cachedPromise) {
        ocrWorkerPromise = null;
      }
      throw error;
    });
    ocrWorkerPromise = cachedPromise;
  }
  return ocrWorkerPromise;
}

// Lazily construct and cache a single WordExtractor instance on first .doc/.docx use.
let wordExtractorPromise: Promise<WordExtractor> | null = null;

function getWordExtractor(): Promise<WordExtractor> {
  if (!wordExtractorPromise) {
    wordExtractorPromise = import("word-extractor")
      .then((mod) => new mod.default())
      .catch((error) => {
        wordExtractorPromise = null;
        throw error;
      });
  }
  return wordExtractorPromise;
}

export interface ExtractionResult {
  text: string;
  method:
    "pdf_parse" | "pdf_scanned" | "tesseract_ocr" | "word_parse" | "plain_text";
  confidence?: number;
}

export type ExtractionMethod = ExtractionResult["method"];

export class ExtractionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionLimitError";
  }
}

export class ExtractionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionUnavailableError";
  }
}

const ALLOWED_MIME_TYPES = [
  PDF_MIME_TYPE,
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/tiff",
  TEXT_MIME_TYPE,
  DOC_MIME_TYPE,
  DOCX_MIME_TYPE,
];

const DOC_MIME_TYPE_ALIASES = new Set<string>([
  DOC_MIME_TYPE,
  "application/doc",
  "application/vnd.msword",
  "application/vnd.ms-word",
]);

const PDF_MIME_TYPE_ALIASES = new Set<string>([
  PDF_MIME_TYPE,
  "application/x-pdf",
  "application/acrobat",
  "application/vnd.pdf",
]);

const DOCX_MIME_TYPE_ALIASES = new Set<string>([
  DOCX_MIME_TYPE,
  "application/vnd.ms-word.document.12",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
]);

const MIME_TYPES_BY_EXTENSION = new Map<string, string>([
  ["pdf", PDF_MIME_TYPE],
  ["txt", TEXT_MIME_TYPE],
  ["doc", DOC_MIME_TYPE],
  ["docx", DOCX_MIME_TYPE],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["tif", "image/tiff"],
  ["tiff", "image/tiff"],
]);

const GENERIC_MIME_TYPES = new Set<string>([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/zip",
  "application/x-zip-compressed",
]);

function normalizeMimeType(input: string): string {
  return input.toLowerCase().split(";")[0]?.trim() || "";
}

function inferMimeTypeFromFileName(fileName?: string): string | null {
  if (!fileName) return null;
  const normalizedFileName = fileName.trim().toLowerCase();
  const extension = normalizedFileName.split(".").pop();
  if (!extension) return null;
  return MIME_TYPES_BY_EXTENSION.get(extension) ?? null;
}

function canonicalizeSupportedMimeType(
  normalizedMimeType: string,
): string | null {
  if (PDF_MIME_TYPE_ALIASES.has(normalizedMimeType)) {
    return PDF_MIME_TYPE;
  }
  if (DOC_MIME_TYPE_ALIASES.has(normalizedMimeType)) {
    return DOC_MIME_TYPE;
  }
  if (DOCX_MIME_TYPE_ALIASES.has(normalizedMimeType)) {
    return DOCX_MIME_TYPE;
  }
  if (
    normalizedMimeType === "image/jpg" ||
    normalizedMimeType === "image/pjpeg" ||
    normalizedMimeType === "image/x-jpeg"
  ) {
    return "image/jpeg";
  }
  if (normalizedMimeType === "image/x-png") {
    return "image/png";
  }
  if (ALLOWED_MIME_TYPES.includes(normalizedMimeType)) {
    return normalizedMimeType;
  }

  return null;
}

function getSupportedMimeType(
  mimeType: string,
  fileName?: string,
): string | null {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const declaredMimeType = canonicalizeSupportedMimeType(normalizedMimeType);
  const inferredMimeType = inferMimeTypeFromFileName(fileName);

  if (
    declaredMimeType &&
    inferredMimeType &&
    declaredMimeType !== inferredMimeType
  ) {
    const declaredIsWord =
      declaredMimeType === DOC_MIME_TYPE || declaredMimeType === DOCX_MIME_TYPE;
    const inferredIsWord =
      inferredMimeType === DOC_MIME_TYPE || inferredMimeType === DOCX_MIME_TYPE;
    if (declaredIsWord && inferredIsWord) {
      return inferredMimeType;
    }

    throw new Error(
      `Declared file type ${mimeType} does not match the filename extension`,
    );
  }

  if (declaredMimeType) {
    return declaredMimeType;
  }

  // Browsers commonly use a generic binary/ZIP MIME type for Office documents. Only those
  // generic declarations may fall back to extension inference; an unrelated specific MIME type
  // must not be disguised by renaming the file.
  return GENERIC_MIME_TYPES.has(normalizedMimeType) ? inferredMimeType : null;
}

function hasPrefix(buffer: Buffer, signature: readonly number[]): boolean {
  return signature.every((byte, index) => buffer[index] === byte);
}

function isZipContainer(buffer: Buffer): boolean {
  return hasPrefix(buffer, [0x50, 0x4b, 0x03, 0x04]);
}

/**
 * Verify inexpensive, well-known file signatures before handing untrusted bytes to a parser.
 * Plain text has no magic number, so reject common binary signatures and NUL-containing data.
 *
 * @throws Error when the content cannot plausibly be the normalized MIME type.
 */
export function validateFileSignature(buffer: Buffer, mimeType: string): void {
  if (buffer.length === 0) {
    throw new Error("The uploaded file is empty");
  }

  const supportedMimeType = validateMimeType(mimeType);
  let matches = false;

  switch (supportedMimeType) {
    case PDF_MIME_TYPE: {
      const headerOffset = buffer
        .subarray(0, 1024)
        .indexOf(Buffer.from("%PDF-"));
      matches = headerOffset >= 0;
      break;
    }
    case "image/jpeg":
      matches = hasPrefix(buffer, [0xff, 0xd8, 0xff]);
      break;
    case "image/png":
      matches = hasPrefix(
        buffer,
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      );
      break;
    case "image/gif": {
      const header = buffer.subarray(0, 6).toString("ascii");
      matches = header === "GIF87a" || header === "GIF89a";
      break;
    }
    case "image/webp":
      matches =
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP";
      break;
    case "image/tiff":
      matches =
        hasPrefix(buffer, [0x49, 0x49, 0x2a, 0x00]) ||
        hasPrefix(buffer, [0x4d, 0x4d, 0x00, 0x2a]);
      break;
    case DOC_MIME_TYPE:
      matches = hasPrefix(
        buffer,
        [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
      );
      break;
    case DOCX_MIME_TYPE:
      matches =
        isZipContainer(buffer) &&
        buffer.includes(Buffer.from("[Content_Types].xml")) &&
        buffer.includes(Buffer.from("word/"));
      break;
    case TEXT_MIME_TYPE: {
      const sample = buffer.subarray(0, 8192);
      const hasUtf16Bom =
        hasPrefix(sample, [0xff, 0xfe]) || hasPrefix(sample, [0xfe, 0xff]);
      const hasKnownBinaryHeader =
        hasPrefix(sample, [0x25, 0x50, 0x44, 0x46, 0x2d]) ||
        isZipContainer(sample) ||
        hasPrefix(sample, [0xd0, 0xcf, 0x11, 0xe0]) ||
        hasPrefix(sample, [0xff, 0xd8, 0xff]) ||
        hasPrefix(sample, [0x89, 0x50, 0x4e, 0x47]) ||
        ["GIF87a", "GIF89a"].includes(
          sample.subarray(0, 6).toString("ascii"),
        ) ||
        (sample.subarray(0, 4).toString("ascii") === "RIFF" &&
          sample.subarray(8, 12).toString("ascii") === "WEBP") ||
        hasPrefix(sample, [0x49, 0x49, 0x2a, 0x00]) ||
        hasPrefix(sample, [0x4d, 0x4d, 0x00, 0x2a]);
      matches = !hasKnownBinaryHeader && (hasUtf16Bom || !sample.includes(0));
      break;
    }
  }

  if (!matches) {
    throw new Error(FILE_SIGNATURE_ERROR);
  }
}

/**
 * Validates that the mime type is supported for text extraction.
 * @throws Error if mime type is not supported
 */
export function validateMimeType(mimeType: string, fileName?: string): string {
  const supportedMimeType = getSupportedMimeType(mimeType, fileName);
  if (!supportedMimeType) {
    throw new Error(
      `File type ${mimeType || "(empty)"} is not supported. Allowed types: ${ALLOWED_MIME_TYPES.join(", ")}`,
    );
  }
  return supportedMimeType;
}

/**
 * Extract text from a PDF buffer using unpdf.
 * If the PDF appears to be scanned (low text density), returns a fallback message.
 */
export async function extractTextFromPdf(
  buffer: Buffer,
): Promise<ExtractionResult> {
  let pdf: Awaited<
    ReturnType<(typeof import("unpdf"))["getDocumentProxy"]>
  > | null = null;
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    // PDF.js rejects Node Buffer instances and takes ownership of/detaches the supplied
    // ArrayBuffer. Make an owned copy so parsing cannot empty the original bytes before storage.
    pdf = await getDocumentProxy(new Uint8Array(buffer));
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new ExtractionLimitError(
        `PDF has too many pages. Maximum is ${MAX_PDF_PAGES.toLocaleString("en-US")} pages.`,
      );
    }

    const { text, totalPages } = await extractText(pdf, {
      mergePages: true,
    });
    const extractedText = (text as string)?.trim() || "";

    // Check if it's a scanned PDF (low text density)
    const pageCount = totalPages || 1;
    const avgCharsPerPage = extractedText.length / pageCount;

    if (avgCharsPerPage < MIN_TEXT_DENSITY && extractedText.length < 500) {
      // Scanned PDF with no usable text layer. Return the (possibly empty) extracted text so the
      // caller's "no text extracted" handling applies, rather than a placeholder that would be
      // saved as if it were real contract content. (OCR of rasterized PDF pages is not implemented.)
      return {
        text: extractedText,
        method: "pdf_scanned",
        confidence: 0,
      };
    }

    return {
      text: extractedText,
      method: "pdf_parse",
      confidence: 100,
    };
  } catch (error: unknown) {
    if (error instanceof ExtractionLimitError) {
      throw error;
    }
    throw new Error(`Failed to parse PDF: ${getErrorMessage(error)}`);
  } finally {
    if (pdf) {
      try {
        await pdf.destroy();
      } catch (destroyError: unknown) {
        console.warn("Failed to release PDF parser resources:", destroyError);
      }
    }
  }
}

/**
 * Extract text from an image buffer using Tesseract.js OCR.
 */
export async function extractTextFromImage(
  buffer: Buffer,
): Promise<ExtractionResult> {
  // One shared worker must be serialized, but an unbounded promise chain would retain every
  // waiting upload buffer. Allow one active job plus one waiter and ask excess callers to retry.
  if (pendingOcrJobs >= MAX_PENDING_OCR_JOBS) {
    throw new ExtractionUnavailableError(
      "Image text extraction is busy. Please try again shortly.",
    );
  }

  pendingOcrJobs += 1;
  try {
    return await runSerializedOcr(async () => {
      let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
      try {
        const workerPromise = getOcrWorker();
        let workerInitTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
          worker = await Promise.race([
            workerPromise,
            new Promise<never>((_resolve, reject) => {
              workerInitTimeout = setTimeout(
                () =>
                  reject(
                    new ExtractionUnavailableError(
                      "Image text extraction could not start. Please try again shortly.",
                    ),
                  ),
                OCR_WORKER_INIT_TIMEOUT_MS,
              );
            }),
          ]);
        } catch (error: unknown) {
          if (error instanceof ExtractionUnavailableError) {
            // A late worker must not remain orphaned or become the cached worker after this request
            // has already failed. Terminate it asynchronously when initialization eventually ends.
            ocrWorkerPromise = null;
            void workerPromise
              .then((lateWorker) => lateWorker.terminate())
              .catch((lateWorkerError: unknown) => {
                console.warn(
                  "Failed to clean up a late OCR worker:",
                  lateWorkerError,
                );
              });
          }
          throw error;
        } finally {
          if (workerInitTimeout) clearTimeout(workerInitTimeout);
        }

        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new ExtractionUnavailableError(
                  "Image text extraction timed out. Try a smaller image.",
                ),
              ),
            OCR_RECOGNITION_TIMEOUT_MS,
          );
        });

        let result: Awaited<ReturnType<typeof worker.recognize>>;
        try {
          result = await Promise.race([
            worker.recognize(buffer),
            timeoutPromise,
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }

        return {
          text: result.data.text.trim(),
          method: "tesseract_ocr",
          confidence: result.data.confidence,
        };
      } catch (error: unknown) {
        // Recognition failures can leave Tesseract's cached worker in an unusable state. Clear it
        // and terminate the failed instance so the next request gets a clean worker.
        ocrWorkerPromise = null;
        if (worker) {
          try {
            await worker.terminate();
          } catch (terminationError: unknown) {
            console.warn(
              "Failed to terminate OCR worker after recognition error:",
              terminationError,
            );
          }
        }
        if (error instanceof ExtractionUnavailableError) {
          throw error;
        }
        throw new Error(`Failed to OCR image: ${getErrorMessage(error)}`);
      }
    });
  } finally {
    pendingOcrJobs -= 1;
  }
}

/**
 * Extract text from a plain text file.
 */
export async function extractTextFromPlainText(
  buffer: Buffer,
): Promise<ExtractionResult> {
  let text: string;
  if (hasPrefix(buffer, [0xff, 0xfe])) {
    text = buffer.subarray(2).toString("utf16le");
  } else if (hasPrefix(buffer, [0xfe, 0xff])) {
    const source = buffer.subarray(2);
    const swapped = Buffer.alloc(source.length);
    for (let index = 0; index + 1 < source.length; index += 2) {
      swapped[index] = source[index + 1]!;
      swapped[index + 1] = source[index]!;
    }
    text = swapped.toString("utf16le");
  } else {
    text = buffer.toString("utf-8");
  }

  return {
    text: text.replace(/^\uFEFF/, "").trim(),
    method: "plain_text",
    confidence: 100,
  };
}

/**
 * Extract text from Word documents (.doc and .docx). word-extractor auto-detects the container,
 * so a single `word_parse` method label is used for both rather than a guessed doc/docx label.
 */
export async function extractTextFromWord(
  buffer: Buffer,
): Promise<ExtractionResult> {
  try {
    const wordExtractor = await getWordExtractor();
    const extracted = await wordExtractor.extract(buffer);
    const text = extracted.getBody().trim();

    return {
      text,
      method: "word_parse",
      confidence: 100,
    };
  } catch (error: unknown) {
    throw new Error(`Failed to parse Word document: ${getErrorMessage(error)}`);
  }
}

/**
 * Process a file buffer and extract text based on its MIME type.
 * @param buffer The file content as a Buffer
 * @param mimeType The MIME type of the file
 * @returns ExtractionResult with extracted text and metadata
 */
export async function processFile(
  buffer: Buffer,
  mimeType: string,
  fileName?: string,
): Promise<ExtractionResult> {
  const supportedMimeType = validateMimeType(mimeType, fileName);
  validateFileSignature(buffer, supportedMimeType);

  if (supportedMimeType === PDF_MIME_TYPE) {
    return extractTextFromPdf(buffer);
  }

  if (supportedMimeType.startsWith("image/")) {
    return extractTextFromImage(buffer);
  }

  if (supportedMimeType === TEXT_MIME_TYPE) {
    return extractTextFromPlainText(buffer);
  }

  if (
    supportedMimeType === DOC_MIME_TYPE ||
    supportedMimeType === DOCX_MIME_TYPE
  ) {
    return extractTextFromWord(buffer);
  }

  // This shouldn't happen due to validateMimeType, but just in case
  throw new Error(`Unsupported file type: ${supportedMimeType}`);
}
