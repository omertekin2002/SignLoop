// @ts-expect-error - pdf-parse types don't support ESM imports properly
import pdfParse from 'pdf-parse';
import Tesseract from 'tesseract.js';

const MIN_TEXT_DENSITY = 50; // Minimum characters per page for non-scanned PDF

export interface ExtractionResult {
    text: string;
    method: 'pdf_parse' | 'pdf_ocr_fallback' | 'tesseract_ocr';
    confidence?: number;
}

const ALLOWED_MIME_TYPES = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/tiff',
    'text/plain',
];

/**
 * Validates that the mime type is supported for text extraction.
 * @throws Error if mime type is not supported
 */
export function validateMimeType(mimeType: string): void {
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
        throw new Error(
            `File type ${mimeType} is not supported. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`
        );
    }
}

/**
 * Extract text from a PDF buffer using pdf-parse.
 * If the PDF appears to be scanned (low text density), returns a fallback message.
 */
export async function extractTextFromPdf(buffer: Buffer): Promise<ExtractionResult> {
    try {
        const pdfData = await pdfParse(buffer);
        const text = pdfData.text?.trim() || '';

        // Check if it's a scanned PDF (low text density)
        const pageCount = pdfData.numpages || 1;
        const avgCharsPerPage = text.length / pageCount;

        if (avgCharsPerPage < MIN_TEXT_DENSITY && text.length < 500) {
            // Likely scanned, OCR would be needed for better extraction
            return {
                text: text || '[OCR required - scanned PDF detected]',
                method: 'pdf_ocr_fallback',
                confidence: 0,
            };
        }

        return {
            text,
            method: 'pdf_parse',
            confidence: 100,
        };
    } catch (error: any) {
        throw new Error(`Failed to parse PDF: ${error.message}`);
    }
}

/**
 * Extract text from an image buffer using Tesseract.js OCR.
 */
export async function extractTextFromImage(buffer: Buffer): Promise<ExtractionResult> {
    try {
        const result = await Tesseract.recognize(buffer, 'eng', {
            logger: () => { }, // Suppress logs
        });

        return {
            text: result.data.text.trim(),
            method: 'tesseract_ocr',
            confidence: result.data.confidence,
        };
    } catch (error: any) {
        throw new Error(`Failed to OCR image: ${error.message}`);
    }
}

/**
 * Extract text from a plain text file.
 */
export async function extractTextFromPlainText(buffer: Buffer): Promise<ExtractionResult> {
    return {
        text: buffer.toString('utf-8').trim(),
        method: 'pdf_parse', // Using pdf_parse as a generic "direct extraction" method
        confidence: 100,
    };
}

/**
 * Process a file buffer and extract text based on its MIME type.
 * @param buffer The file content as a Buffer
 * @param mimeType The MIME type of the file
 * @returns ExtractionResult with extracted text and metadata
 */
export async function processFile(buffer: Buffer, mimeType: string): Promise<ExtractionResult> {
    validateMimeType(mimeType);

    if (mimeType === 'application/pdf') {
        return extractTextFromPdf(buffer);
    }

    if (mimeType.startsWith('image/')) {
        return extractTextFromImage(buffer);
    }

    if (mimeType === 'text/plain') {
        return extractTextFromPlainText(buffer);
    }

    // This shouldn't happen due to validateMimeType, but just in case
    throw new Error(`Unsupported file type: ${mimeType}`);
}
