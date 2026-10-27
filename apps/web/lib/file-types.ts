// Upload file types: which MIME types the parsers accept, how a declared type and file name resolve
// to one of them, and the cheap signature check that runs before any parser sees the bytes. Kept
// free of parser imports so upload routes can validate a file without bundling the parsers, which
// run in the parse-only function (app/api/internal/parse).

export const DOC_MIME_TYPE = "application/msword";
export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const TEXT_MIME_TYPE = "text/plain";
export const PDF_MIME_TYPE = "application/pdf";
const FILE_SIGNATURE_ERROR =
  "File contents do not match the selected file type";

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

/**
 * Every content type validateMimeType can accept as declared, for upload paths that must name
 * them up front (direct-to-Blob client tokens). Generic types still need a known file extension.
 */
export const DECLARABLE_UPLOAD_MIME_TYPES: readonly string[] = [
  ...new Set([
    ...ALLOWED_MIME_TYPES,
    ...DOC_MIME_TYPE_ALIASES,
    ...PDF_MIME_TYPE_ALIASES,
    ...DOCX_MIME_TYPE_ALIASES,
    "image/jpg",
    "image/pjpeg",
    "image/x-jpeg",
    "image/x-png",
    ...[...GENERIC_MIME_TYPES].filter(Boolean),
  ]),
];

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

export function hasPrefix(buffer: Buffer, signature: readonly number[]): boolean {
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

  // Callers pass the canonical type validateMimeType already resolved (processFile does exactly
  // that), so re-running the filename-aware resolution here would apply a *different* rule set --
  // this call has no fileName to cross-check against. Canonicalize only what was handed in.
  const supportedMimeType = canonicalizeSupportedMimeType(
    normalizeMimeType(mimeType),
  );
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
