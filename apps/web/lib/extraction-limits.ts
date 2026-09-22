import { imageSize } from "image-size";
import { fromBuffer } from "yauzl";

export const MAX_EXTRACTED_TEXT_LENGTH = 2_000_000;
const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_DOCX_EXPANDED_BYTES = 16 * 1024 * 1024;

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
