import type { createWorker } from 'tesseract.js';
import type WordExtractor from 'word-extractor';
import { getErrorMessage } from '@/lib/utils';

const MIN_TEXT_DENSITY = 50; // Minimum characters per page for non-scanned PDF
const DOC_MIME_TYPE = 'application/msword';
const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TEXT_MIME_TYPE = 'text/plain';
const PDF_MIME_TYPE = 'application/pdf';

// The three extractor libraries (unpdf, tesseract.js, word-extractor) are heavy, so each is
// imported lazily inside the extractor that needs it — a PDF upload no longer pulls in the OCR
// wasm or the Word parser, and validate-only callers load none of them.

// Reuse a single Tesseract worker across requests so we don't re-spin a worker and reload the
// English language model on every image upload (the dominant cost in tesseract.js). On failure
// the cached promise is cleared so the next call can retry.
let ocrWorkerPromise: Promise<Awaited<ReturnType<typeof createWorker>>> | null = null;

function getOcrWorker(): Promise<Awaited<ReturnType<typeof createWorker>>> {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      return createWorker('eng');
    })().catch((error) => {
      ocrWorkerPromise = null;
      throw error;
    });
  }
  return ocrWorkerPromise;
}

// Lazily construct and cache a single WordExtractor instance on first .doc/.docx use.
let wordExtractorPromise: Promise<WordExtractor> | null = null;

function getWordExtractor(): Promise<WordExtractor> {
  if (!wordExtractorPromise) {
    wordExtractorPromise = import('word-extractor')
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
  method: 'pdf_parse' | 'pdf_scanned' | 'tesseract_ocr' | 'word_parse' | 'plain_text';
  confidence?: number;
}

export type ExtractionMethod = ExtractionResult['method'];

const ALLOWED_MIME_TYPES = [
  PDF_MIME_TYPE,
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/tiff',
  TEXT_MIME_TYPE,
  DOC_MIME_TYPE,
  DOCX_MIME_TYPE,
];

const DOC_MIME_TYPE_ALIASES = new Set<string>([
  DOC_MIME_TYPE,
  'application/doc',
  'application/vnd.msword',
  'application/vnd.ms-word',
]);

const DOCX_MIME_TYPE_ALIASES = new Set<string>([
  DOCX_MIME_TYPE,
  'application/vnd.ms-word.document.12',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
]);

const MIME_TYPES_BY_EXTENSION = new Map<string, string>([
  ['pdf', PDF_MIME_TYPE],
  ['txt', TEXT_MIME_TYPE],
  ['doc', DOC_MIME_TYPE],
  ['docx', DOCX_MIME_TYPE],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'],
]);

function normalizeMimeType(input: string): string {
  return input.toLowerCase().split(';')[0]?.trim() || '';
}

function inferMimeTypeFromFileName(fileName?: string): string | null {
  if (!fileName) return null;
  const normalizedFileName = fileName.trim().toLowerCase();
  const extension = normalizedFileName.split('.').pop();
  if (!extension) return null;
  return MIME_TYPES_BY_EXTENSION.get(extension) ?? null;
}

function getSupportedMimeType(mimeType: string, fileName?: string): string | null {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const inferredMimeType = inferMimeTypeFromFileName(fileName);

  if (DOC_MIME_TYPE_ALIASES.has(normalizedMimeType)) {
    return DOC_MIME_TYPE;
  }
  if (DOCX_MIME_TYPE_ALIASES.has(normalizedMimeType)) {
    return DOCX_MIME_TYPE;
  }
  if (normalizedMimeType === 'image/jpg' || normalizedMimeType === 'image/pjpeg') {
    return 'image/jpeg';
  }
  if (ALLOWED_MIME_TYPES.includes(normalizedMimeType)) {
    return normalizedMimeType;
  }

  // Unknown or empty declared MIME type: fall back to extension-based inference.
  return inferredMimeType;
}

/**
 * Validates that the mime type is supported for text extraction.
 * @throws Error if mime type is not supported
 */
export function validateMimeType(mimeType: string, fileName?: string): string {
  const supportedMimeType = getSupportedMimeType(mimeType, fileName);
  if (!supportedMimeType) {
    throw new Error(
      `File type ${mimeType || '(empty)'} is not supported. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`
    );
  }
  return supportedMimeType;
}

/**
 * Extract text from a PDF buffer using unpdf.
 * If the PDF appears to be scanned (low text density), returns a fallback message.
 */
export async function extractTextFromPdf(buffer: Buffer): Promise<ExtractionResult> {
  try {
    const { extractText } = await import('unpdf');
    // A Node Buffer already is a Uint8Array, so pass it straight to unpdf (avoids a full-size copy).
    const { text, totalPages } = await extractText(buffer, { mergePages: true });
    const extractedText = (text as string)?.trim() || '';

    // Check if it's a scanned PDF (low text density)
    const pageCount = totalPages || 1;
    const avgCharsPerPage = extractedText.length / pageCount;

    if (avgCharsPerPage < MIN_TEXT_DENSITY && extractedText.length < 500) {
      // Scanned PDF with no usable text layer. Return the (possibly empty) extracted text so the
      // caller's "no text extracted" handling applies, rather than a placeholder that would be
      // saved as if it were real contract content. (OCR of rasterized PDF pages is not implemented.)
      return {
        text: extractedText,
        method: 'pdf_scanned',
        confidence: 0,
      };
    }

    return {
      text: extractedText,
      method: 'pdf_parse',
      confidence: 100,
    };
  } catch (error: unknown) {
    throw new Error(`Failed to parse PDF: ${getErrorMessage(error)}`);
  }
}

/**
 * Extract text from an image buffer using Tesseract.js OCR.
 */
export async function extractTextFromImage(buffer: Buffer): Promise<ExtractionResult> {
  try {
    const worker = await getOcrWorker();
    const result = await worker.recognize(buffer);

    return {
      text: result.data.text.trim(),
      method: 'tesseract_ocr',
      confidence: result.data.confidence,
    };
  } catch (error: unknown) {
    throw new Error(`Failed to OCR image: ${getErrorMessage(error)}`);
  }
}

/**
 * Extract text from a plain text file.
 */
export async function extractTextFromPlainText(buffer: Buffer): Promise<ExtractionResult> {
  return {
    text: buffer.toString('utf-8').trim(),
    method: 'plain_text',
    confidence: 100,
  };
}

/**
 * Extract text from Word documents (.doc and .docx). word-extractor auto-detects the container,
 * so a single `word_parse` method label is used for both rather than a guessed doc/docx label.
 */
export async function extractTextFromWord(buffer: Buffer): Promise<ExtractionResult> {
  try {
    const wordExtractor = await getWordExtractor();
    const extracted = await wordExtractor.extract(buffer);
    const text = extracted.getBody().trim();

    return {
      text,
      method: 'word_parse',
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
  fileName?: string
): Promise<ExtractionResult> {
  const supportedMimeType = validateMimeType(mimeType, fileName);

  if (supportedMimeType === PDF_MIME_TYPE) {
    return extractTextFromPdf(buffer);
  }

  if (supportedMimeType.startsWith('image/')) {
    return extractTextFromImage(buffer);
  }

  if (supportedMimeType === TEXT_MIME_TYPE) {
    return extractTextFromPlainText(buffer);
  }

  if (supportedMimeType === DOC_MIME_TYPE || supportedMimeType === DOCX_MIME_TYPE) {
    return extractTextFromWord(buffer);
  }

  // This shouldn't happen due to validateMimeType, but just in case
  throw new Error(`Unsupported file type: ${supportedMimeType}`);
}
