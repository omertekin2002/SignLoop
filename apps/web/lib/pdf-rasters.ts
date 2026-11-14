import { withAbort } from "@repo/chat-engine/bounded-response";
import type { RawRaster } from "@/lib/png-encode";

export type PdfDocumentProxy = Awaited<
  ReturnType<(typeof import("unpdf"))["getDocumentProxy"]>
>;

// PDF.js's decoded image kinds (ImageKind in pdf.js's shared util).
const GRAYSCALE_1BPP = 1;
const RGB_24BPP = 2;
const RGBA_32BPP = 3;

type DecodedImage = {
  width?: number;
  height?: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
};

/** Unpack PDF.js's 1-bit rows (padded to whole bytes, a set bit is white) to 8-bit gray. */
function unpackBlackAndWhite(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array | null {
  const rowBytes = Math.ceil(width / 8);
  if (data.length < rowBytes * height) return null;
  const gray = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const byte = data[row * rowBytes + (column >> 3)]!;
      gray[row * width + column] = byte & (0x80 >> (column & 7)) ? 255 : 0;
    }
  }
  return gray;
}

function toRaster(image: DecodedImage): RawRaster | null {
  const { width, height, kind, data } = image;
  if (!data || !width || !height) return null;
  if (kind === GRAYSCALE_1BPP) {
    const gray = unpackBlackAndWhite(data, width, height);
    return gray ? { data: gray, width, height, channels: 1 } : null;
  }
  const channels = kind === RGB_24BPP ? 3 : kind === RGBA_32BPP ? 4 : null;
  if (!channels || data.length !== width * height * channels) return null;
  return { data, width, height, channels };
}

/**
 * The largest raster painted on a PDF page, decoded to raw pixels, or null when the page paints
 * none that PDF.js can decode here (vector-only pages, stencil masks, or encodings such as JBIG2
 * or JPX that fail to decode in Node). Like unpdf's extractImages, it reads image XObjects from
 * the page's operator list; unlike it, it also accepts PDF.js's packed 1-bit images, the usual
 * form of black-and-white scans. `accept` sees each candidate's size before its pixels are
 * converted, so a raster too small or too large for OCR is never copied. The page's decoded
 * objects are released before this returns.
 */
export async function largestPageRaster(
  pdf: PdfDocumentProxy,
  pageNumber: number,
  accept: (size: { width: number; height: number }) => boolean,
  signal?: AbortSignal,
): Promise<RawRaster | null> {
  const { getResolvedPDFJS } = await import("unpdf");
  const { OPS } = await getResolvedPDFJS();
  const page = await pdf.getPage(pageNumber);
  try {
    const operators = await withAbort(page.getOperatorList(), signal);
    let largest: DecodedImage | null = null;
    for (let index = 0; index < operators.fnArray.length; index++) {
      if (operators.fnArray[index] !== OPS.paintImageXObject) continue;
      const key: unknown = operators.argsArray[index]?.[0];
      if (typeof key !== "string") continue;
      const objects = key.startsWith("g_") ? page.commonObjs : page.objs;
      const image = await withAbort(
        new Promise<DecodedImage | null>((resolve) =>
          objects.get(key, (decoded: unknown) =>
            resolve(decoded as DecodedImage | null),
          ),
        ),
        signal,
      );
      if (!image?.data || !image.width || !image.height) continue;
      if (
        !largest ||
        image.width * image.height > largest.width! * largest.height!
      ) {
        largest = image;
      }
    }
    if (
      !largest ||
      !accept({ width: largest.width!, height: largest.height! })
    ) {
      return null;
    }
    return toRaster(largest);
  } finally {
    page.cleanup();
  }
}
