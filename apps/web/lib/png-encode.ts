import { zlibSync } from "fflate";

/** Raw 8-bit pixels, row-major and unpadded: gray (1), RGB (3) or RGBA (4) channels per pixel. */
export type RawRaster = {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const COLOR_TYPES = { 1: 0, 3: 2, 4: 6 } as const;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/**
 * Encode a raw raster as an 8-bit PNG (no interlacing, filter type None on every row) so the OCR
 * engine, which only reads image files, can take pixels decoded from a PDF. Fast compression is
 * enough: the PNG never leaves the process.
 */
export function encodePng(raster: RawRaster): Uint8Array {
  const { data, width, height, channels } = raster;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !(channels in COLOR_TYPES)
  ) {
    throw new Error("Invalid raster dimensions or channel count");
  }
  const stride = width * channels;
  if (data.length !== stride * height) {
    throw new Error("Raster data does not match its dimensions");
  }

  const scanlines = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    // The leading byte of each scanline is its filter type, 0 (None), already zero.
    scanlines.set(
      data.subarray(row * stride, (row + 1) * stride),
      row * (stride + 1) + 1,
    );
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = COLOR_TYPES[channels];
  // Compression, filter and interlace methods are all 0.

  const parts = [
    Uint8Array.from(PNG_SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", zlibSync(scanlines, { level: 1 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
