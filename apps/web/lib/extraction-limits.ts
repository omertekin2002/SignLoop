import { imageSize } from "image-size";
import { constants as zlibConstants, createInflateRaw } from "node:zlib";
import { fromBuffer } from "yauzl";

export const MAX_EXTRACTED_TEXT_LENGTH = 2_000_000;
const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_DOCX_EXPANDED_BYTES = 16 * 1024 * 1024;
const MAX_PDF_INFLATED_BYTES = 64 * 1024 * 1024;
const PDF_STREAM_KEYWORD = Buffer.from("stream");
// pdf.js reads a back-reference before the start of a Flate stream as zero bytes, where zlib
// would stop with "invalid distance too far back". A zeroed preset window matches pdf.js.
const PDF_FLATE_WINDOW = Buffer.alloc(32 * 1024);

export class ExtractionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionLimitError";
  }
}

export function validateImageDimensions(buffer: Buffer) {
  const dimensions = imageSize(buffer);
  if (
    !dimensions.width ||
    !dimensions.height ||
    dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
  ) {
    throw new ExtractionLimitError(
      "Image is too large to decode. Maximum is 25 megapixels.",
    );
  }
}

/** Inspect the ZIP directory without inflating entries. The Word parser also validates actual entry sizes. */
export async function validateDocxExpansion(buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) =>
    fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("Invalid DOCX archive"));
        return;
      }
      let expanded = 0;
      let entries = 0;
      zip.on("error", (error) => {
        zip.close();
        reject(error);
      });
      zip.on("entry", (entry) => {
        expanded += entry.uncompressedSize;
        if (
          ++entries > 2_000 ||
          !Number.isSafeInteger(expanded) ||
          expanded > MAX_DOCX_EXPANDED_BYTES
        ) {
          zip.close();
          reject(
            new ExtractionLimitError(
              "DOCX expands beyond the 16 MB or 2,000-entry processing limit.",
            ),
          );
          return;
        }
        zip.readEntry();
      });
      zip.on("end", () => {
        zip.close();
        resolve();
      });
      zip.readEntry();
    }),
  );
}

/** Same header checks as pdf.js's FlateStream: deflate method, valid FCHECK, no preset dictionary. */
function hasFlateHeader(buffer: Buffer, offset: number): boolean {
  const cmf = buffer[offset];
  const flg = buffer[offset + 1];
  return (
    cmf !== undefined &&
    flg !== undefined &&
    (cmf & 0x0f) === 8 &&
    ((cmf << 8) + flg) % 31 === 0 &&
    (flg & 0x20) === 0
  );
}

/**
 * Yield the deflate data of every candidate Flate stream. A stream is recognised by its keyword
 * and a zlib header rather than by its dictionary, so an indirect /Filter or /Length does not hide
 * it. Data starts after the first line break that follows the keyword, as in pdf.js.
 */
function* pdfFlateStreams(buffer: Buffer): Generator<Buffer> {
  let nextLf = -1;
  let nextCr = -1;
  let previousDataStart = -1;
  for (
    let keyword = buffer.indexOf(PDF_STREAM_KEYWORD);
    keyword !== -1;
    keyword = buffer.indexOf(PDF_STREAM_KEYWORD, keyword + 1)
  ) {
    if (buffer.toString("latin1", keyword - 3, keyword) === "end") continue;
    const afterKeyword = keyword + PDF_STREAM_KEYWORD.length;
    // Keywords only move forward, so a cached line break that is still ahead can be reused.
    if (nextLf < afterKeyword) {
      nextLf = buffer.indexOf(0x0a, afterKeyword);
      if (nextLf === -1) nextLf = buffer.length;
    }
    if (nextCr < afterKeyword) {
      nextCr = buffer.indexOf(0x0d, afterKeyword);
      if (nextCr === -1) nextCr = buffer.length;
    }
    const lineBreak = Math.min(nextLf, nextCr);
    if (lineBreak >= buffer.length) return;
    const dataStart =
      lineBreak +
      (lineBreak === nextCr && buffer[lineBreak + 1] === 0x0a ? 2 : 1);
    // Several keywords on one line share a data start; inflate it once.
    if (dataStart === previousDataStart) continue;
    previousDataStart = dataStart;
    if (hasFlateHeader(buffer, dataStart)) {
      yield buffer.subarray(dataStart + 2);
    }
  }
}

/**
 * Count the bytes a raw deflate stream inflates to, stopping once the count passes `limit`. Output
 * is discarded as it arrives. A stream that turns out to be corrupt resolves with what it produced
 * before the error, since pdf.js keeps that output too.
 */
function inflatedSize(deflateData: Buffer, limit: number): Promise<number> {
  return new Promise((resolve) => {
    let size = 0;
    const inflate = createInflateRaw({
      chunkSize: 64 * 1024,
      dictionary: PDF_FLATE_WINDOW,
      finishFlush: zlibConstants.Z_SYNC_FLUSH,
    });
    inflate.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) inflate.destroy();
    });
    inflate.on("error", () => resolve(size));
    inflate.on("close", () => resolve(size));
    inflate.end(deflateData);
  });
}

/**
 * Best-effort budget on Flate output before pdf.js parses the file. pdf.js holds a whole decoded
 * stream in memory, so a few MB of deflate data could expand to gigabytes within one page. Streams
 * that zlib cannot inflate are skipped rather than rejected. Not covered: LZW and RunLength
 * streams, filter chains that decode to Flate (such as ASCII85 then Flate), encrypted streams,
 * and deflate quirks that pdf.js tolerates but zlib rejects.
 */
export async function validatePdfExpansion(
  buffer: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  let remaining = MAX_PDF_INFLATED_BYTES;
  for (const deflateData of pdfFlateStreams(buffer)) {
    signal?.throwIfAborted();
    remaining -= await inflatedSize(deflateData, remaining);
    if (remaining < 0) {
      throw new ExtractionLimitError(
        "PDF expands beyond the 64 MB processing limit.",
      );
    }
  }
}
